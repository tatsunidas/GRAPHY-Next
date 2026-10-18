/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.fasterxml.jackson.databind.ObjectMapper;
import ij.ImagePlus;
import ij.measure.ResultsTable;
import io.github.tatsunidas.radiomics.main.RadiomicsJ;
import io.github.tatsunidas.radiomics.main.SettingParams;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Properties;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * ROI 特徴量表 — RadiomicsJ の一括抽出（{@code extractAll}）を ROI 全体に 1 回かけ、1 ROI = 1 行の表を返す。
 *
 * <p>数値の定義は RadiomicsJ に一本化する。設定は RadiomicsJ の設定キーをそのまま受け取り、Next の
 * テクスチャ設定（マップ用）とは混ぜない。だから同じ設定ファイルを RadiomicsJ の CLI・ImageJ に
 * 渡せば同じ値になる。入力の組み立て（シリーズ→画像、SEG マスクの整列、校正）はマップ・GLAM 解析と
 * 同じ {@link RadiomicsMapEngine#load} を使う。
 *
 * <p>RadiomicsJ の設定は static なので、抽出は {@link RadiomicsLock} の中で行い、終わったら既定へ戻す。
 * 抽出には進み具合も取り消しの口も無い。
 *
 * <p>結果は {@link MapCheckpointStore} に置き、同じ入力（画素・校正・設定・版）の再要求に返す。
 */
@Service
public class RoiFeatureService {

    private static final Logger log = LoggerFactory.getLogger(RoiFeatureService.class);

    /** 患者名・ID・生年月日を DICOM から書く族。常に切る（版と設定の記録は Next が付ける）。 */
    static final String OPERATIONAL_INFO_KEY = SettingParams.BOOL_enableOperationalInfo.name();
    static final String LABEL_KEY = SettingParams.INT_label.name();
    static final String FORCE_2D_KEY = SettingParams.BOOL_force2D.name();
    static final String GLAM_KEY = SettingParams.BOOL_enableGLAM.name();

    private static final Set<String> KNOWN_KEYS =
            Stream.of(SettingParams.values()).map(Enum::name).collect(Collectors.toUnmodifiableSet());

    /** 計算の段階。抽出の中の進み具合は取れない。 */
    public enum Phase { LOADING, EXTRACTING }

    /** 抽出そのもの（試験で呼び出しを数えるために差し替えられる）。 */
    @FunctionalInterface
    interface Extractor {
        ResultsTable extract(RadiomicsJ radiomics, ImagePlus image, ImagePlus mask, int label) throws Exception;
    }

    private final RadiomicsMapEngine engine;
    private final MapCheckpointStore cache;
    private final RadiomicsMode mode;
    private final ObjectMapper json;
    private final Extractor extractor;
    private final String graphyVersion;

    @Autowired
    public RoiFeatureService(RadiomicsMapEngine engine, MapCheckpointStore cache, RadiomicsMode mode,
                             ObjectMapper json, @Value("${graphy.version:dev}") String graphyVersion) {
        this(engine, cache, mode, json, (rj, img, mask, label) -> rj.extractAll(img, mask, label), graphyVersion);
    }

    RoiFeatureService(RadiomicsMapEngine engine, MapCheckpointStore cache, RadiomicsMode mode,
                      ObjectMapper json, Extractor extractor, String graphyVersion) {
        this.engine = engine;
        this.cache = cache;
        this.mode = mode;
        this.json = json;
        this.extractor = extractor;
        this.graphyVersion = graphyVersion;
    }

    /** 投入の前に通す検査（web モード・必須項目・設定キー）。通らなければ例外。 */
    void check(RoiFeatureRequest req) {
        mode.require("Radiomics 特徴量");
        if (req.studyInstanceUid() == null || req.studyInstanceUid().isBlank()
                || req.sourceSeriesUid() == null || req.sourceSeriesUid().isBlank()) {
            throw new IllegalArgumentException("studyInstanceUid / sourceSeriesUid は必須です");
        }
        if (req.maskSeriesUid() == null || req.maskSeriesUid().isBlank()) {
            // マスクが無いと RadiomicsJ は全面を ROI にする。画像の外形を測ることになるので断る。
            throw new IllegalArgumentException("Radiomics 特徴量には ROI マスクシリーズが必要です。");
        }
        effectiveSettings(req.settings(), labelOf(req.settings()));
    }

    /**
     * RadiomicsJ に渡す設定（上書きを済ませたもの）。キーは RadiomicsJ の名前だけ受け付ける —
     * 打ち間違いが黙って既定値になるのを防ぐ。
     */
    static Map<String, String> effectiveSettings(Map<String, String> requested, int label) {
        Map<String, String> out = new TreeMap<>();
        if (requested != null) {
            List<String> unknown = new ArrayList<>();
            for (Map.Entry<String, String> e : requested.entrySet()) {
                if (!KNOWN_KEYS.contains(e.getKey())) {
                    unknown.add(e.getKey());
                } else if (e.getValue() != null) {
                    out.put(e.getKey(), e.getValue().trim());
                }
            }
            if (!unknown.isEmpty()) {
                throw new IllegalArgumentException("RadiomicsJ の設定にないキーです: " + String.join(", ", unknown));
            }
        }
        if (isTrue(out.get(FORCE_2D_KEY))) {
            throw new IllegalArgumentException(
                    "スライスごとの 2D 抽出（BOOL_force2D）には未対応です。1 ROI = 1 行の 3D 抽出だけを出します。");
        }
        out.put(OPERATIONAL_INFO_KEY, "0");
        out.put(LABEL_KEY, Integer.toString(label));
        return out;
    }

    /** ROI 全体で RadiomicsJ の一括抽出を 1 回かける（キャッシュがあれば返す）。 */
    public RoiFeatureResult compute(RoiFeatureRequest req, java.util.function.Consumer<Phase> phase)
            throws IOException {
        check(req);
        int label = labelOf(req.settings());
        Map<String, String> settings = effectiveSettings(req.settings(), label);

        phase.accept(Phase.LOADING);
        // Next のテクスチャ設定は渡さない（Next 側のリサンプリングを掛けない。RadiomicsJ の設定に一本化）。
        RadiomicsMapEngine.LoadedVolume vol = engine.load(req.studyInstanceUid(), req.sourceSeriesUid(),
                req.channel(), req.timePoint(), req.maskSeriesUid(), req.maskChannel(), label, new HashMap<>());

        long roiVoxels = GlamAnalysisService.countRoiVoxels(vol.mask(), label);
        if (roiVoxels < 1) {
            // RadiomicsJ はラベルの無いマスクでも例外を投げず、前の画像のまま計算に進むので、ここで止める。
            throw new IllegalArgumentException("ROI が空です。マスクシリーズ・セグメント・ラベル値を確認してください。");
        }
        if (isTrue(settings.get(GLAM_KEY))) {
            double pairs = (double) roiVoxels * GlamAnalysisService.referenceVoxelsOf(settings, roiVoxels);
            if (pairs > GlamAnalysisService.MAX_ESTIMATED_PAIRS) {
                throw new IllegalArgumentException(String.format(
                        "ROI が大きすぎて GLAM を計算できません（%,d ボクセル）。GLAM は ROI のボクセル対を総当たりします。"
                                + "INT_GLAM_maxReferenceVoxels で中心ボクセルを間引くか、GLAM を外してください。",
                        roiVoxels));
            }
        }

        String key = cache.featureKey(settings, vol);
        if (key != null && !req.recompute()) {
            Optional<RoiFeatureResult> hit = readCache(key);
            if (hit.isPresent()) {
                log.info("[roi-features] cache hit key={}", key.substring(0, 12));
                return hit.get().asCached();
            }
        }

        phase.accept(Phase.EXTRACTING);
        long t0 = System.currentTimeMillis();
        RoiFeatureResult result;
        try {
            result = RadiomicsLock.call(() -> extractLocked(settings, vol, label));
        } catch (IllegalArgumentException | IllegalStateException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("Radiomics 特徴量の計算に失敗しました: " + e.getMessage(), e);
        }
        log.info("[roi-features] {} features, roi={} voxels, {} ms", result.rows().size(), roiVoxels,
                System.currentTimeMillis() - t0);
        if (key != null) {
            cache.saveFeatures(key, json.writeValueAsBytes(result));
        }
        return result;
    }

    private RoiFeatureResult extractLocked(Map<String, String> settings, RadiomicsMapEngine.LoadedVolume vol,
                                           int label) throws Exception {
        try {
            RadiomicsJ radiomics = new RadiomicsJ();
            Properties props = new Properties();
            props.putAll(settings);
            radiomics.loadSettings(props);
            RoiFeatureResult.Discretisation disc = new RoiFeatureResult.Discretisation(
                    RadiomicsJ.BOOL_USE_FixedBinNumber, RadiomicsJ.nBins, RadiomicsJ.binWidth,
                    RadiomicsJ.IVH_mode, RadiomicsJ.IVH_binCount, RadiomicsJ.IVH_binWidth);
            // 渡した設定ではなく読み込んだ後の状態を記録する（loadSettings は範囲外の値を黙って丸める）。
            String properties = RadiomicsJSettingsSnapshot.of(radiomics);
            // 読み込んだマスクには校正が無い（マップは使わないため）。形態特徴はマスクの校正で体積を測るので、
            // 渡さないと 1 mm 等方として黙って違う値になる。
            ImagePlus mask = vol.mask();
            mask.setCalibration(vol.calibration().copy());
            ResultsTable rt = extractor.extract(radiomics, vol.image(), mask, label);
            if (rt == null || rt.size() < 1) {
                throw new IllegalStateException("RadiomicsJ が結果を返しませんでした。");
            }
            Instant at = Instant.now();
            RoiFeatureResult.Provenance provenance = new RoiFeatureResult.Provenance(
                    graphyVersion, RadiomicsJ.version, at, RadiomicsJSettingsSnapshot.sha256(properties));
            return new RoiFeatureResult(RadiomicsJ.version, at, false, label, rows(rt), disc, provenance, properties);
        } finally {
            RadiomicsJ.resetSettings();
            // 例外で抜けると RadiomicsJ は離散化画像を残す。マップの窓がそれを拾うので必ず消す。
            RadiomicsJ.discretiseImp = null;
        }
    }

    /** 結果表の最後の行（今回の抽出）を、列の並びのまま行に直す。 */
    static List<RoiFeatureResult.Row> rows(ResultsTable rt) {
        int last = rt.size() - 1;
        List<RoiFeatureResult.Row> rows = new ArrayList<>();
        for (String column : rt.getHeadings()) {
            if (!rt.columnExists(column)) {
                continue;
            }
            double v = rt.getValue(column, last);
            rows.add(RoiFeatureDefinitions.row(column, Double.isNaN(v) ? null : v));
        }
        return rows;
    }

    private Optional<RoiFeatureResult> readCache(String key) {
        Optional<byte[]> raw = cache.loadFeatures(key);
        if (raw.isEmpty()) {
            return Optional.empty();
        }
        try {
            return Optional.of(json.readValue(raw.get(), RoiFeatureResult.class));
        } catch (IOException e) {
            log.warn("[roi-features] cache entry unreadable, recomputing: {}", e.toString());
            return Optional.empty();
        }
    }

    static int labelOf(Map<String, String> settings) {
        String v = settings == null ? null : settings.get(LABEL_KEY);
        if (v == null || v.isBlank()) {
            return 1;
        }
        try {
            int label = Integer.parseInt(v.trim());
            if (label < 1 || label > 255) {
                throw new IllegalArgumentException("INT_label は 1〜255 で指定してください: " + v);
            }
            return label;
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("INT_label が整数ではありません: " + v);
        }
    }

    /** RadiomicsJ の {@code loadSettings} と同じ判定（"1" か "true"）。 */
    private static boolean isTrue(String v) {
        return v != null && (v.equals("1") || v.equalsIgnoreCase("true"));
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.settings.SettingsService;
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
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;
import java.util.Properties;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Supplier;
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
    /** ROI の大きさの列が Diagnostics から来るので、常に入れる。 */
    static final String DIAGNOSTICS_KEY = SettingParams.BOOL_enableDiagnostics.name();
    /** 環境設定 ▸ テクスチャの「小さい ROI の警告（ボクセル数）」。空なら警告しない。 */
    static final String SMALL_ROI_SETTING = "texture.SmallRoiWarnVoxels";
    /** 同じく 2D（最大断面・スライス別の画素数）。3D と「小さい」の意味が違うので別の設定。 */
    static final String SMALL_ROI_SETTING_2D = "texture.SmallRoiWarnPixels2D";
    static final String SECTION_ENGINE_VERSION = "roi-features-2d-section-1";
    static final String SLICES_ENGINE_VERSION = "roi-features-2d-slices-1";
    private static final String WEIGHT_COLUMN = "Diagnostics_DiagnosticsResegmentedROIIntMaskVoxelCount";

    private static final String DIAG = RoiFeatureDefinitions.DIAGNOSTICS + "_";

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
    private final Supplier<String> smallRoiSetting;
    private final Supplier<String> smallRoiSetting2d;

    @Autowired
    public RoiFeatureService(RadiomicsMapEngine engine, MapCheckpointStore cache, RadiomicsMode mode,
                             ObjectMapper json, @Value("${graphy.version:dev}") String graphyVersion,
                             SettingsService settingsService) {
        this(engine, cache, mode, json, (rj, img, mask, label) -> rj.extractAll(img, mask, label), graphyVersion,
                () -> settingsService.getAll().get(SMALL_ROI_SETTING),
                () -> settingsService.getAll().get(SMALL_ROI_SETTING_2D));
    }

    RoiFeatureService(RadiomicsMapEngine engine, MapCheckpointStore cache, RadiomicsMode mode,
                      ObjectMapper json, Extractor extractor, String graphyVersion, Supplier<String> smallRoiSetting) {
        this(engine, cache, mode, json, extractor, graphyVersion, smallRoiSetting, () -> null);
    }

    RoiFeatureService(RadiomicsMapEngine engine, MapCheckpointStore cache, RadiomicsMode mode,
                      ObjectMapper json, Extractor extractor, String graphyVersion, Supplier<String> smallRoiSetting,
                      Supplier<String> smallRoiSetting2d) {
        this.smallRoiSetting2d = smallRoiSetting2d;
        this.engine = engine;
        this.cache = cache;
        this.mode = mode;
        this.json = json;
        this.extractor = extractor;
        this.graphyVersion = graphyVersion;
        this.smallRoiSetting = smallRoiSetting;
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
        smallRoiThreshold();
        threshold(smallRoiSetting2d, "小さい ROI の警告（画素数、2D）");
    }

    /** 環境設定の基準値。空・未設定なら null。整数でない・1 未満なら例外（黙って警告を止めない）。 */
    Integer smallRoiThreshold() {
        return threshold(smallRoiSetting, "小さい ROI の警告（ボクセル数）");
    }

    private static Integer threshold(Supplier<String> setting, String label) {
        String v = setting.get();
        if (v == null || v.isBlank()) {
            return null;
        }
        try {
            int n = Integer.parseInt(v.trim());
            if (n >= 1) {
                return n;
            }
        } catch (NumberFormatException ignored) {
            // 下の例外にまとめる
        }
        throw new IllegalArgumentException(
                "環境設定の「" + label + "」は 1 以上の整数か空欄にしてください: " + v);
    }

    /** 行（Diagnostics）から ROI の大きさを読み、今の基準値で判定する。 */
    static RoiFeatureResult.RoiSize roiSizeOf(List<RoiFeatureResult.Row> rows, Integer threshold) {
        Map<String, Double> diag = new HashMap<>();
        for (RoiFeatureResult.Row r : rows) {
            if (r.column().startsWith(DIAG)) {
                diag.put(r.column().substring(DIAG.length()), r.value());
            }
        }
        Long initial = count(diag.get("DiagnosticsInitialROIIntMaskVoxelCount"));
        Long intensity = count(diag.get("DiagnosticsResegmentedROIIntMaskVoxelCount"));
        // 形態マスクは再セグメントしない（RadiomicsJ も形態特徴にはリサンプリング後のマスクを使う）ので、
        // リサンプリング後の形態マスクの数を読む。
        Long morph = count(diag.get("DiagnosticsInterpolatedROIMorphMaskVoxelCount"));
        Double dx = diag.get("DiagnosticsInterpolatedImageVoxelDimensionX");
        Double dy = diag.get("DiagnosticsInterpolatedImageVoxelDimensionY");
        Double dz = diag.get("DiagnosticsInterpolatedImageVoxelDimensionZ");
        Double volume = morph == null || dx == null || dy == null || dz == null ? null : morph * dx * dy * dz;
        Boolean small = threshold == null || intensity == null ? null : intensity < threshold;
        return new RoiFeatureResult.RoiSize(initial, intensity, morph, volume, threshold, small);
    }

    private static Long count(Double v) {
        return v == null ? null : Math.round(v);
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
                    "BOOL_force2D は指定できません。2D は「計算の単位」（roiModes: MAX_SECTION_2D・SLICES_2D）で選びます。");
        }
        out.put(OPERATIONAL_INFO_KEY, "0");
        out.put(DIAGNOSTICS_KEY, "1");
        out.put(LABEL_KEY, Integer.toString(label));
        return out;
    }

    /** 進み具合の受け口（スライス別 2D の n / N）。 */
    @FunctionalInterface
    public interface Progress {
        void slice(int done, int total);
    }

    public RoiFeatureResult compute(RoiFeatureRequest req, java.util.function.Consumer<Phase> phase)
            throws IOException {
        return compute(req, phase, (done, total) -> { }, () -> false);
    }

    /**
     * 3D（ROI 全体で一括抽出 1 回）に、選ばれた 2D の単位を足して返す。3D の結果・キャッシュは単位に関わらず同じ。
     */
    public RoiFeatureResult compute(RoiFeatureRequest req, java.util.function.Consumer<Phase> phase,
                                    Progress progress, BooleanSupplier cancelled) throws IOException {
        return compute(req, phase, progress, cancelled, (done, total, rMm) -> { });
    }

    /** 進み具合の受け口（空間スケールの i / N と、今のスケールの r）。 */
    @FunctionalInterface
    public interface ScaleProgress {
        void scale(int done, int total, double scaleMm);
    }

    /**
     * 空間スケール（{@code scalesMm}）を指定したときは、スケールごとに独立した抽出を回して並べる。
     * 取り消しは「今のスケールを最後まで計算し（キャッシュに入る）、残りは始めない」。
     */
    public RoiFeatureResult compute(RoiFeatureRequest req, java.util.function.Consumer<Phase> phase,
                                    Progress progress, BooleanSupplier cancelled, ScaleProgress scaleProgress)
            throws IOException {
        check(req);
        int label = labelOf(req.settings());
        Map<String, String> settings = effectiveSettings(req.settings(), label);

        FilterScale.Conversion conversion = FilterScale.parse(req.scaleConversion());
        List<Double> scales = req.hasScales() ? distinctScales(req.scalesMm()) : null;
        if (scales != null) {
            if (settings.containsKey("DOUBLEARRAY_logSigmaMm")) {
                throw new IllegalArgumentException(
                        "構造の半径（scalesMm）と σ（DOUBLEARRAY_logSigmaMm）は同時に指定できません。どちらか一方にしてください。");
            }
            // 不正な半径・係数は、体積を読む前に断る
            for (double r : scales) {
                FilterScale.sigmaMm(r, 3, conversion, req.scaleCoefficient());
                FilterScale.sigmaMm(r, 2, conversion, req.scaleCoefficient());
            }
        }

        phase.accept(Phase.LOADING);
        // Next のテクスチャ設定は渡さない（Next 側のリサンプリングを掛けない。RadiomicsJ の設定に一本化）。
        RadiomicsMapEngine.LoadedVolume vol = engine.load(req.studyInstanceUid(), req.sourceSeriesUid(),
                req.channel(), req.timePoint(), req.maskSeriesUid(), req.maskChannel(), label, new HashMap<>());

        if (scales == null) {
            return computeUnits(req, vol, label, settings, settings, phase, progress, cancelled);
        }
        List<RoiFeatureResult.ScaleEntry> entries = new ArrayList<>();
        for (int i = 0; i < scales.size(); i++) {
            if (cancelled.getAsBoolean()) {
                throw new java.util.concurrent.CancellationException("スケールの境界で取り消しました");
            }
            double r = scales.get(i);
            scaleProgress.scale(i, scales.size(), r);
            Double s3 = FilterScale.sigmaMm(r, 3, conversion, req.scaleCoefficient());
            Double s2 = FilterScale.sigmaMm(r, 2, conversion, req.scaleCoefficient());
            RoiFeatureResult res = computeUnits(req, vol, label, withSigma(settings, s3), withSigma(settings, s2),
                    phase, progress, cancelled);
            entries.add(new RoiFeatureResult.ScaleEntry(r, s3, s2, conversion.name(), req.scaleCoefficient(), res));
        }
        scaleProgress.scale(scales.size(), scales.size(), scales.get(scales.size() - 1));
        // 先頭のスケールの結果をトップレベルに置く（スケールを知らない呼び手はそれを読む）
        return entries.get(0).result().withScales(entries);
    }

    private static List<Double> distinctScales(List<Double> in) {
        List<Double> out = new ArrayList<>();
        for (Double r : in) {
            if (r == null) {
                throw new IllegalArgumentException("構造の半径に空の値があります。");
            }
            if (!out.contains(r)) {
                out.add(r);
            }
        }
        return out;
    }

    /** σ があれば LoG のキーを足した設定（σ が null＝フィルタなしは設定のまま）。 */
    private static Map<String, String> withSigma(Map<String, String> settings, Double sigmaMm) {
        if (sigmaMm == null) {
            return settings;
        }
        Map<String, String> out = new TreeMap<>(settings);
        out.put("DOUBLEARRAY_logSigmaMm", FilterScale.settingValue(sigmaMm));
        return out;
    }

    /**
     * 読み込み済みの体積で、3D（設定 {@code s3}）に選ばれた 2D の単位（設定 {@code s2}）を足して返す。
     * スケールなしでは {@code s3 == s2}。
     */
    private RoiFeatureResult computeUnits(RoiFeatureRequest req, RadiomicsMapEngine.LoadedVolume vol, int label,
                                          Map<String, String> s3, Map<String, String> s2,
                                          java.util.function.Consumer<Phase> phase, Progress progress,
                                          BooleanSupplier cancelled) throws IOException {
        boolean with2d = req.has(RoiFeatureRequest.RoiMode.MAX_SECTION_2D)
                || req.has(RoiFeatureRequest.RoiMode.SLICES_2D);
        checkLogGrid(s3, vol, with2d);
        RoiFeatureResult whole = compute3d(req, vol, label, s3, phase);
        if (!with2d) {
            return whole;
        }
        phase.accept(Phase.EXTRACTING);
        RoiFeatureResult.Section section = req.has(RoiFeatureRequest.RoiMode.MAX_SECTION_2D)
                ? computeSection(req, vol, label, s2) : null;
        RoiFeatureResult.Slices slices = req.has(RoiFeatureRequest.RoiMode.SLICES_2D)
                ? computeSlices(req, vol, label, s2, progress, cancelled) : null;
        return whole.withModes(section, slices);
    }

    /**
     * LoG は画素ごとの値が間隔に依るので、等方でない格子は断る（RadiomicsJ も断るが、メッセージが英語で、
     * 3D と 2D の単位のどちらで落ちたかも分からない）。リサンプリングを指定していれば RadiomicsJ が等方にする。
     * 3D の単位は 3 軸、2D の単位は面内の 2 軸が揃っていること。
     */
    static void checkLogGrid(Map<String, String> settings, RadiomicsMapEngine.LoadedVolume vol, boolean with2d) {
        String sigma = settings.get("DOUBLEARRAY_logSigmaMm");
        String resample = settings.get("DOUBLEARRAY_resamplingFactorXYZ");
        if (sigma == null || sigma.isBlank() || (resample != null && !resample.isBlank())) {
            return;
        }
        var c = vol.calibration();
        boolean inPlane = Math.abs(c.pixelWidth - c.pixelHeight) <= 1e-3 * Math.max(c.pixelWidth, c.pixelHeight);
        boolean volume = inPlane && Math.abs(c.pixelWidth - c.pixelDepth) <= 1e-3 * Math.max(c.pixelWidth, c.pixelDepth);
        if (!volume || (with2d && !inPlane)) {
            throw new IllegalArgumentException(String.format(
                    "LoG フィルタは等方の格子が前提です（この画像は %.3f × %.3f × %.3f mm）。"
                            + "先にリサンプリングを指定してください。", c.pixelWidth, c.pixelHeight, c.pixelDepth));
        }
    }

    private RoiFeatureResult compute3d(RoiFeatureRequest req, RadiomicsMapEngine.LoadedVolume vol, int label,
                                       Map<String, String> settings, java.util.function.Consumer<Phase> phase)
            throws IOException {
        Integer threshold = smallRoiThreshold();

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
                RoiFeatureResult cached = hit.get().asCached();
                return cached.withPerRequest(roiSizeOf(cached.rows(), threshold), vol.lossyCompressed());
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
        return result.withPerRequest(roiSizeOf(result.rows(), threshold), vol.lossyCompressed());
    }

    // ───────────── 2D の単位（最大断面・スライス別） ─────────────

    /** 2D の計算に渡す設定（上書き済みの設定に BOOL_force2D=1 を足したもの）。 */
    private static Map<String, String> settings2d(Map<String, String> settings) {
        Map<String, String> out = new TreeMap<>(settings);
        out.put(FORCE_2D_KEY, "1");
        return out;
    }

    /** 体積から 1 枚だけ切り出す（画像・マスクとも。校正は元の体積のものを写す）。 */
    private static ImagePlus sliceOf(ImagePlus src, int z, ij.measure.Calibration cal) {
        ImagePlus one = new ImagePlus("slice-" + z, src.getStack().getProcessor(z + 1).duplicate());
        one.setCalibration(cal.copy());
        return one;
    }

    private record Prepared(RoiFeatureResult.Record2d record) {}

    /** 2D の設定を RadiomicsJ に読ませ、実際に効いた設定と離散化を記録する。 */
    private Prepared prepare2d(Map<String, String> settings2d) throws IOException {
        try {
            return RadiomicsLock.call(() -> {
                try {
                    RadiomicsJ radiomics = new RadiomicsJ();
                    Properties props = new Properties();
                    props.putAll(settings2d);
                    radiomics.loadSettings(props);
                    RoiFeatureResult.Discretisation disc = new RoiFeatureResult.Discretisation(
                            RadiomicsJ.BOOL_USE_FixedBinNumber, RadiomicsJ.nBins, RadiomicsJ.binWidth,
                            RadiomicsJ.IVH_mode, RadiomicsJ.IVH_binCount, RadiomicsJ.IVH_binWidth);
                    String properties = RadiomicsJSettingsSnapshot.of(radiomics);
                    Instant at = Instant.now();
                    return new Prepared(new RoiFeatureResult.Record2d(at, disc,
                            new RoiFeatureResult.Provenance(graphyVersion, RadiomicsJ.version, at,
                                    RadiomicsJSettingsSnapshot.sha256(properties)), properties));
                } finally {
                    RadiomicsJ.resetSettings();
                    RadiomicsJ.discretiseImp = null;
                }
            });
        } catch (IOException | RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("2D の設定を読み込めませんでした: " + e.getMessage(), e);
        }
    }

    /** 1 枚を 2D で抽出する（ロックは 1 枚ごと）。結果が無ければ null。 */
    private List<RoiFeatureResult.Row> extractOne(Map<String, String> settings2d, ImagePlus image, ImagePlus mask,
                                                 int label) throws Exception {
        return RadiomicsLock.call(() -> {
            try {
                RadiomicsJ radiomics = new RadiomicsJ();
                Properties props = new Properties();
                props.putAll(settings2d);
                radiomics.loadSettings(props);
                ResultsTable rt = extractor.extract(radiomics, image, mask, label);
                return rt == null || rt.size() < 1 ? null : rows(rt);
            } finally {
                RadiomicsJ.resetSettings();
                RadiomicsJ.discretiseImp = null;
            }
        });
    }

    private RoiFeatureResult.Section computeSection(RoiFeatureRequest req, RadiomicsMapEngine.LoadedVolume vol,
                                                    int label, Map<String, String> settings) throws IOException {
        double[] pos = MaxSectionService.positionsMm(vol);
        double pixelArea = MaxSectionService.pixelAreaOf(vol);
        int nZ = vol.slices();
        long[] pixels = new long[nZ];
        for (int z = 0; z < nZ; z++) {
            pixels[z] = MaxSectionService.countSlice(vol.mask().getStack().getProcessor(z + 1), label);
        }
        MaxSectionService.Result max = MaxSectionService.analyze(vol.sopPerZ(), new int[nZ], pos, pixels, pixelArea);
        int z = -1;
        for (int i = 0; i < nZ; i++) {
            if (pos[i] == max.best().positionMm() && pixels[i] == max.best().pixels()) {
                z = i;
                break;
            }
        }
        Integer threshold = threshold(smallRoiSetting2d, "小さい ROI の警告（画素数、2D）");
        Map<String, String> s2 = settings2d(settings);
        Map<String, String> keySettings = new TreeMap<>(s2);
        keySettings.put("NEXT_sectionPositionMm", Double.toString(max.best().positionMm()));
        String key = cache.featureKey(SECTION_ENGINE_VERSION, keySettings, vol);
        if (key != null && !req.recompute()) {
            Optional<byte[]> raw = cache.loadFeatures(key);
            if (raw.isPresent()) {
                try {
                    RoiFeatureResult.Section hit = json.readValue(raw.get(), RoiFeatureResult.Section.class);
                    log.info("[roi-features] 2D section cache hit key={}", key.substring(0, 12));
                    return new RoiFeatureResult.Section(true, hit.positionMm(), hit.areaMm2(), hit.pixels(),
                            hit.rows(), hit.record(), roiSizeOf(hit.rows(), threshold));
                } catch (IOException e) {
                    log.warn("[roi-features] 2D section cache unreadable, recomputing: {}", e.toString());
                }
            }
        }
        Prepared prepared = prepare2d(s2);
        List<RoiFeatureResult.Row> rows;
        try {
            rows = extractOne(s2, sliceOf(vol.image(), z, vol.calibration()),
                    sliceOf(vol.mask(), z, vol.calibration()), label);
        } catch (IllegalArgumentException | IllegalStateException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("最大断面 2D の計算に失敗しました: " + e.getMessage(), e);
        }
        if (rows == null) {
            throw new IllegalStateException("RadiomicsJ が最大断面 2D の結果を返しませんでした。");
        }
        RoiFeatureResult.Section out = new RoiFeatureResult.Section(false, max.best().positionMm(),
                max.best().areaMm2(), max.best().pixels(), rows, prepared.record(), null);
        if (key != null) {
            cache.saveFeatures(key, json.writeValueAsBytes(out));
        }
        return new RoiFeatureResult.Section(false, out.positionMm(), out.areaMm2(), out.pixels(), rows,
                out.record(), roiSizeOf(rows, threshold));
    }

    private RoiFeatureResult.Slices computeSlices(RoiFeatureRequest req, RadiomicsMapEngine.LoadedVolume vol,
                                                  int label, Map<String, String> settings, Progress progress,
                                                  BooleanSupplier cancelled) throws IOException {
        double[] pos = MaxSectionService.positionsMm(vol);
        double pixelArea = MaxSectionService.pixelAreaOf(vol);
        int nZ = vol.slices();
        List<Integer> fg = new ArrayList<>();
        long[] pixels = new long[nZ];
        for (int z = 0; z < nZ; z++) {
            pixels[z] = MaxSectionService.countSlice(vol.mask().getStack().getProcessor(z + 1), label);
            if (pixels[z] > 0) {
                fg.add(z);
            }
        }
        fg.sort(java.util.Comparator.comparingDouble(z -> pos[z]));
        Integer threshold = threshold(smallRoiSetting2d, "小さい ROI の警告（画素数、2D）");
        Map<String, String> s2 = settings2d(settings);
        String key = cache.featureKey(SLICES_ENGINE_VERSION, s2, vol);
        if (key != null && !req.recompute()) {
            Optional<byte[]> raw = cache.loadFeatures(key);
            if (raw.isPresent()) {
                try {
                    RoiFeatureResult.Slices hit = json.readValue(raw.get(), RoiFeatureResult.Slices.class);
                    log.info("[roi-features] 2D slices cache hit key={}", key.substring(0, 12));
                    progress.slice(hit.foregroundSlices(), hit.foregroundSlices());
                    return withSmallRoi(hit, true, threshold);
                } catch (IOException e) {
                    log.warn("[roi-features] 2D slices cache unreadable, recomputing: {}", e.toString());
                }
            }
        }
        Prepared prepared = prepare2d(s2);
        List<RoiFeatureResult.SliceRow> rows = new ArrayList<>();
        List<RoiFeatureResult.SliceFailure> failures = new ArrayList<>();
        int done = 0;
        progress.slice(0, fg.size());
        for (int z : fg) {
            if (cancelled.getAsBoolean()) {
                throw new CancellationException("取り消されました");
            }
            try {
                List<RoiFeatureResult.Row> r = extractOne(s2, sliceOf(vol.image(), z, vol.calibration()),
                        sliceOf(vol.mask(), z, vol.calibration()), label);
                if (r == null) {
                    failures.add(new RoiFeatureResult.SliceFailure(pos[z], "RadiomicsJ が結果を返しませんでした。"));
                } else {
                    rows.add(new RoiFeatureResult.SliceRow(pos[z], pixels[z], pixels[z] * pixelArea, r));
                }
            } catch (Exception e) {
                log.warn("[roi-features] 2D slice at {} mm failed: {}", pos[z], e.toString());
                failures.add(new RoiFeatureResult.SliceFailure(pos[z],
                        e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName()));
            }
            progress.slice(++done, fg.size());
        }
        Aggregation agg = aggregate(rows);
        RoiFeatureResult.Slices out = new RoiFeatureResult.Slices(false, rows, failures, agg.mean,
                agg.weighted, agg.used, fg.size(), prepared.record(), null, List.of());
        if (key != null && failures.isEmpty()) {
            // 失敗のあった結果は置かない（次回は再計算して、直っていれば全枚の結果になる）
            cache.saveFeatures(key, json.writeValueAsBytes(out));
        }
        return withSmallRoi(out, false, threshold);
    }

    /** 基準値は返すたびに今の環境設定で判定し直す（キャッシュの値は使わない）。 */
    private static RoiFeatureResult.Slices withSmallRoi(RoiFeatureResult.Slices s, boolean fromCache,
                                                       Integer threshold) {
        List<Double> small = new ArrayList<>();
        if (threshold != null) {
            for (RoiFeatureResult.SliceRow r : s.rows()) {
                Double v = r.rows().stream().filter(x -> x.column().equals(WEIGHT_COLUMN)).map(
                        RoiFeatureResult.Row::value).findFirst().orElse(null);
                if (v != null && v < threshold) {
                    small.add(r.positionMm());
                }
            }
        }
        return new RoiFeatureResult.Slices(fromCache, s.rows(), s.failures(), s.mean(), s.pixelWeightedMean(),
                s.slicesUsed(), s.foregroundSlices(), s.record(), threshold, small);
    }

    private record Aggregation(List<RoiFeatureResult.Row> mean, List<RoiFeatureResult.Row> weighted,
                               Map<String, Integer> used) {}

    /**
     * 列ごとに、値のあるスライスだけで (a) 単純平均、(b) 強度マスクの画素数
     * （{@value #WEIGHT_COLUMN}）で重み付けした平均。使ったスライス数は (a) の数。
     */
    static Aggregation aggregate(List<RoiFeatureResult.SliceRow> slices) {
        java.util.LinkedHashSet<String> columns = new java.util.LinkedHashSet<>();
        for (RoiFeatureResult.SliceRow s : slices) {
            for (RoiFeatureResult.Row r : s.rows()) {
                columns.add(r.column());
            }
        }
        List<RoiFeatureResult.Row> mean = new ArrayList<>();
        List<RoiFeatureResult.Row> weighted = new ArrayList<>();
        Map<String, Integer> used = new java.util.LinkedHashMap<>();
        for (String c : columns) {
            double sum = 0;
            int n = 0;
            double wsum = 0;
            double wtot = 0;
            for (RoiFeatureResult.SliceRow s : slices) {
                Double v = null;
                Double w = null;
                for (RoiFeatureResult.Row r : s.rows()) {
                    if (r.column().equals(c)) v = r.value();
                    if (r.column().equals(WEIGHT_COLUMN)) w = r.value();
                }
                if (v == null) {
                    continue;
                }
                sum += v;
                n++;
                if (w != null && w > 0) {
                    wsum += v * w;
                    wtot += w;
                }
            }
            used.put(c, n);
            mean.add(RoiFeatureDefinitions.row(c, n == 0 ? null : sum / n));
            weighted.add(RoiFeatureDefinitions.row(c, wtot == 0 ? null : wsum / wtot));
        }
        return new Aggregation(mean, weighted, used);
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
            return new RoiFeatureResult(RadiomicsJ.version, at, false, label, rows(rt), disc, provenance, properties,
                    null, false);
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

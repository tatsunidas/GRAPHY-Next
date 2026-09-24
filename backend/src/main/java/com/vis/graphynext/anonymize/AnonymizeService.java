/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.dcm4che3.io.DicomOutputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 匿名化（属性＋Pixel 焼き込み）のオーケストレーション。standalone のローカルファイルを読み、
 * 匿名化して ZIP / フォルダへ出力する（web は WADO 取得が必要なため未対応）。
 */
@Service
public class AnonymizeService {

    private static final Logger log = LoggerFactory.getLogger(AnonymizeService.class);

    private final DicomInstanceRepository repo;
    private final AnonymizeMaskStore maskStore;
    private final ObjectProvider<WebDicomDataService> webProvider;
    private final PixelCodec codec;
    private final DicomAnonymizerEngine engine = new DicomAnonymizerEngine();

    public AnonymizeService(DicomInstanceRepository repo, AnonymizeMaskStore maskStore,
                            ObjectProvider<WebDicomDataService> webProvider, PixelCodec codec) {
        this.repo = repo;
        this.maskStore = maskStore;
        this.webProvider = webProvider;
        this.codec = codec;
    }

    /**
     * 匿名化の結果。
     *
     * @param notBurnedInstances 焼き込みを要求されたのに<b>1 画素も塗れなかった</b>インスタンス数
     *                           （マスク未登録のシリーズなど）。
     *                           🔴 これらは Clean Pixel Data を申告していないので、
     *                           <b>受け取り側から見ると焼き込み文字が残ったまま</b>。0 でなければ
     *                           利用者に見せる必要がある（{@code burnedInstances} が 0 でも
     *                           従来はそれが異常だと分からなかった）。
     * @param partiallyBurnedInstances multi-frame で<b>一部のフレームだけ</b>塗ったインスタンス数。
     *                           🔴 これも申告しない。63 フレーム中 1 枚だけ塗って「除去済み」と
     *                           宣言していたのが 2026-09-24 に見つかった不具合で、残り 62 枚には
     *                           患者名が残っていた。塗った事実と「きれいになった」は別物。
     */
    public record Result(int studies, int series, int instances, int burnedInstances, int notBurnedInstances,
            int partiallyBurnedInstances, long usedSeed, List<String> errors) {
    }

    public boolean isWeb() {
        return webProvider.getIfAvailable() != null;
    }

    /** 匿名化して ZIP ストリームへ出力。 */
    @Transactional(readOnly = true)
    public Result anonymizeToZip(List<String> studyUids, AnonymizeConfig cfg, boolean burnIn, OutputStream out)
            throws IOException {
        try (ZipOutputStream zos = new ZipOutputStream(out)) {
            return run(studyUids, cfg, burnIn, (ds, tsuid) -> {
                String name = ds.getString(Tag.StudyInstanceUID) + "/" + ds.getString(Tag.SeriesInstanceUID)
                        + "/" + ds.getString(Tag.SOPInstanceUID) + ".dcm";
                zos.putNextEntry(new ZipEntry(name));
                writePart10(ds, tsuid, zos);
                zos.closeEntry();
            });
        }
    }

    /** 匿名化してフォルダへ出力（standalone）。 */
    @Transactional(readOnly = true)
    public Result anonymizeToFolder(List<String> studyUids, AnonymizeConfig cfg, boolean burnIn, String destination)
            throws IOException {
        Path dest = Path.of(destination);
        if (!dest.isAbsolute()) {
            throw new IOException("出力先は絶対パスで指定してください: " + destination);
        }
        Files.createDirectories(dest);
        return run(studyUids, cfg, burnIn, (ds, tsuid) -> {
            Path dir = dest.resolve(ds.getString(Tag.StudyInstanceUID)).resolve(ds.getString(Tag.SeriesInstanceUID));
            Files.createDirectories(dir);
            Path f = dir.resolve(ds.getString(Tag.SOPInstanceUID) + ".dcm");
            try (OutputStream fo = Files.newOutputStream(f)) {
                writePart10(ds, tsuid, fo);
            }
        });
    }

    private interface Sink {
        void accept(Attributes anonymized, String tsuid) throws IOException;
    }

    /** 事前見積り（ZIP を流し始める前の健全性チェック用）。 */
    public record Preflight(int indexed, int resolvable, List<String> problems) {
    }

    /**
     * 出力対象になるインスタンスが実際に何件あるかを、書き出す前に数える。
     *
     * <p>ZIP はストリーミングで返すため、**1 バイトでも流し始めたらステータスコードを変えられない**。
     * その状態で 0 件になると「HTTP 200 ＋ 中身が空（22 バイト）の正常な ZIP」が返り、UI は
     * 成功メッセージを出してしまう（利用者からは「ZIP が空だった」としか見えない）。
     * そうならないよう、controller はこれを先に呼んで 0 件なら 409 で弾く。
     */
    @Transactional(readOnly = true)
    public Preflight preflight(List<String> studyUids) {
        List<String> problems = new ArrayList<>();
        int indexed = 0;
        int resolvable = 0;
        for (String su : studyUids) {
            if (su == null || su.isBlank()) {
                continue;
            }
            List<DicomInstance> insts = repo.findByStudyInstanceUid(su);
            if (insts.isEmpty()) {
                problems.add("索引にインスタンスがありません: study " + su);
                continue;
            }
            for (DicomInstance inst : insts) {
                indexed++;
                if (fileOf(inst) == null) {
                    if (problems.size() < 20) {
                        problems.add("ファイル無し: " + inst.getSopInstanceUid() + " (" + inst.getUri() + ")");
                    }
                } else {
                    resolvable++;
                }
            }
        }
        return new Preflight(indexed, resolvable, problems);
    }

    /**
     * 焼き込みの事前検査。
     *
     * @param burnable   マスクがあり、実際に塗れるインスタンス数
     * @param blocked    <b>マスクはあるのに塗れない</b>インスタンス数。🔴 これがあると
     *                   「登録したのに残っている」出力になる。1 件でもあれば中止する
     * @param unmasked   マスクの無いシリーズのインスタンス数。申告しないので DICOM としては
     *                   正直だが、利用者は気づけないので件数を見せる
     * @param problems   {@code blocked} の理由（先頭のいくつか）
     */
    public record BurnPreflight(int burnable, int blocked, int unmasked, List<String> problems) {
    }

    /**
     * 焼き込みが<b>本当に実行できるか</b>を、1 バイトも書き出す前に確かめる。
     *
     * <p>🔴 <b>ここが無かったために、利用者は「マスクを登録したのに効かない」出力を
     * 気づかずに受け取っていた</b>（2026-09-24）。ZIP はストリーミングなので 1 バイト流したら
     * ステータスを変えられず、`copy` の事後警告も ZIP には出せない。**事前に判定するしかない。**
     *
     * <p>判定は実処理と同じ {@link #geometryOf} と {@link PixelCodec#isUncompressed} を通す
     * ——「検査は通ったのに塗れなかった」を作らないため。画素は読まない
     * （{@code IncludeBulkData.NO} ＋ PixelData の手前まで）ので、件数が多くても header 読みだけで済む。
     */
    @Transactional(readOnly = true)
    public BurnPreflight burnPreflight(List<String> studyUids) {
        List<String> problems = new ArrayList<>();
        int burnable = 0;
        int blocked = 0;
        int unmasked = 0;
        for (String su : studyUids) {
            if (su == null || su.isBlank()) {
                continue;
            }
            for (DicomInstance inst : repo.findByStudyInstanceUid(su)) {
                Path src = fileOf(inst);
                if (src == null) {
                    continue; // ファイル欠けは preflight() の担当
                }
                AnonymizeMaskStore.SeriesMask mask = maskStore.get(inst.getSeriesInstanceUid());
                if (mask == null) {
                    unmasked++;
                    continue;
                }
                String why = burnBlocker(src, mask, inst.getSopInstanceUid());
                if (why == null) {
                    burnable++;
                } else {
                    blocked++;
                    if (problems.size() < 10) {
                        problems.add(inst.getSopInstanceUid() + ": " + why);
                    }
                }
            }
        }
        return new BurnPreflight(burnable, blocked, unmasked, problems);
    }

    /** 塗れない理由（塗れるなら null）。画素は読まない。 */
    private String burnBlocker(Path src, AnonymizeMaskStore.SeriesMask mask, String sopInstanceUid) {
        Attributes ds;
        String tsuid;
        try (DicomInputStream in = new DicomInputStream(src.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            in.readFileMetaInformation();
            ds = in.readDataset(-1, Tag.PixelData); // 0028 群まで読めれば足りる
            tsuid = in.getTransferSyntax();
        } catch (Exception e) {
            return "読み込めません (" + e.getMessage() + ")";
        }
        boolean applies = false;
        for (AnonymizeMaskStore.MaskPolygon p : mask.allPolygons()) {
            if (p.appliesTo(sopInstanceUid)) {
                applies = true;
                break;
            }
        }
        if (!applies) {
            return "このインスタンスに適用されるマスクがありません";
        }
        if (geometryOf(ds) == null) {
            return "画素の並びが焼き込みに対応していません"
                    + "（BitsAllocated=" + ds.getInt(Tag.BitsAllocated, 0)
                    + " PlanarConfiguration=" + ds.getInt(Tag.PlanarConfiguration, 0) + "）";
        }
        if (!PixelCodec.isUncompressed(tsuid) && !codec.available()) {
            return "圧縮画像（" + tsuid + "）を伸長できません: " + codec.unavailableReason();
        }
        return null;
    }

    private Result run(List<String> studyUids, AnonymizeConfig cfg, boolean burnIn, Sink sink) {
        List<String> errors = new ArrayList<>();
        // 対象インスタンスを収集し、患者マッピングを事前構築。
        List<DicomInstance> all = new ArrayList<>();
        java.util.Set<String> studySet = new java.util.LinkedHashSet<>();
        java.util.Set<String> seriesSet = new java.util.LinkedHashSet<>();
        for (String su : studyUids) {
            if (su == null || su.isBlank()) {
                continue;
            }
            List<DicomInstance> insts = repo.findByStudyInstanceUid(su);
            all.addAll(insts);
            studySet.add(su);
        }
        long dateSeed = resolveDateSeed(cfg);
        Map<String, DicomAnonymizerEngine.PatientMapping> pmap = buildPatientMappings(all, cfg, dateSeed);
        Map<String, String> uidMap = new HashMap<>();
        boolean cleanPixel = cfg.hasOption(AnonymizeConfig.Option.CleanPixelData) && burnIn;

        int instances = 0;
        int burned = 0;
        int notBurned = 0;
        int partiallyBurned = 0;
        for (DicomInstance inst : all) {
            try {
                Path src = fileOf(inst);
                if (src == null) {
                    errors.add("ファイル無し: " + inst.getSopInstanceUid());
                    continue;
                }
                Attributes ds;
                String tsuid;
                try (DicomInputStream in = new DicomInputStream(src.toFile())) {
                    // 🔴 URI（YES ではなく）。PixelData を**元ファイルへの参照**として持たせる。
                    //    圧縮画素の伸長（PixelCodec）は Decompressor が BulkData を要求するため、
                    //    YES で読んで byte[] にしてしまうと ClassCastException になる。
                    //    非圧縮の経路では getBytes() が従来どおり実体を返すので影響しない。
                    in.setIncludeBulkData(IncludeBulkData.URI);
                    in.readFileMetaInformation();
                    ds = in.readDataset(-1, -1);
                    tsuid = in.getTransferSyntax();
                }
                String origPat = inst.getPatientId() == null ? "" : inst.getPatientId();
                DicomAnonymizerEngine.PatientMapping pm = pmap.get(origPat);
                if (pm == null) {
                    // 索引に患者 ID が無い等でマッピングを引けない場合。日付シフトは
                    // 同じ導出式で決めるので、この経路でも患者内の一貫性は保たれる。
                    int shift = cfg.hasOption(AnonymizeConfig.Option.RetainLongitudinalTemporalInformationModifiedDates)
                            ? DateShifter.shiftDaysFor(origPat, dateSeed) : 0;
                    pm = new DicomAnonymizerEngine.PatientMapping(
                            cfg.getReplacePatientId(), cfg.getReplacePatientName(), shift);
                }

                // 焼き込み（属性匿名化前に元 seriesUid で判定）。
                // 🔴 塗れたかどうかは **インスタンス単位** で決まる（マスクが無いシリーズもあるし、
                // multi-frame では一部フレームしか指定されていないこともある）。その事実を申告へ渡す。
                boolean pixelCleaned = false;
                String outTs = tsuid;
                if (cleanPixel) {
                    AnonymizeMaskStore.SeriesMask mask = maskStore.get(inst.getSeriesInstanceUid());
                    BurnOutcome b = mask == null ? BurnOutcome.notAttempted()
                            : burnInto(ds, tsuid, mask, inst.getSopInstanceUid(), cfg.getBurnDilatePx());
                    if (b.decompressed()) {
                        // 伸長したものは非圧縮として書き出す（再圧縮は lossy 再エンコードの劣化を持ち込む）。
                        outTs = UID.ExplicitVRLittleEndian;
                    }
                    if (b.fullyCleaned()) {
                        pixelCleaned = true;
                        burned++;
                    } else if (b.framesPainted() > 0) {
                        // 🔴 塗ったが全フレームではない。申告はしない（BurnedInAnnotation は原本のまま）。
                        partiallyBurned++;
                    } else {
                        notBurned++;
                    }
                }
                engine.deidentify(ds, cfg, pm, uidMap,
                        new DicomAnonymizerEngine.InstanceDeidFacts(pixelCleaned));
                seriesSet.add(ds.getString(Tag.SeriesInstanceUID));
                sink.accept(ds, outTs);
                instances++;
            } catch (Exception e) {
                errors.add(inst.getSopInstanceUid() + ": " + e.getMessage());
            }
        }
        log.info("Anonymize: studies={} instances={} burned={} partial={} notBurned={} errors={}",
                studySet.size(), instances, burned, partiallyBurned, notBurned, errors.size());
        return new Result(studySet.size(), seriesSet.size(), instances, burned, notBurned, partiallyBurned,
                dateSeed, errors);
    }

    /**
     * 日付シフトに使う種を決める。
     *
     * <p>{@code randomSeed} が指定されていればそれを使い、無ければ 1 回だけ生成して
     * {@link Result#usedSeed()} で返す。<b>返さないと「後日その患者だけ追加でエクスポートしたら
     * 日付が別方向にずれた」という事故を防げない</b>——利用者が控えて次回に指定できることが要件。
     *
     * <p>⚠ 患者 ID のシャッフルには使わない。{@code randomSeed} 未指定のときシャッフルしないのは
     * 既存の挙動なので、日付のためにここを変えない。
     */
    private static long resolveDateSeed(AnonymizeConfig cfg) {
        if (cfg.getRandomSeed() != null) {
            return cfg.getRandomSeed();
        }
        // 🔴 2^53 未満に収める。JSON の数値は JS では double なので、Long の全域を返すと
        // 画面に出た時点で下位桁が失われ、**控えた種を次回に指定しても同じ日付にならない**。
        // 種の役割は「利用者が控えて再現できること」なので、再現できない値を返すのは無意味。
        return new java.security.SecureRandom().nextLong() & ((1L << 53) - 1);
    }

    /** 患者ごとの新 ID/Name を決める（単一→置換文字列、複数→連番。randomSeed で順序撹拌）。 */
    private static Map<String, DicomAnonymizerEngine.PatientMapping> buildPatientMappings(
            List<DicomInstance> all, AnonymizeConfig cfg, long dateSeed) {
        java.util.LinkedHashSet<String> pids = new java.util.LinkedHashSet<>();
        for (DicomInstance i : all) {
            pids.add(i.getPatientId() == null ? "" : i.getPatientId());
        }
        List<String> list = new ArrayList<>(pids);
        Collections.sort(list);
        if (cfg.getRandomSeed() != null) {
            Collections.shuffle(list, new Random(cfg.getRandomSeed()));
        }
        String idPrefix = blank(cfg.getReplacePatientId(), "ANON");
        String namePrefix = blank(cfg.getReplacePatientName(), "ANON");
        boolean single = list.size() == 1;
        // 日付シフトは Modified Dates を選んだときだけ効かせる（それ以外は 0＝従来どおり）。
        boolean shiftDates = cfg.hasOption(AnonymizeConfig.Option.RetainLongitudinalTemporalInformationModifiedDates);
        Map<String, DicomAnonymizerEngine.PatientMapping> map = new LinkedHashMap<>();
        int n = 1;
        for (String orig : list) {
            String newId = single ? idPrefix : String.format("%s%03d", idPrefix, n);
            String newName = single ? namePrefix : namePrefix + "^" + n;
            // 🔴 オフセットは「種と元 PatientID」の純関数。ここでの並び（list は上でシャッフル
            // され得る）に依存しないので、対象範囲が変わっても同じ患者には同じ値が出る。
            int shift = shiftDates ? DateShifter.shiftDaysFor(orig, dateSeed) : 0;
            map.put(orig, new DicomAnonymizerEngine.PatientMapping(newId, newName, shift));
            n++;
        }
        return map;
    }

    /**
     * 1 インスタンスの焼き込み結果。
     *
     * <p>🔴 <b>「塗った」と「きれいになった」は別物。</b> multi-frame で 1 枚だけ塗っても
     * そのインスタンスの焼き込み文字は消えていない。113101 / {@code BurnedInAnnotation=NO} を
     * 申告してよいのは {@link #fullyCleaned()} のときだけ（2026-09-24 に見つかった偽申告の再発防止）。
     *
     * @param framesPainted 実際に塗ったフレーム数
     * @param framesTotal   そのインスタンスのフレーム数
     * @param decompressed  圧縮画素を伸長したか（出力を非圧縮 TS にする必要がある）
     */
    record BurnOutcome(int framesPainted, int framesTotal, boolean decompressed) {

        static BurnOutcome notAttempted() {
            return new BurnOutcome(0, 0, false);
        }

        /** そのインスタンスの全フレームを塗れたか。 */
        boolean fullyCleaned() {
            return framesTotal > 0 && framesPainted == framesTotal;
        }
    }

    /**
     * マスク領域を一定値（0）で潰す。
     *
     * <p>矩形・楕円・ポリゴン・クローズドフリーハンドはすべて {@code MaskPolygon} へ潰れており、
     * {@link PolygonRasterizer} が「行ごとの連続区間」を返すので、<b>画素アドレス計算は
     * 矩形時代のまま</b>（区間の決め方だけが変わった）。
     *
     * <p>⚠ 「黒く塗る」ではなく「<b>一定値で潰す</b>」。0 は {@code MONOCHROME1} では白、
     * signed では中間値、{@code PALETTE COLOR} では 0 番の色になる。判読不能化という目的は
     * どれでも満たすので値は 0 のままでよい。
     *
     * <p><b>圧縮 TS は伸長してから塗る</b>（{@link PixelCodec}）。XA は JPEG が標準なので、
     * 伸長しないと焼き込み除去が事実上使えない。伸長するのは<b>実際に塗る対象があるときだけ</b>
     * ——マスクの無いインスタンスまで作り替えるとファイルが 10〜20 倍に膨らむ。
     *
     * <p>🔴 塗れない条件では <b>何もしない</b>。呼び出し元はその事実を
     * {@code InstanceDeidFacts} でエンジンへ渡すので、<b>申告もされない</b>（安全側）。
     */
    private BurnOutcome burnInto(Attributes ds, String tsuid, AnonymizeMaskStore.SeriesMask mask,
            String sopInstanceUid, int dilatePx) throws IOException {
        Geometry g = geometryOf(ds);
        if (g == null) {
            return BurnOutcome.notAttempted();
        }

        // このインスタンスに効く多角形だけに絞る（rects は多角形へ正規化済み）。
        List<AnonymizeMaskStore.MaskPolygon> polys = new ArrayList<>();
        for (AnonymizeMaskStore.MaskPolygon p : mask.allPolygons()) {
            if (p.appliesTo(sopInstanceUid)) {
                polys.add(p);
            }
        }
        if (polys.isEmpty()) {
            return BurnOutcome.notAttempted();
        }

        boolean decompressed = false;
        byte[] px;
        if (PixelCodec.isUncompressed(tsuid)) {
            px = ds.getBytes(Tag.PixelData);
        } else {
            px = codec.decompress(ds, tsuid);
            decompressed = px != null;
        }
        int frameSize = g.rows() * g.cols() * g.bps();
        if (px == null || px.length < frameSize) {
            return BurnOutcome.notAttempted();
        }

        int painted = 0;
        for (int f = 0; f < g.frames(); f++) {
            int base = f * frameSize;
            boolean paintedThisFrame = false;
            for (AnonymizeMaskStore.MaskPolygon p : polys) {
                if (!p.appliesToFrame(f, mask.frames())) {
                    continue;
                }
                for (PolygonRasterizer.Run run : PolygonRasterizer.runsFor(p, g.cols(), g.rows(), dilatePx)) {
                    int off = base + (run.y() * g.cols() + run.xStart()) * g.bps();
                    int len = (run.xEnd() - run.xStart()) * g.bps();
                    if (off >= 0 && len > 0 && off + len <= px.length) {
                        java.util.Arrays.fill(px, off, off + len, (byte) 0);
                        paintedThisFrame = true;
                    }
                }
            }
            if (paintedThisFrame) {
                painted++;
            }
        }
        if (painted > 0 || decompressed) {
            // 伸長した時点で画素の表現が変わっているので、塗れなくても書き戻す必要がある。
            ds.setBytes(Tag.PixelData, g.bits() > 8 ? VR.OW : VR.OB, px);
        }
        return new BurnOutcome(painted, g.frames(), decompressed);
    }

    /**
     * 画素アドレス計算に要る形。<b>塗れない形なら null</b>。
     *
     * <p>事前検査（{@link #burnPreflight}）と実処理で同じ判定を通すために切り出してある
     * ——「検査は通したのに塗れなかった」を作らないため。
     */
    private record Geometry(int rows, int cols, int frames, int bits, int bps) {
    }

    private static Geometry geometryOf(Attributes ds) {
        int rows = ds.getInt(Tag.Rows, 0);
        int cols = ds.getInt(Tag.Columns, 0);
        if (rows <= 0 || cols <= 0) {
            return null;
        }
        int bits = ds.getInt(Tag.BitsAllocated, 8);
        int spp = ds.getInt(Tag.SamplesPerPixel, 1);
        // 🔴 bps は「1 画素あたりバイト数」。bits が 8 の倍数でないと成立しないので、
        // その場合は塗らない（誤った位置を塗るより何もしないほうが良い）。
        if (bits <= 0 || bits % 8 != 0) {
            return null;
        }
        // 🔴 PlanarConfiguration=1（RRR…GGG…BBB…）は画素インターリーブ前提の
        // (y*cols + x)*bps が成立しない。誤った位置を塗るので対象外にする。
        if (spp > 1 && ds.getInt(Tag.PlanarConfiguration, 0) != 0) {
            return null;
        }
        int nf = ds.getInt(Tag.NumberOfFrames, 1);
        if (nf <= 0) {
            return null;
        }
        return new Geometry(rows, cols, nf, bits, (bits / 8) * spp);
    }

    private static void writePart10(Attributes ds, String tsuid, OutputStream out) throws IOException {
        String ts = (tsuid == null || tsuid.isBlank()) ? UID.ExplicitVRLittleEndian : tsuid;
        Attributes fmi = ds.createFileMetaInformation(ts);
        DicomOutputStream dos = new DicomOutputStream(out, ts);
        dos.writeDataset(fmi, ds);
        dos.flush();
    }

    private static Path fileOf(DicomInstance inst) {
        String uri = inst.getUri();
        if (uri == null || !uri.startsWith("file:")) {
            return null;
        }
        try {
            Path p = Path.of(java.net.URI.create(uri));
            return Files.exists(p) ? p : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String blank(String s, String fb) {
        return (s == null || s.isBlank()) ? fb : s;
    }
}

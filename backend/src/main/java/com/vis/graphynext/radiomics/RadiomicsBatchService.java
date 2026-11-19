/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.album.AlbumService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BiFunction;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * ROI 特徴量の一括抽出。利用者が確認した組を 1 つずつ直列に {@link RoiFeatureService#compute} へ渡す。
 *
 * <p>空のマスクを {@code RadiomicsMapEngine} に渡すと全面マスクで計算されて黙って誤った値が出るので、
 * {@code EXCLUDED} の組は<b>計算を呼ばずに</b> {@code SKIPPED} とする。入力固有の失敗・エンジンの失敗は
 * その組だけ記録して続け、環境の失敗（IO・メモリ）は残りを {@code NOT_RUN} のまま止める
 * （組を失敗に書き換えて捨てない）。取り消しは「次の組に進まない」。再実行は計算済みの組が
 * {@link MapCheckpointStore} のキャッシュに当たって続きから進む。
 */
@Service
public class RadiomicsBatchService {

    private static final Logger log = LoggerFactory.getLogger(RadiomicsBatchService.class);

    private static final int MAX_FINISHED_JOBS = 50;
    private static final long FINISHED_TTL_MS = 60 * 60 * 1000L;

    public enum JobState { QUEUED, RUNNING, DONE, STOPPED, CANCELLED }

    /**
     * {@code SKIPPED} は計画で除外された組（計算しない）。{@code QC_SKIPPED} は計算したが、QC の「スキップ」に当たって
     * 値を表に入れなかった組（理由は {@code error}、旗は {@code qcFlags}）。
     */
    public enum PairState { PENDING, RUNNING, DONE, FAILED, SKIPPED, QC_SKIPPED, NOT_RUN, CANCELLED }

    /** INPUT＝入力固有（IllegalArgumentException）、ENGINE＝入力かエンジンか区別できない（IllegalStateException など）、
     *  ENVIRONMENT＝IO・メモリ。 */
    public enum FailureKind { INPUT, ENGINE, ENVIRONMENT }

    /** QC に当たった組をどうするか。{@code FLAG}＝記録して続ける、{@code STOP}＝その組の結果を残してジョブを止める。 */
    /**
     * FLAG＝旗を付けて続ける、STOP＝当たった組の結果を残して止める（人が 1 件ずつ判断する）、
     * SKIP＝止めずに続け、当たった組の値は表に入れずに「スキップ・理由」の行として残す。
     */
    public enum QcMode { FLAG, STOP, SKIP }

    /** QC の条件ごとの扱い。null は {@code FLAG}。 */
    public record Qc(QcMode smallRoi, QcMode lossy) {}

    /** 旗。{@code SMALL_ROI}＝強度マスクのボクセル数が基準値（要求の値、無ければ環境設定）より少ない。基準値が無ければ立たない。 */
    public static final String FLAG_SMALL_ROI = "SMALL_ROI";
    public static final String FLAG_LOSSY = "LOSSY_COMPRESSION";
    /** PET を、利用者の明示で SUV に校正せずに（Bq/mL のまま）計算した。 */
    public static final String FLAG_UNCALIBRATED_PT = "UNCALIBRATED_PT";

    /** 停止の種類。QC＝利用者の確認待ち、ENVIRONMENT＝IO・メモリの障害。 */
    public enum StopKind { QC, ENVIRONMENT }

    /**
     * @param pairs          利用者が確認した組。計算するのは {@code AUTO} と、元画像を選んだ {@code NEEDS_CONFIRMATION}
     * @param qc             QC の扱い。null は両方とも記録だけ
     * @param qcAcknowledged 許容した組のキー（{@link BatchPair#pairKey()}）。この組は QC で止めない
     * @param smallRoiWarnVoxels 小さい ROI の基準値（ボクセル数）。null は環境設定の値。{@code qc} とは別の項目
     *                       （試行は {@code qc} を送らないが、基準値は効かせる）
     * @param kind           抽出の種類。null・{@code radiomics}＝従来の特徴量抽出、{@code voiStats}＝一次統計だけ
     *                       （設定はフロントが一次統計の族だけを有効にして送る）
     * @param calibration    PET の校正（{@link RoiFeatureRequest#calibration}）。null は {@code auto}（PET を SUVbw に校正）。
     *                       VOI 統計は、{@code none}（Bq/mL のまま）の PET だけを断る
     * @param valueSpec      値の種類（{@link RoiFeatureRequest#valueSpec}）。null は従来（分類しない）。VOI 統計では使わない
     */
    public record BatchRequest(List<BatchPair> pairs, Map<String, String> settings,
                               Set<RoiFeatureRequest.RoiMode> roiModes, List<Double> scales, String scaleNotation,
                               List<String> scaleLabels, String scaleConversion, Double scaleCoefficient,
                               int channel, int timePoint, boolean recompute, Qc qc, List<String> qcAcknowledged,
                               Integer smallRoiWarnVoxels, String kind, String calibration,
                               ValueKind.Spec valueSpec, String planes) {
        /** 断面を指定しない（従来の要求。2D の単位は取得面だけ）。 */
        public BatchRequest(List<BatchPair> pairs, Map<String, String> settings,
                            Set<RoiFeatureRequest.RoiMode> roiModes, List<Double> scales, String scaleNotation,
                            List<String> scaleLabels, String scaleConversion, Double scaleCoefficient,
                            int channel, int timePoint, boolean recompute, Qc qc, List<String> qcAcknowledged,
                            Integer smallRoiWarnVoxels, String kind, String calibration, ValueKind.Spec valueSpec) {
            this(pairs, settings, roiModes, scales, scaleNotation, scaleLabels, scaleConversion, scaleCoefficient,
                    channel, timePoint, recompute, qc, qcAcknowledged, smallRoiWarnVoxels, kind, calibration,
                    valueSpec, null);
        }

        /** 値の種類を指定しない（従来の要求）。 */
        public BatchRequest(List<BatchPair> pairs, Map<String, String> settings,
                            Set<RoiFeatureRequest.RoiMode> roiModes, List<Double> scales, String scaleNotation,
                            List<String> scaleLabels, String scaleConversion, Double scaleCoefficient,
                            int channel, int timePoint, boolean recompute, Qc qc, List<String> qcAcknowledged,
                            Integer smallRoiWarnVoxels, String kind, String calibration) {
            this(pairs, settings, roiModes, scales, scaleNotation, scaleLabels, scaleConversion, scaleCoefficient,
                    channel, timePoint, recompute, qc, qcAcknowledged, smallRoiWarnVoxels, kind, calibration, null,
                    null);
        }

        /** PET の校正を指定しない（従来の要求。{@code auto}）。 */
        public BatchRequest(List<BatchPair> pairs, Map<String, String> settings,
                            Set<RoiFeatureRequest.RoiMode> roiModes, List<Double> scales, String scaleNotation,
                            List<String> scaleLabels, String scaleConversion, Double scaleCoefficient,
                            int channel, int timePoint, boolean recompute, Qc qc, List<String> qcAcknowledged,
                            Integer smallRoiWarnVoxels, String kind) {
            this(pairs, settings, roiModes, scales, scaleNotation, scaleLabels, scaleConversion, scaleCoefficient,
                    channel, timePoint, recompute, qc, qcAcknowledged, smallRoiWarnVoxels, kind, null);
        }

        /** 種類を指定しない（従来の要求）。 */
        public BatchRequest(List<BatchPair> pairs, Map<String, String> settings,
                            Set<RoiFeatureRequest.RoiMode> roiModes, List<Double> scales, String scaleNotation,
                            List<String> scaleLabels, String scaleConversion, Double scaleCoefficient,
                            int channel, int timePoint, boolean recompute, Qc qc, List<String> qcAcknowledged,
                            Integer smallRoiWarnVoxels) {
            this(pairs, settings, roiModes, scales, scaleNotation, scaleLabels, scaleConversion, scaleCoefficient,
                    channel, timePoint, recompute, qc, qcAcknowledged, smallRoiWarnVoxels, null);
        }

        /** QC を指定しない（従来の要求）。 */
        public BatchRequest(List<BatchPair> pairs, Map<String, String> settings,
                            Set<RoiFeatureRequest.RoiMode> roiModes, List<Double> scales, String scaleNotation,
                            List<String> scaleLabels, String scaleConversion, Double scaleCoefficient,
                            int channel, int timePoint, boolean recompute) {
            this(pairs, settings, roiModes, scales, scaleNotation, scaleLabels, scaleConversion, scaleCoefficient,
                    channel, timePoint, recompute, null, null, null);
        }
    }

    public record PlanRequest(Long albumId, List<String> studyUids) {}

    /** @param qcFlags 計算した組の QC の旗（{@link #FLAG_SMALL_ROI}・{@link #FLAG_LOSSY}）。常に記録する */
    public record PairStatus(int index, BatchPair pair, PairState state, FailureKind failureKind, String error,
                             boolean fromCache, long elapsedMs, List<String> qcFlags) {}

    /**
     * @param stopReason 止めた理由。QC なら旗の並び（{@code SMALL_ROI,LOSSY_COMPRESSION}）、環境障害ならそのメッセージ
     * @param stopKind   止めた種類。止まっていなければ null
     * @param stopIndex  止めた組の添字（{@code pairs} の中）。止まっていなければ null
     */
    public record Status(String jobId, JobState state, long elapsedMs, int total, int done, int failed, int skipped,
                         int notRun, int cancelled, int qcSkipped, String stopReason, StopKind stopKind, Integer stopIndex,
                         List<PairStatus> pairs) {}

    public record PairResult(int index, BatchPair pair, RoiFeatureResult result) {}

    public static final String KIND_RADIOMICS = "radiomics";
    public static final String KIND_VOI_STATS = "voiStats";

    /** 1 組の計算。本番は {@link RoiFeatureService#compute}、テストは差し替える。 */
    @FunctionalInterface
    interface Computer {
        RoiFeatureResult compute(RoiFeatureRequest req, BooleanSupplier cancelled) throws IOException;
    }

    private static final class Job {
        final String id;
        final List<BatchPair> pairs;
        final PairStatus[] status;
        final RoiFeatureResult[] results;
        volatile JobState state = JobState.QUEUED;
        volatile boolean cancelled;
        volatile long startedAt;
        volatile long finishedAt;
        volatile String stopReason;
        volatile StopKind stopKind;
        volatile Integer stopIndex;

        Job(String id, List<BatchPair> pairs) {
            this.id = id;
            this.pairs = pairs;
            this.status = new PairStatus[pairs.size()];
            this.results = new RoiFeatureResult[pairs.size()];
            for (int i = 0; i < pairs.size(); i++) {
                status[i] = new PairStatus(i, pairs.get(i), PairState.PENDING, null, null, false, 0, List.of());
            }
        }

        long elapsedMs() {
            if (startedAt == 0) {
                return 0;
            }
            return (finishedAt > 0 ? finishedAt : System.currentTimeMillis()) - startedAt;
        }

        Status toStatus() {
            // 終わりの状態は、組の更新がすべて済んだあとに最後に書かれる。**先に状態を読めば**、終わりと読めたときは
            // 組の更新がすべて見える（組を先に走査して、あとから状態を読むと、完了なのに最後の組が「実行中」のままの
            // 食い違った状態が返りうる）。
            JobState stateNow = state;
            int done = 0, failed = 0, skipped = 0, notRun = 0, cancelled = 0, qcSkipped = 0;
            List<PairStatus> list = new ArrayList<>(status.length);
            for (PairStatus p : status) {
                list.add(p);
                switch (p.state()) {
                    case DONE -> done++;
                    case FAILED -> failed++;
                    case SKIPPED -> skipped++;
                    case NOT_RUN -> notRun++;
                    case CANCELLED -> cancelled++;
                    case QC_SKIPPED -> qcSkipped++;
                    default -> { }
                }
            }
            return new Status(id, stateNow, elapsedMs(), status.length, done, failed, skipped, notRun, cancelled,
                    qcSkipped, stopReason, stopKind, stopIndex, list);
        }
    }

    private final Computer computer;
    private final Consumer<RoiFeatureRequest> checker;
    private final SegSourceResolver resolver;
    private final AlbumService albums;
    /** (スタディ UID, シリーズ UID) → Modality。null なら Modality の検査をしない（テスト用）。 */
    private final BiFunction<String, String, String> modalityOf;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "roi-feature-batch");
        t.setDaemon(true);
        return t;
    });

    @Autowired
    public RadiomicsBatchService(RoiFeatureService features, SegSourceResolver resolver, AlbumService albums) {
        this((req, cancelled) -> features.compute(req, phase -> { }, (done, total) -> { }, cancelled),
                features::check, resolver, albums, resolver::modalityOf);
    }

    RadiomicsBatchService(Computer computer, Consumer<RoiFeatureRequest> checker, SegSourceResolver resolver,
                          AlbumService albums) {
        this(computer, checker, resolver, albums, null);
    }

    RadiomicsBatchService(Computer computer, Consumer<RoiFeatureRequest> checker, SegSourceResolver resolver,
                          AlbumService albums, BiFunction<String, String, String> modalityOf) {
        this.computer = computer;
        this.checker = checker;
        this.resolver = resolver;
        this.albums = albums;
        this.modalityOf = modalityOf;
    }

    /** アルバムまたはスタディ UID の並びから、組の候補を作る。 */
    public List<BatchPair> plan(PlanRequest req) {
        List<String> studies;
        if (req.albumId() != null) {
            studies = albums.studies(req.albumId());
        } else if (req.studyUids() != null && !req.studyUids().isEmpty()) {
            studies = req.studyUids();
        } else {
            throw new IllegalArgumentException("albumId か studyUids のどちらかが必要です");
        }
        return resolver.resolve(studies);
    }

    /** 検査を通してから投入する。確認の済んでいない組・設定の誤り・web モードはここで例外になる。 */
    public Status submit(BatchRequest req) {
        if (req.pairs() == null || req.pairs().isEmpty()) {
            throw new IllegalArgumentException("組（pairs）が空です");
        }
        if (req.kind() != null && !KIND_RADIOMICS.equals(req.kind()) && !KIND_VOI_STATS.equals(req.kind())) {
            throw new IllegalArgumentException("kind は radiomics か voiStats です: " + req.kind());
        }
        RoiFeatureRequest first = null;
        for (int i = 0; i < req.pairs().size(); i++) {
            BatchPair p = req.pairs().get(i);
            if (p.status() == null) {
                throw new IllegalArgumentException("組 " + i + " の status がありません");
            }
            if (p.status() == BatchPair.Status.EXCLUDED) {
                continue;
            }
            if (isBlank(p.studyUid()) || isBlank(p.maskSeriesUid()) || p.maskChannel() < 0) {
                throw new IllegalArgumentException("組 " + i + " の studyUid・maskSeriesUid・maskChannel が不正です");
            }
            if (isBlank(p.sourceSeriesUid())) {
                throw new IllegalArgumentException("組 " + i + " は元画像シリーズが未確認です（選んでから送ってください）");
            }
            if (first == null) {
                first = toRequest(req, p);
            }
        }
        if (first != null) {
            checker.accept(first);
        }
        purgeOldJobs();
        Job job = new Job(UUID.randomUUID().toString(), List.copyOf(req.pairs()));
        jobs.put(job.id, job);
        log.info("[roi-batch] job {} queued: {} pairs", job.id, job.pairs.size());
        worker.submit(() -> run(job, req));
        return job.toStatus();
    }

    public Status get(String jobId) {
        Job job = jobs.get(jobId);
        return job != null ? job.toStatus() : null;
    }

    /** 計算済みの組の結果（値）。状態の取得には含めない。 */
    public List<PairResult> results(String jobId) {
        Job job = jobs.get(jobId);
        if (job == null) {
            return null;
        }
        List<PairResult> out = new ArrayList<>();
        for (int i = 0; i < job.results.length; i++) {
            RoiFeatureResult r = job.results[i];
            if (r != null && job.status[i].state() == PairState.DONE) { // QC_SKIPPED の値は返さない
                out.add(new PairResult(i, job.pairs.get(i), r));
            }
        }
        return out;
    }

    /** 次の組に進まなくする。走り出した 1 組は終わる（結果はキャッシュに入る）。 */
    public Status cancel(String jobId) {
        Job job = jobs.get(jobId);
        if (job == null) {
            return null;
        }
        job.cancelled = true;
        return job.toStatus();
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    private static RoiFeatureRequest toRequest(BatchRequest req, BatchPair p) {
        return new RoiFeatureRequest(p.studyUid(), p.sourceSeriesUid(), p.maskSeriesUid(), p.maskChannel(),
                req.channel(), req.timePoint(), req.settings(), req.recompute(), req.roiModes(), req.scales(),
                req.scaleNotation(), req.scaleLabels(), req.scaleConversion(), req.scaleCoefficient(),
                req.smallRoiWarnVoxels(), req.calibration(), req.valueSpec(), req.planes());
    }

    private void set(Job job, int i, PairState state, FailureKind kind, String error, boolean fromCache, long ms) {
        set(job, i, state, kind, error, fromCache, ms, List.of());
    }

    private void set(Job job, int i, PairState state, FailureKind kind, String error, boolean fromCache, long ms,
                     List<String> qcFlags) {
        job.status[i] = new PairStatus(i, job.pairs.get(i), state, kind, error, fromCache, ms, qcFlags);
    }

    /** 計算結果の QC の旗。基準値が未設定（{@code smallRoi} が null）なら小さい ROI は判定しない。 */
    static List<String> qcFlagsOf(RoiFeatureResult r) {
        List<String> flags = new ArrayList<>();
        RoiFeatureResult.RoiSize size = r.roiSize();
        if (size != null && Boolean.TRUE.equals(size.smallRoi())) {
            flags.add(FLAG_SMALL_ROI);
        }
        if (r.lossyCompressed()) {
            flags.add(FLAG_LOSSY);
        }
        if (r.provenance() != null && r.provenance().uncalibratedPet()) {
            flags.add(FLAG_UNCALIBRATED_PT);
        }
        if (r.provenance() != null && r.provenance().recordFlags() != null) {
            flags.addAll(r.provenance().recordFlags());
        }
        return flags;
    }

    /** QC の「スキップ」に当たったか（止める指定が先に効くので、止めるに当たったときは呼ばない）。 */
    private static boolean skipsOn(Qc qc, List<String> flags) {
        if (qc == null) {
            return false;
        }
        return (qc.smallRoi() == QcMode.SKIP && flags.contains(FLAG_SMALL_ROI))
                || (qc.lossy() == QcMode.SKIP && flags.contains(FLAG_LOSSY));
    }

    /** スキップの理由（結果の表の RowError に入る）。スキップの指定に当たった旗だけを書く。 */
    static String skipReason(Qc qc, RoiFeatureResult r, List<String> flags) {
        List<String> why = new ArrayList<>();
        if (qc.smallRoi() == QcMode.SKIP && flags.contains(FLAG_SMALL_ROI)) {
            RoiFeatureResult.RoiSize s = r.roiSize();
            why.add("小さい ROI（" + (s == null || s.intensityVoxels() == null ? "?" : s.intensityVoxels())
                    + " ボクセル ＜ 基準値 " + (s == null || s.smallRoiWarnVoxels() == null ? "?" : s.smallRoiWarnVoxels()) + "）");
        }
        if (qc.lossy() == QcMode.SKIP && flags.contains(FLAG_LOSSY)) {
            why.add("非可逆圧縮の画像");
        }
        return "QC でスキップ: " + String.join("、", why);
    }

    private static boolean stopsOn(Qc qc, List<String> flags) {
        if (qc == null) {
            return false;
        }
        return (qc.smallRoi() == QcMode.STOP && flags.contains(FLAG_SMALL_ROI))
                || (qc.lossy() == QcMode.STOP && flags.contains(FLAG_LOSSY));
    }

    private void run(Job job, BatchRequest req) {
        job.startedAt = System.currentTimeMillis();
        job.state = JobState.RUNNING;
        int n = job.pairs.size();
        try {
            for (int i = 0; i < n; i++) {
                BatchPair p = job.pairs.get(i);
                if (job.cancelled) {
                    for (int j = i; j < n; j++) {
                        set(job, j, PairState.CANCELLED, null, null, false, 0);
                    }
                    job.state = JobState.CANCELLED;
                    return;
                }
                if (p.status() == BatchPair.Status.EXCLUDED) {
                    set(job, i, PairState.SKIPPED, null, p.reason(), false, 0);
                    continue;
                }
                set(job, i, PairState.RUNNING, null, null, false, 0);
                long t0 = System.currentTimeMillis();
                try {
                    rejectUnsupportedModality(req, p);
                    RoiFeatureResult r = computer.compute(toRequest(req, p), () -> job.cancelled);
                    job.results[i] = r;
                    List<String> flags = qcFlagsOf(r);
                    set(job, i, PairState.DONE, null, null, r.fromCache(), System.currentTimeMillis() - t0, flags);
                    if (!flags.isEmpty() && stopsOn(req.qc(), flags)
                            && !acknowledged(req).contains(p.pairKey())) {
                        // 結果は残して止める。続けるときは、画面がこの組を許容して送り直す（計算済みの組はキャッシュに当たる）
                        stop(job, i + 1, n, String.join(",", flags), StopKind.QC, i);
                        log.info("[roi-batch] job {} stopped by QC at pair {}: {}", job.id, i, flags);
                        return;
                    }
                    if (!flags.isEmpty() && skipsOn(req.qc(), flags) && !acknowledged(req).contains(p.pairKey())) {
                        // 止めずに続ける。値は表に入れず、状態と理由を残す（黙って捨てない）。許容した組は飛ばさない
                        set(job, i, PairState.QC_SKIPPED, null, skipReason(req.qc(), r, flags), r.fromCache(),
                                System.currentTimeMillis() - t0, flags);
                        log.info("[roi-batch] job {} pair {} skipped by QC: {}", job.id, i, flags);
                    }
                } catch (CancellationException e) {
                    set(job, i, PairState.CANCELLED, null, null, false, System.currentTimeMillis() - t0);
                } catch (IllegalArgumentException e) {
                    set(job, i, PairState.FAILED, FailureKind.INPUT, message(e), false,
                            System.currentTimeMillis() - t0);
                    log.warn("[roi-batch] job {} pair {} rejected: {}", job.id, i, e.getMessage());
                } catch (IOException | OutOfMemoryError e) {
                    // 環境の障害。この組も残りも、失敗に書き換えずに止める
                    set(job, i, PairState.NOT_RUN, FailureKind.ENVIRONMENT, message(e), false,
                            System.currentTimeMillis() - t0);
                    stop(job, i + 1, n, message(e), StopKind.ENVIRONMENT, i);
                    log.error("[roi-batch] job {} stopped at pair {}", job.id, i, e);
                    return;
                } catch (RuntimeException e) {
                    set(job, i, PairState.FAILED, FailureKind.ENGINE, message(e), false,
                            System.currentTimeMillis() - t0);
                    log.error("[roi-batch] job {} pair {} failed", job.id, i, e);
                }
            }
            job.state = job.cancelled ? JobState.CANCELLED : JobState.DONE;
        } finally {
            job.finishedAt = System.currentTimeMillis();
        }
    }

    /**
     * VOI 統計は、PET を校正せずに（Bq/mL のまま、{@code calibration=none}）出す組を断る（保存値の単位を SUV と
     * 取り違えないため）。校正する（既定の {@code auto} を含む）なら、PET も出せる。
     */
    private void rejectUnsupportedModality(BatchRequest req, BatchPair p) {
        if (!KIND_VOI_STATS.equals(req.kind()) || modalityOf == null) {
            return;
        }
        if (RoiFeatureRequest.CALIBRATION_NONE.equalsIgnoreCase(req.calibration())
                && "PT".equals(modalityOf.apply(p.studyUid(), p.sourceSeriesUid()))) {
            throw new IllegalArgumentException(
                    "PET を校正せずに（Bq/mL のまま）VOI 統計は出しません。SUV に校正してください");
        }
    }

    private static Set<String> acknowledged(BatchRequest req) {
        return req.qcAcknowledged() == null ? Set.of() : Set.copyOf(req.qcAcknowledged());
    }

    private void stop(Job job, int from, int n, String reason, StopKind kind, int index) {
        for (int j = from; j < n; j++) {
            set(job, j, PairState.NOT_RUN, null, null, false, 0);
        }
        job.stopReason = reason;
        job.stopKind = kind;
        job.stopIndex = index;
        job.state = JobState.STOPPED;
    }

    private static String message(Throwable e) {
        return e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
    }

    private void purgeOldJobs() {
        long now = System.currentTimeMillis();
        List<Job> finished = new ArrayList<>();
        for (Job job : jobs.values()) {
            if (job.finishedAt == 0) {
                continue;
            }
            if (now - job.finishedAt > FINISHED_TTL_MS) {
                jobs.remove(job.id);
            } else {
                finished.add(job);
            }
        }
        if (finished.size() > MAX_FINISHED_JOBS) {
            finished.sort(Comparator.comparingLong(j -> j.finishedAt));
            for (int i = 0; i < finished.size() - MAX_FINISHED_JOBS; i++) {
                jobs.remove(finished.get(i).id);
            }
        }
    }
}

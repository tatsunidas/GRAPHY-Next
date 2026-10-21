/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.dicom.video.VideoRenderService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.dcm4che3.media.DicomDirWriter;
import org.dcm4che3.media.RecordFactory;
import org.dcm4che3.media.RecordType;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Set;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 選択されたシリーズを DICOM 交換メディア（PS3.10）形式の ZIP として書き出す。
 *
 * <p>構造: {@code DICOM/PAT00001/STU00001/SER00001/00000001} の階層（Flat なし）。
 * オプションで {@code DICOMDIR}（dcm4che {@link DicomDirWriter}）と {@code README.txt} を同梱する。
 * portable 2D viewer 同梱時は DICOMDIR を必須化する（起動時に DICOMDIR を探索して表示するため）。
 *
 * <p>原本ファイルはトランスコードせず<b>バイト列をそのままコピー</b>（可逆）。DICOMDIR の各レコードは
 * ヘッダ（ピクセル無し）から構築する。
 */
@Service
public class ExportService {

    private static final Logger log = LoggerFactory.getLogger(ExportService.class);

    /** エクスポート対象（スタディと、その中で選択されたシリーズ）。 */
    public record Selection(String studyUid, List<String> seriesUids) {}

    /** 同梱オプション。 */
    public record Options(boolean includeDicomDir, boolean includePortableViewer, boolean includeReadme) {
        /** portable viewer 同梱時は DICOMDIR を必須化。 */
        public boolean effectiveDicomDir() {
            return includeDicomDir || includePortableViewer;
        }

        /** エクスポートダイアログの規則: Viewer を同梱するときだけ DICOMDIR と README も付く。 */
        public static Options forViewer(boolean withViewer) {
            return new Options(withViewer, withViewer, withViewer);
        }
    }

    /**
     * encapsulated video の SOP クラス。この 3 つは 2D 画像として描けないので、portable viewer 用に
     * <b>再生できる MP4</b> を媒体へ同梱する（{@code VIDEO/{sop}.mp4}）。
     */
    private static final Set<String> VIDEO_SOP_CLASSES = Set.of(
            UID.VideoPhotographicImageStorage,
            UID.VideoEndoscopicImageStorage,
            UID.VideoMicroscopicImageStorage);

    /** 集計（README / レスポンス用）。 */
    public record Summary(int patients, int studies, int series, int instances) {}

    /** 書き出し結果（一時 ZIP パスと、含まれる患者 ID の一覧[挿入順]）。 */
    public record BuildResult(Path zip, List<String> patientIds) {}

    private final DicomInstanceRepository repo;
    /** 動画の MP4 化（P5: portable viewer は backend 非同伴なので媒体に MP4 実体を同梱する）。 */
    private final VideoRenderService videoRender;
    private final StorageLayout layout;
    /** シリーズの ZCT レイアウトの計算元（本体の 2D ビューアと同じ規則を、ポータブル版へそのまま渡すため）。 */
    private final DicomStorageService storage;

    public ExportService(DicomInstanceRepository repo, VideoRenderService videoRender, StorageLayout layout,
            DicomStorageService storage) {
        this.repo = repo;
        this.videoRender = videoRender;
        this.layout = layout;
        this.storage = storage;
    }

    /** 書き出し先（ZIP のエントリ、またはフォルダ配下のファイル）。 */
    public interface Sink extends AutoCloseable {
        void put(String name, java.io.InputStream in) throws IOException;

        default void put(String name, Path file) throws IOException {
            try (java.io.InputStream in = Files.newInputStream(file)) {
                put(name, in);
            }
        }

        default void put(String name, byte[] bytes) throws IOException {
            put(name, new java.io.ByteArrayInputStream(bytes));
        }

        @Override
        void close() throws IOException;
    }

    /** ZIP への書き出し。 */
    public static final class ZipSink implements Sink {
        private final ZipOutputStream zip;

        public ZipSink(ZipOutputStream zip) {
            this.zip = zip;
        }

        @Override
        public void put(String name, java.io.InputStream in) throws IOException {
            zip.putNextEntry(new ZipEntry(name));
            in.transferTo(zip);
            zip.closeEntry();
        }

        @Override
        public void close() throws IOException {
            zip.close();
        }
    }

    /** フォルダへの書き出し。ルートの外へ出る名前は拒否する。 */
    public static final class DirSink implements Sink {
        private final Path root;

        public DirSink(Path root) throws IOException {
            this.root = Files.createDirectories(root).toAbsolutePath().normalize();
        }

        @Override
        public void put(String name, java.io.InputStream in) throws IOException {
            Path target = root.resolve(name).normalize();
            if (!target.startsWith(root) || target.equals(root)) {
                throw new IOException("出力先の外を指す名前です: " + name);
            }
            Files.createDirectories(target.getParent());
            Files.copy(in, target);
            String n = target.getFileName().toString();
            if (n.endsWith(".sh") || n.endsWith(".command") || n.endsWith(".pl")) {
                target.toFile().setExecutable(true, false); // Mac/Linux で直接実行できるように（ベストエフォート）
            }
        }

        @Override
        public void close() {
            // 何も持たない
        }
    }

    /** 進捗と中止（{@code ImportService.Progress} と同じ流儀）。 */
    public static class Progress {
        private volatile boolean cancelled;
        private volatile long total = -1;
        private final java.util.concurrent.atomic.AtomicLong processed = new java.util.concurrent.atomic.AtomicLong();

        public void cancel() {
            cancelled = true;
        }

        public boolean isCancelled() {
            return cancelled;
        }

        public long total() {
            return total;
        }

        public void setTotal(long n) {
            total = n;
        }

        public long processed() {
            return processed.get();
        }

        void advance() {
            processed.incrementAndGet();
        }
    }

    /** 中止で書き出しを打ち切ったことを呼び出し側へ伝える。 */
    public static final class CancelledException extends RuntimeException {
        public CancelledException() {
            super("cancelled", null, false, false);
        }
    }

    /** 書き出した内容（含まれる患者 ID は挿入順）。 */
    public record BuildInfo(List<String> patientIds, Summary summary) {}

    /** 選択に含まれるインスタンスの総数（進捗の分母）。 */
    @Transactional(readOnly = true)
    public long countInstances(List<Selection> selections) {
        long n = 0;
        for (Selection sel : selections) {
            if (sel == null || sel.studyUid() == null || sel.seriesUids() == null) {
                continue;
            }
            for (String seriesUid : sel.seriesUids()) {
                n += repo.findBySeries(sel.studyUid(), seriesUid).size();
            }
        }
        return n;
    }

    /** 選択に含まれる患者 ID（挿入順・空は除く）。出力名の決定に使う。 */
    @Transactional(readOnly = true)
    public List<String> patientIds(List<Selection> selections) {
        java.util.Set<String> ids = new java.util.LinkedHashSet<>();
        for (Selection sel : selections) {
            if (sel == null || sel.studyUid() == null || sel.seriesUids() == null) {
                continue;
            }
            for (String seriesUid : sel.seriesUids()) {
                List<DicomInstance> insts = repo.findBySeries(sel.studyUid(), seriesUid);
                if (!insts.isEmpty() && insts.get(0).getPatientId() != null && !insts.get(0).getPatientId().isEmpty()) {
                    ids.add(insts.get(0).getPatientId());
                }
            }
        }
        return new java.util.ArrayList<>(ids);
    }

    /** 選択に含まれる原本ファイルの合計バイト数（空き容量の見積り用）。 */
    @Transactional(readOnly = true)
    public long estimateBytes(List<Selection> selections) {
        long n = 0;
        for (Selection sel : selections) {
            if (sel == null || sel.studyUid() == null || sel.seriesUids() == null) {
                continue;
            }
            for (String seriesUid : sel.seriesUids()) {
                for (DicomInstance inst : repo.findBySeries(sel.studyUid(), seriesUid)) {
                    Path src = resolveFile(inst);
                    try {
                        if (src != null) {
                            n += Files.size(src);
                        }
                    } catch (IOException ignore) {
                        // 見積りなので読めないものは数えない
                    }
                }
            }
        }
        return n;
    }

    /**
     * 一時 ZIP ファイルを生成し、パスと含まれる患者 ID（挿入順）を返す
     * （呼び出し側がストリーム後に ZIP を削除する）。
     */
    public BuildResult buildZip(List<Selection> selections, Options opts) throws IOException {
        Path zipPath = Files.createTempFile("graphy-export-", ".zip");
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(zipPath));
                Sink sink = new ZipSink(zip)) {
            BuildInfo info = write(selections, opts, sink, new Progress());
            return new BuildResult(zipPath, info.patientIds());
        } catch (IOException | RuntimeException e) {
            Files.deleteIfExists(zipPath);
            throw e;
        }
    }

    /**
     * 選択シリーズを {@code sink} へ書く。階層は {@code DICOM/<患者>/<検査>/<シリーズ>/<連番>}。
     * 中止されたら {@link CancelledException}（書きかけの後始末は呼び出し側）。
     */
    @Transactional(readOnly = true)
    public BuildInfo write(List<Selection> selections, Options opts, Sink sink, Progress progress) throws IOException {
        boolean withDicomDir = opts.effectiveDicomDir();
        Path work = Files.createTempDirectory("graphy-export-");

        DicomDirWriter dir = null;
        RecordFactory rf = null;
        Path dicomdirFile = work.resolve("DICOMDIR");
        if (withDicomDir) {
            DicomDirWriter.createEmptyDirectory(dicomdirFile.toFile(), "GRAPHY_EXP", null, null, null);
            dir = DicomDirWriter.open(dicomdirFile.toFile());
            rf = new RecordFactory();
            rf.loadDefaultConfiguration();
        }

        // 可読フォルダ名の割り当て（患者=PatientID / 検査=検査日 / シリーズ=Description）。
        Layout layout = new Layout();
        java.util.Set<String> patientIds = new java.util.LinkedHashSet<>();
        java.util.Set<String> studyUidsExported = new java.util.LinkedHashSet<>();
        int seriesCount = 0;
        int instanceCount = 0;
        List<String[]> exportedSeries = new java.util.ArrayList<>(); // {studyUid, seriesUid}

        try {
            for (Selection sel : selections) {
                if (sel == null || sel.studyUid() == null || sel.seriesUids() == null) {
                    continue;
                }
                for (String seriesUid : sel.seriesUids()) {
                    List<DicomInstance> insts = repo.findBySeries(sel.studyUid(), seriesUid);
                    if (insts.isEmpty()) {
                        continue;
                    }
                    String patDir = null;
                    String styDir = null;
                    String serDir = null; // 最初の解決済みインスタンスで確定（可読名はヘッダ依存）
                    int img = 0;
                    for (DicomInstance inst : insts) {
                        if (progress.isCancelled()) {
                            throw new CancelledException();
                        }
                        Path src = resolveFile(inst);
                        if (src == null) {
                            progress.advance();
                            continue;
                        }
                        Attributes fmi;
                        Attributes ds;
                        try (DicomInputStream in = new DicomInputStream(src.toFile())) {
                            in.setIncludeBulkData(IncludeBulkData.NO);
                            fmi = in.readFileMetaInformation();
                            ds = in.readDatasetUntilPixelData();
                        } catch (IOException e) {
                            log.warn("export: header 読取失敗 {}", inst.getSopInstanceUid(), e);
                            progress.advance();
                            continue;
                        }

                        if (serDir == null) {
                            String pid = inst.getPatientId() == null ? "" : inst.getPatientId();
                            if (!pid.isEmpty()) {
                                patientIds.add(pid);
                            }
                            patDir = layout.patient(pid);
                            styDir = layout.study(sel.studyUid(), patDir, inst);
                            studyUidsExported.add(sel.studyUid());
                            serDir = layout.series(patDir, styDir, inst, ds.getString(Tag.ProtocolName));
                            seriesCount++;
                            exportedSeries.add(new String[] {sel.studyUid(), seriesUid});
                        }
                        String imgName = ExportNaming.imageName(++img);
                        String[] fileIDs = {"DICOM", patDir, styDir, serDir, imgName};
                        sink.put(String.join("/", fileIDs), src);
                        instanceCount++;

                        if (dir != null) {
                            addDirRecords(dir, rf, ds, fmi, fileIDs);
                        }

                        // 動画は portable viewer が DICOM のままでは再生できない（backend 非同伴で
                        // /rendered が使えない）ため、再生可能な MP4 を VIDEO/{sop}.mp4 として同梱する。
                        if (opts.includePortableViewer()
                                && VIDEO_SOP_CLASSES.contains(ds.getString(Tag.SOPClassUID, ""))) {
                            copyPlayableVideo(sink, src, inst.getSopInstanceUid());
                        }
                        progress.advance();
                    }
                }
            }

            if (dir != null) {
                dir.commit();
                dir.close();
                dir = null;
                sink.put("DICOMDIR", dicomdirFile);
            }

            if (opts.includePortableViewer()) {
                copyPortableViewer(sink);
                writeLayouts(sink, exportedSeries);
            }

            Summary summary = new Summary(layout.patDir.size(), studyUidsExported.size(), seriesCount, instanceCount);
            if (opts.includeReadme()) {
                sink.put("README.txt", readme(opts, summary).getBytes(StandardCharsets.UTF_8));
            }
            return new BuildInfo(new java.util.ArrayList<>(patientIds), summary);
        } finally {
            if (dir != null) {
                try {
                    dir.close();
                } catch (IOException ignore) {
                    // ベストエフォート
                }
            }
            deleteRecursively(work);
        }
    }

    /**
     * 1 回の Export 内で可読フォルダ名を一意に割り当てる補助（Spring シングルトンに状態を持たせないため
     * buildZip 呼び出しごとにインスタンス化する）。
     */
    static final class Layout {
        final Map<String, String> patDir = new LinkedHashMap<>();
        private final Map<String, String> styDir = new java.util.HashMap<>();
        private final java.util.Set<String> usedRoot = new java.util.HashSet<>();
        private final Map<String, java.util.Set<String>> usedStudyByPatient = new java.util.HashMap<>();
        private final Map<String, java.util.Set<String>> usedSeriesByStudy = new java.util.HashMap<>();

        /** PatientID → 患者フォルダ名（ルート直下で一意）。 */
        String patient(String pid) {
            String existing = patDir.get(pid);
            if (existing != null) {
                return existing;
            }
            String name = ExportNaming.unique(ExportNaming.safeName(pid, "NoPatientID"), usedRoot);
            patDir.put(pid, name);
            return name;
        }

        /** StudyInstanceUID → 検査フォルダ名（検査日。患者フォルダ内で一意）。 */
        String study(String studyUid, String patientDir, DicomInstance inst) {
            String existing = styDir.get(studyUid);
            if (existing != null) {
                return existing;
            }
            java.util.Set<String> used = usedStudyByPatient.computeIfAbsent(patientDir, k -> new java.util.HashSet<>());
            String base = ExportNaming.formatStudyDate(inst.getStudyDate());
            if (base == null) {
                base = ExportNaming.safeName(inst.getStudyDescription(), "NoDate");
            }
            String name = ExportNaming.unique(base, used);
            styDir.put(studyUid, name);
            return name;
        }

        /** シリーズフォルダ名（SeriesDescription→ProtocolName→Series番号。検査フォルダ内で一意）。 */
        String series(String patientDir, String studyDir, DicomInstance inst, String protocolName) {
            java.util.Set<String> used = usedSeriesByStudy.computeIfAbsent(patientDir + "/" + studyDir, k -> new java.util.HashSet<>());
            String desc = firstNonBlank(inst.getSeriesDescription(), protocolName);
            if (desc == null) {
                Integer sn = inst.getSeriesNumber();
                desc = "Series" + (sn != null ? sn : (inst.getModality() == null ? "" : inst.getModality()));
            }
            return ExportNaming.unique(ExportNaming.safeName(desc, "Series"), used);
        }

        private static String firstNonBlank(String a, String b) {
            if (a != null && !a.isBlank()) {
                return a;
            }
            if (b != null && !b.isBlank()) {
                return b;
            }
            return null;
        }
    }

    static void addDirRecords(DicomDirWriter dir, RecordFactory rf, Attributes ds, Attributes fmi, String[] fileIDs)
            throws IOException {
        Attributes patRec = dir.findOrAddPatientRecord(rf.createRecord(RecordType.PATIENT, null, ds, fmi, null));
        Attributes styRec = dir.findOrAddStudyRecord(patRec, rf.createRecord(RecordType.STUDY, null, ds, fmi, null));
        Attributes serRec = dir.findOrAddSeriesRecord(styRec, rf.createRecord(RecordType.SERIES, null, ds, fmi, null));
        dir.addLowerDirectoryRecord(serRec, rf.createRecord(ds, fmi, fileIDs));
    }

    private Path resolveFile(DicomInstance inst) {
        return layout.resolveForRead(inst);
    }

    /**
     * classpath の {@code portable-viewer/**}（ビルド時に frontend/portable-dist から同梱）を
     * ZIP の {@code VIEWER/} 以下へ書き出す。成果物が同梱されていない（frontend.skip 等）場合は
     * 警告のみで Export 自体は継続する（DICOMDIR は既に出力済みで他ビューアからは読める）。
     */
    /**
     * 動画インスタンスを <b>再生可能な MP4</b> にして {@code VIDEO/{sop}.mp4} へ同梱する。
     *
     * <p>portable viewer は backend 非同伴（{@code file://}）で {@code /rendered} が使えないため、
     * 媒体の中に MP4 実体が要る。変換は配信と同じ {@link VideoRenderService}（MP4 はそのまま／
     * H.264・HEVC の基本ストリームは remux／MPEG2 等は再エンコード）を通すので、モダリティ由来の
     * 動画も同梱できる。ffmpeg が無い等で作れない場合は<b>警告だけ出して Export は続行</b>する
     * （DICOM 本体は既に書き出しており、他ビューアでは開けるため）。
     *
     * @return 同梱できたら true
     */
    boolean copyPlayableVideo(ZipOutputStream zip, Path src, String sopUid) {
        return copyPlayableVideo(new ZipSink(zip), src, sopUid);
    }

    boolean copyPlayableVideo(Sink sink, Path src, String sopUid) {
        try {
            Path mp4 = videoRender.ensureRendered(src, sopUid);
            sink.put("VIDEO/" + sopUid + ".mp4", mp4);
            return true;
        } catch (IOException e) {
            log.warn("export: 動画の MP4 同梱に失敗しました（DICOM 本体のみ同梱） sop={}: {}", sopUid, e.toString());
            return false;
        }
    }

    static void copyPortableViewer(ZipOutputStream zip) throws IOException {
        copyPortableViewer(new ZipSink(zip));
    }

    static void copyPortableViewer(Sink sink) throws IOException {
        copyPortableViewer(sink, "classpath*:/portable-viewer/**");
    }

    /** @param pattern 成果物の探索パターン（本番は固定。成果物が無い場合の試験のために引数にしてある）。 */
    static void copyPortableViewer(Sink sink, String pattern) throws IOException {
        var resolver = new org.springframework.core.io.support.PathMatchingResourcePatternResolver();
        org.springframework.core.io.Resource[] resources;
        try {
            resources = resolver.getResources(pattern);
        } catch (IOException e) {
            log.warn("export: portable viewer 成果物の列挙に失敗（同梱をスキップ）", e);
            return;
        }
        int copied = 0;
        // ⚠ 同じ相対パスが classpath 上に 2 つ現れることがある（例: 実ビルド成果物の
        // target/classes/portable-viewer と、テスト用フィクスチャの target/test-classes/portable-viewer）。
        // 素直に書くと ZipException("duplicate entry") で **Export 全体が落ちる**ので、先勝ちで重複を捨てる。
        java.util.Set<String> written = new java.util.HashSet<>();
        for (org.springframework.core.io.Resource res : resources) {
            if (!res.isReadable()) {
                continue; // ディレクトリエントリなど
            }
            String url = res.getURL().toString();
            int idx = url.indexOf("portable-viewer/");
            if (idx < 0) {
                continue;
            }
            String rel = url.substring(idx + "portable-viewer/".length());
            if (rel.isEmpty() || rel.endsWith("/")) {
                continue;
            }
            if (!written.add(rel)) {
                log.debug("export: portable viewer の重複エントリを無視: {}", rel);
                continue;
            }
            try (java.io.InputStream in = res.getInputStream()) {
                sink.put("VIEWER/" + rel, in);
            }
            copied++;
        }
        if (copied == 0) {
            // 黙って省くと、利用者は「同梱にチェックしたのにビューアが無い」媒体を受け取る（2026-10-21 の実機で発生）。
            // 同梱を頼まれたのに作れないときは、Export ごと失敗させて理由を画面に出す。
            log.error("export: portable viewer 成果物が classpath:/portable-viewer に見つかりません");
            throw new IOException("2D Viewer (portable) の成果物がこのアプリに入っていません。"
                    + "（ビューアの成果物を含まないビルドです。同梱のチェックを外して実行してください）"
                    + " / The portable viewer bundle is not part of this build. Uncheck the option and retry.");
        } else {
            copyPortableLauncher(sink);
            log.info("export: portable viewer を同梱しました（{} ファイル＋起動スクリプト）", copied);
        }
    }

    /**
     * 各シリーズのレイアウト（Z/C/T の割当・軸・位置・間隔）を {@code VIEWER/layouts.json} へ書く。
     * 本体の 2D ビューアが使う backend の計算結果そのもので、ポータブル版は同じ並び・軸で表示できる
     * （ブラウザ側に同じ規則を二重に持たない）。失敗したシリーズは載せない（ビューアがヘッダから組み直す）。
     */
    void writeLayouts(Sink sink, List<String[]> series) throws IOException {
        if (storage == null) {
            return;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        // 穴（ある C/T が覆わない Z 位置）を埋める空白画像。本体は backend が都度作るが、ポータブル版には backend が
        // 無いので、同じ生成（storage.blankDicom）の結果を媒体へ書いておく。{seriesUid: [{z, file}]}（z=null は位置なし）。
        Map<String, List<Map<String, Object>>> blanks = new LinkedHashMap<>();
        for (String[] s : series) {
            try {
                com.vis.graphynext.dicom.SeriesLayout lay = storage.seriesLayout(s[0], s[1]);
                out.put(s[1], lay);
                writeBlanks(sink, s[0], s[1], lay, blanks);
            } catch (RuntimeException e) {
                log.warn("export: レイアウトの計算に失敗（ビューア側で組み直す） series={}", s[1], e);
            }
        }
        com.fasterxml.jackson.databind.ObjectMapper om = new com.fasterxml.jackson.databind.ObjectMapper();
        sink.put("VIEWER/layouts.json", om.writeValueAsBytes(out));
        sink.put("VIEWER/blanks.json", om.writeValueAsBytes(blanks));
    }

    /** Z 方向のスタックで欠けているスライス位置ごとに、空白の DICOM を {@code VIEWER/blank/<series>/<z>.dcm} へ書く。 */
    private void writeBlanks(Sink sink, String studyUid, String seriesUid, com.vis.graphynext.dicom.SeriesLayout lay,
            Map<String, List<Map<String, Object>>> blanks) throws IOException {
        if (lay == null || lay.cells() == null || (lay.axes() != null && "t".equals(lay.axes().stackAxis()))) {
            return; // 時間軸スタック（XA など）はブランクを挟まない
        }
        java.util.Set<String> have = new java.util.HashSet<>();
        for (com.vis.graphynext.dicom.SeriesLayout.Cell c : lay.cells()) {
            have.add(c.c() + "/" + c.t() + "/" + c.z());
        }
        java.util.Set<Integer> gapZ = new java.util.TreeSet<>();
        for (int c = 0; c < lay.nC(); c++) {
            for (int t = 0; t < lay.nT(); t++) {
                for (int z = 0; z < lay.nZ(); z++) {
                    if (!have.contains(c + "/" + t + "/" + z)) {
                        gapZ.add(z);
                    }
                }
            }
        }
        if (gapZ.isEmpty()) {
            return;
        }
        List<Map<String, Object>> list = new java.util.ArrayList<>();
        for (int z : gapZ) {
            double[] ipp = null;
            if (lay.zSpatial() != null) {
                for (com.vis.graphynext.dicom.SeriesLayout.ZSpatial zs : lay.zSpatial()) {
                    if (zs.z() == z) {
                        ipp = zs.imagePositionPatient();
                    }
                }
            }
            byte[] bytes = storage.blankDicom(studyUid, seriesUid, ipp);
            if (bytes == null) {
                continue;
            }
            String file = "blank/" + seriesUid + "/" + z + ".dcm";
            sink.put("VIEWER/" + file, bytes);
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("z", ipp == null ? null : z);
            e.put("file", file);
            list.add(e);
            if (ipp == null) {
                break; // 位置なしの空白は 1 枚を共有する
            }
        }
        if (!list.isEmpty()) {
            blanks.put(seriesUid, list);
        }
    }

    /** 媒体のルートに置く起動ファイル（ダブルクリックでローカルサーバを起動し、ブラウザでビューアを開く）。 */
    static final String[] LAUNCHER_ROOT_FILES = {"START-VIEWER.bat", "START-VIEWER.command", "START-VIEWER.sh", "START-VIEWER.html"};
    /** 起動ファイルが使うサーバ本体（VIEWER/ に置く）。 */
    static final String[] LAUNCHER_VIEWER_FILES = {"serve.ps1", "serve.pl"};

    /**
     * 起動スクリプト（{@code portable-launcher/}。ソースに入っていて frontend のビルドに依らない）を書き出す。
     * 無いのはパッケージングの不具合なので、黙らずに失敗させる。
     */
    static void copyPortableLauncher(Sink sink) throws IOException {
        for (String name : LAUNCHER_ROOT_FILES) {
            putLauncherResource(sink, name, name);
        }
        for (String name : LAUNCHER_VIEWER_FILES) {
            putLauncherResource(sink, "VIEWER/" + name, name);
        }
    }

    private static void putLauncherResource(Sink sink, String target, String resourceName) throws IOException {
        try (java.io.InputStream in = ExportService.class.getResourceAsStream("/portable-launcher/" + resourceName)) {
            if (in == null) {
                throw new IOException("起動スクリプトが同梱されていません: portable-launcher/" + resourceName);
            }
            sink.put(target, in);
        }
    }

    /**
     * 媒体のルートに置く README.txt。受け取る人が読む文章なので、日本語を先、同じ内容の英語を後に置く。
     * 起動方法・DICOM の場所・非診断の注意・署名の 4 点を、短く書く。
     */
    static String readme(Options opts, Summary s) {
        boolean viewer = opts.includePortableViewer();
        StringBuilder sb = new StringBuilder();

        sb.append("GRAPHY DICOM Export（画像の書き出し）\n");
        sb.append("======================================\n\n");

        // ---------------- 日本語 ----------------
        sb.append("■ このフォルダの中身\n");
        sb.append("  患者 ").append(s.patients()).append(" 名／検査 ").append(s.studies())
                .append(" 件／シリーズ ").append(s.series()).append(" 件／画像 ").append(s.instances()).append(" 枚\n\n");

        sb.append("■ DICOM ファイルの場所\n");
        sb.append("  画像は「DICOM」フォルダの中にあります。\n");
        sb.append("    DICOM/患者ID/検査日/シリーズ名/00000001.dcm …\n");
        if (opts.effectiveDicomDir()) {
            sb.append("  いちばん上の「DICOMDIR」は、画像の一覧表です。他の DICOM ビューアで開くときは、このファイルを選びます。\n");
        }
        sb.append('\n');

        if (viewer) {
            sb.append("■ 画像の見かた（付属のビューア・インストール不要）\n");
            sb.append("  1. このフォルダにある起動ファイルを実行します。\n");
            sb.append("       Windows … START-VIEWER.bat をダブルクリック\n");
            sb.append("       Mac     … START-VIEWER.command をダブルクリック（開けないときは右クリック →「開く」）\n");
            sb.append("       Linux   … ターミナルで sh START-VIEWER.sh\n");
            sb.append("  2. ブラウザが開き、画像が自動で表示されます。\n");
            sb.append("  （START-VIEWER.html を開くと、お使いの PC に合った手順が表示されます。）\n");
            sb.append("  3. 終わるときは、黒い画面（起動ファイルの窓）を閉じます。\n");
            sb.append("  ・画像はこの PC の外へは送られません。\n");
            sb.append("  ・VIEWER フォルダの index.html を直接開いても動きません。上の起動ファイルを使ってください。\n");
            sb.append("  ・動画がある場合は、VIDEO フォルダに再生用の MP4 も入っています。\n\n");
        }

        sb.append("■ ご注意（非診断用）\n");
        if (viewer) {
            sb.append("  この付属ビューアは、診断や治療方針の決定を目的としたものではありません（非診断用）。\n");
            sb.append("  画像の参照・共有のための表示です。診断には、承認・認証を受けた医療機器または診断用ビューアと、\n");
            sb.append("  元の画像をお使いください。\n\n");
        } else {
            sb.append("  この書き出しは、画像の参照・共有を目的としたものであり、診断や治療方針の決定を目的としたものではありません\n");
            sb.append("  （非診断用）。診断には、承認・認証を受けた医療機器または診断用ビューアと、元の画像をお使いください。\n\n");
        }

        // ---------------- English ----------------
        sb.append("--------------------------------------\n");
        sb.append("English\n");
        sb.append("--------------------------------------\n\n");

        sb.append("* Contents\n");
        sb.append("  ").append(s.patients()).append(" patient(s), ").append(s.studies()).append(" study(ies), ")
                .append(s.series()).append(" series, ").append(s.instances()).append(" image(s)\n\n");

        sb.append("* Where the DICOM files are\n");
        sb.append("  The images are in the \"DICOM\" folder:\n");
        sb.append("    DICOM/<PatientID>/<StudyDate>/<SeriesDescription>/00000001.dcm ...\n");
        if (opts.effectiveDicomDir()) {
            sb.append("  \"DICOMDIR\" at the top is the index of the images. Select it when opening this media in another DICOM viewer.\n");
        }
        sb.append('\n');

        if (viewer) {
            sb.append("* How to view the images (bundled viewer, no installation needed)\n");
            sb.append("  1. Run the launcher in this folder:\n");
            sb.append("       Windows : double-click START-VIEWER.bat\n");
            sb.append("       Mac     : double-click START-VIEWER.command (if it does not open: right-click > Open)\n");
            sb.append("       Linux   : run \"sh START-VIEWER.sh\" in a terminal\n");
            sb.append("  2. Your browser opens and shows the images automatically.\n");
            sb.append("  (Open START-VIEWER.html to see the steps that fit your computer.)\n");
            sb.append("  3. To finish, close the black launcher window.\n");
            sb.append("  - Images are never sent outside this computer.\n");
            sb.append("  - Opening VIEWER/index.html directly does not work. Please use the launcher above.\n");
            sb.append("  - Videos (if any) are also included as playable MP4 files in the VIDEO folder.\n\n");
        }

        sb.append("* Notice (not for diagnostic use)\n");
        if (viewer) {
            sb.append("  This bundled viewer is not intended for diagnosis or for deciding treatment (not for diagnostic use).\n");
            sb.append("  It is provided for reviewing and sharing images. For diagnosis, please use an approved or certified\n");
            sb.append("  medical device or diagnostic viewer together with the original images.\n\n");
        } else {
            sb.append("  This export is provided for reviewing and sharing images. It is not intended for diagnosis or for deciding\n");
            sb.append("  treatment (not for diagnostic use). For diagnosis, please use an approved or certified medical device or\n");
            sb.append("  diagnostic viewer together with the original images.\n\n");
        }

        sb.append("======================================\n");
        sb.append("Exported by GRAPHY\n");
        sb.append("Visionary Imaging Services, Inc.\n");
        return sb.toString();
    }

    private static void deleteRecursively(Path dir) {
        try (var stream = Files.walk(dir)) {
            stream.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignore) {
                    // ベストエフォート
                }
            });
        } catch (IOException ignore) {
            // ベストエフォート
        }
    }

    /** 書き出した一時 ZIP をストリーム後に削除する補助。 */
    public void streamAndDelete(Path zip, OutputStream out) throws IOException {
        try {
            Files.copy(zip, out);
        } finally {
            Files.deleteIfExists(zip);
        }
    }
}

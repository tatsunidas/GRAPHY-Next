/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
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
    }

    /** 集計（README / レスポンス用）。 */
    public record Summary(int patients, int studies, int series, int instances) {}

    /** 書き出し結果（一時 ZIP パスと、含まれる患者 ID の一覧[挿入順]）。 */
    public record BuildResult(Path zip, List<String> patientIds) {}

    private final DicomInstanceRepository repo;

    public ExportService(DicomInstanceRepository repo) {
        this.repo = repo;
    }

    /**
     * 一時 ZIP ファイルを生成し、パスと含まれる患者 ID（挿入順）を返す
     * （呼び出し側がストリーム後に ZIP を削除する）。
     */
    @Transactional(readOnly = true)
    public BuildResult buildZip(List<Selection> selections, Options opts) throws IOException {
        boolean withDicomDir = opts.effectiveDicomDir();
        Path work = Files.createTempDirectory("graphy-export-");
        Path zipPath = Files.createTempFile("graphy-export-", ".zip");

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

        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(zipPath))) {
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
                        Path src = resolveFile(inst);
                        if (src == null) {
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
                        }
                        String imgName = ExportNaming.imageName(++img);
                        String[] fileIDs = {"DICOM", patDir, styDir, serDir, imgName};
                        String entryPath = String.join("/", fileIDs);

                        zip.putNextEntry(new ZipEntry(entryPath));
                        Files.copy(src, zip);
                        zip.closeEntry();
                        instanceCount++;

                        if (dir != null) {
                            addDirRecords(dir, rf, ds, fmi, fileIDs);
                        }
                    }
                }
            }

            if (dir != null) {
                dir.commit();
                dir.close();
                dir = null;
                zip.putNextEntry(new ZipEntry("DICOMDIR"));
                Files.copy(dicomdirFile, zip);
                zip.closeEntry();
            }

            if (opts.includePortableViewer()) {
                copyPortableViewer(zip);
            }

            Summary summary = new Summary(layout.patDir.size(), studyUidsExported.size(), seriesCount, instanceCount);
            if (opts.includeReadme()) {
                zip.putNextEntry(new ZipEntry("README.txt"));
                zip.write(readme(opts, summary).getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
            }
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
        return new BuildResult(zipPath, new java.util.ArrayList<>(patientIds));
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
        String uri = inst.getUri();
        if (uri == null || !uri.startsWith("file:")) {
            return null;
        }
        Path p = Path.of(java.net.URI.create(uri));
        return Files.exists(p) ? p : null;
    }

    /**
     * classpath の {@code portable-viewer/**}（ビルド時に frontend/portable-dist から同梱）を
     * ZIP の {@code VIEWER/} 以下へ書き出す。成果物が同梱されていない（frontend.skip 等）場合は
     * 警告のみで Export 自体は継続する（DICOMDIR は既に出力済みで他ビューアからは読める）。
     */
    static void copyPortableViewer(ZipOutputStream zip) throws IOException {
        var resolver = new org.springframework.core.io.support.PathMatchingResourcePatternResolver();
        org.springframework.core.io.Resource[] resources;
        try {
            resources = resolver.getResources("classpath*:/portable-viewer/**");
        } catch (IOException e) {
            log.warn("export: portable viewer 成果物の列挙に失敗（同梱をスキップ）", e);
            return;
        }
        int copied = 0;
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
            zip.putNextEntry(new ZipEntry("VIEWER/" + rel));
            try (java.io.InputStream in = res.getInputStream()) {
                in.transferTo(zip);
            }
            zip.closeEntry();
            copied++;
        }
        if (copied == 0) {
            log.warn("export: portable viewer 成果物が classpath:/portable-viewer に見つかりません（VIEWER/ 同梱なし）");
        } else {
            log.info("export: portable viewer を同梱しました（{} ファイル）", copied);
        }
    }

    private static String readme(Options opts, Summary s) {
        StringBuilder sb = new StringBuilder();
        sb.append("GRAPHY DICOM Export\n");
        sb.append("===================\n\n");
        sb.append("Contents / 内容:\n");
        sb.append("  Patients/患者:   ").append(s.patients()).append('\n');
        sb.append("  Studies/検査:    ").append(s.studies()).append('\n');
        sb.append("  Series/シリーズ: ").append(s.series()).append('\n');
        sb.append("  Images/画像:     ").append(s.instances()).append("\n\n");
        sb.append("Layout / 構成:\n");
        sb.append("  DICOM/<PatientID>/<StudyDate>/<SeriesDescription>/00000001.dcm ...\n");
        sb.append("  例 DICOM/PID-0001/2026-06-30/CT Chest/00000001.dcm\n");
        sb.append("  (Patient > Study > Series > Image hierarchy)\n\n");
        if (opts.effectiveDicomDir()) {
            sb.append("DICOMDIR:\n");
            sb.append("  A DICOMDIR index is included at the root. Most DICOM viewers can\n");
            sb.append("  open this media by selecting the DICOMDIR file.\n");
            sb.append("  ルートの DICOMDIR を読み込むと一覧表示できます。\n\n");
        }
        if (opts.includePortableViewer()) {
            sb.append("Portable 2D Viewer (VIEWER/):\n");
            sb.append("  A standalone GRAPHY 2D Viewer is bundled under VIEWER/.\n");
            sb.append("  1) Open VIEWER/index.html in a Chromium-based browser (Chrome/Edge).\n");
            sb.append("  2) Click 'Select folder' and choose the root folder of this media\n");
            sb.append("     (the folder that contains DICOMDIR and DICOM/).\n");
            sb.append("  3) Pick a series from the list to view it (window/level, scroll, zoom).\n");
            sb.append("  No installation or server is required.\n");
            sb.append("  付属の 2D Viewer は VIEWER/index.html を Chromium 系ブラウザで開き、\n");
            sb.append("  「フォルダを選択」でこのメディアのルート（DICOMDIR を含む）を選ぶと表示できます。\n\n");
        }
        sb.append("Exported by GRAPHY (Visionary Imaging Services, Inc.)\n");
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

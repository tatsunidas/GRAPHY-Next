/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import org.dcm4che3.data.Attributes;
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

    private final DicomInstanceRepository repo;

    public ExportService(DicomInstanceRepository repo) {
        this.repo = repo;
    }

    /**
     * 一時 ZIP ファイルを生成してそのパスを返す（呼び出し側がストリーム後に削除する）。
     */
    @Transactional(readOnly = true)
    public Path buildZip(List<Selection> selections, Options opts) throws IOException {
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

        // 階層ディレクトリ名の割り当て（PatientID/StudyUID/SeriesUID 単位で一意）
        Map<String, String> patDirByPid = new LinkedHashMap<>();
        Map<String, String> styDirByUid = new LinkedHashMap<>();
        int[] counters = new int[3]; // [pat, study, series]
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
                    String serDir = MediaNaming.dirName("SER", ++counters[2]);
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

                        String pid = inst.getPatientId() == null ? "" : inst.getPatientId();
                        String patDir = patDirByPid.computeIfAbsent(pid, k -> MediaNaming.dirName("PAT", ++counters[0]));
                        String styDir = styDirByUid.computeIfAbsent(sel.studyUid(), k -> MediaNaming.dirName("STU", ++counters[1]));
                        String imgName = MediaNaming.imageName(++img);
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

            Summary summary = new Summary(patDirByPid.size(), styDirByUid.size(), counters[2], instanceCount);
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
        return zipPath;
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

    private static String readme(Options opts, Summary s) {
        StringBuilder sb = new StringBuilder();
        sb.append("GRAPHY DICOM Export\n");
        sb.append("===================\n\n");
        sb.append("Contents / 内容:\n");
        sb.append("  Patients/患者:   ").append(s.patients()).append('\n');
        sb.append("  Studies/検査:    ").append(s.studies()).append('\n');
        sb.append("  Series/シリーズ: ").append(s.series()).append('\n');
        sb.append("  Images/画像:     ").append(s.instances()).append("\n\n");
        sb.append("Layout / 構成 (PS3.10):\n");
        sb.append("  DICOM/PATxxxxx/STUxxxxx/SERxxxxx/00000001 ...\n");
        sb.append("  (Patient > Study > Series > Image hierarchy; no extension)\n\n");
        if (opts.effectiveDicomDir()) {
            sb.append("DICOMDIR:\n");
            sb.append("  A DICOMDIR index is included at the root. Most DICOM viewers can\n");
            sb.append("  open this media by selecting the DICOMDIR file.\n");
            sb.append("  ルートの DICOMDIR を読み込むと一覧表示できます。\n\n");
        }
        if (opts.includePortableViewer()) {
            sb.append("Portable 2D Viewer:\n");
            sb.append("  A portable GRAPHY 2D Viewer is intended to ship with this media and\n");
            sb.append("  auto-load the DICOMDIR on launch. (See fw/export-portable-viewer.md)\n");
            sb.append("  付属の 2D Viewer は起動時に DICOMDIR を探索して表示します。\n\n");
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

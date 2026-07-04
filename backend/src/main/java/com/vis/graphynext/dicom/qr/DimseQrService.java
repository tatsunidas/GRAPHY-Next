/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.StudyDto;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * standalone の Query/Retrieve。dcm4che CLI ツールを起動して解決する。
 *
 * <ul>
 *   <li>C-GET: {@code getscu} で一時ディレクトリへ取得し、{@link DicomStorageService} に取り込む。</li>
 *   <li>C-MOVE: {@code movescu --dest <自局AE>} で、リモート PACS から自前 SCP へ送らせる
 *       （受信は稼働中の SCP が索引へ取り込む）。</li>
 * </ul>
 */
@Service
public class DimseQrService {

    private static final Logger log = LoggerFactory.getLogger(DimseQrService.class);

    private static final long TOOL_TIMEOUT_MS = 120_000;

    /** STUDY レベル C-FIND の返却キー。 */
    private static final List<String> STUDY_RETURN_KEYS = List.of(
            "StudyInstanceUID", "PatientID", "PatientName", "StudyDate", "StudyDescription",
            "ModalitiesInStudy", "NumberOfStudyRelatedInstances");

    /** QR ウィンドウ STUDY 行用の返却キー（基本＋生年月日/性別/受付番号/シリーズ数）。 */
    private static final List<String> QR_STUDY_RETURN_KEYS = List.of(
            "StudyInstanceUID", "PatientID", "PatientName", "PatientBirthDate", "PatientSex",
            "StudyDate", "StudyDescription", "AccessionNumber", "ModalitiesInStudy",
            "NumberOfStudyRelatedSeries", "NumberOfStudyRelatedInstances");

    /** SERIES レベル C-FIND の返却キー。 */
    private static final List<String> SERIES_RETURN_KEYS = List.of(
            "SeriesInstanceUID", "Modality", "SeriesNumber", "SeriesDescription",
            "ProtocolName", "NumberOfSeriesRelatedInstances");

    private final Dcm4cheTools tools;
    private final DicomStorageService storage;
    private final com.vis.graphynext.dicom.DicomLocalAeService localAe;
    private final com.vis.graphynext.dicom.DicomTlsService tlsService;

    public DimseQrService(Dcm4cheTools tools, DicomStorageService storage,
                          com.vis.graphynext.dicom.DicomLocalAeService localAe,
                          com.vis.graphynext.dicom.DicomTlsService tlsService) {
        this.tools = tools;
        this.storage = storage;
        this.localAe = localAe;
        this.tlsService = tlsService;
    }

    /**
     * C-FIND（STUDY レベル）で外部 PACS をクエリし、マッチしたスタディ一覧を返す。
     *
     * @param matchKeys 絞り込みキー（例: PatientID=..., StudyDate=...）。空なら全件。
     */
    public List<StudyDto> findStudies(String host, int port, String calledAet, Map<String, String> matchKeys,
                                      boolean tls) throws IOException {
        Path tool = tools.require("findscu");
        Path outDir = Files.createTempDirectory("graphy-findscu-");
        List<String> cmd = new ArrayList<>(List.of(
                tool.toString(),
                "-b", localAe.aeTitle(),
                "-c", calledAet + "@" + host + ":" + port,
                "-L", "STUDY"));
        for (String key : STUDY_RETURN_KEYS) {
            cmd.add("-r");
            cmd.add(key);
        }
        if (matchKeys != null) {
            matchKeys.forEach((k, v) -> {
                cmd.add("-m");
                cmd.add(k + "=" + v);
            });
        }
        cmd.add("--out-dir");
        cmd.add(outDir.toString());
        cmd.add("--out-file");
        cmd.add("rsp-0000.dcm");
        cmd.addAll(tlsArgs(tls));

        Dcm4cheTools.Result r = tools.run(cmd, TOOL_TIMEOUT_MS);
        if (!r.ok()) {
            throw new IOException("findscu 失敗 (exit=" + r.exitCode() + "): " + tail(r.output()));
        }
        List<StudyDto> studies = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(outDir)) {
            List<Path> files = walk.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(".dcm")).toList();
            for (Path f : files) {
                try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                    Attributes a = in.readDataset();
                    studies.add(new StudyDto(
                            a.getString(Tag.StudyInstanceUID),
                            a.getString(Tag.PatientID),
                            a.getString(Tag.PatientName),
                            a.getString(Tag.StudyDate),
                            a.getString(Tag.StudyDescription),
                            a.getString(Tag.ModalitiesInStudy),
                            a.getInt(Tag.NumberOfStudyRelatedInstances, 0)));
                } catch (Exception e) {
                    log.warn("C-FIND 応答のパースに失敗: {} ({})", f, e.toString());
                }
            }
        } finally {
            deleteQuietly(outDir);
        }
        log.info("C-FIND 完了: {} 件", studies.size());
        return studies;
    }

    /**
     * C-GET で study を取得し、取得した各インスタンスをローカル索引へ取り込む。
     *
     * @return 取り込んだインスタンス数
     */
    public int getStudy(String host, int port, String calledAet, String studyUid, boolean tls) throws IOException {
        Path tool = tools.require("getscu");
        Path outDir = Files.createTempDirectory("graphy-getscu-");
        List<String> cmd = new ArrayList<>(List.of(
                tool.toString(),
                "-b", localAe.aeTitle(),
                "-c", calledAet + "@" + host + ":" + port,
                "-L", "STUDY",
                "-m", "StudyInstanceUID=" + studyUid,
                "--directory", outDir.toString()));
        cmd.addAll(tlsArgs(tls));
        Dcm4cheTools.Result r = tools.run(cmd, TOOL_TIMEOUT_MS);
        if (!r.ok()) {
            throw new IOException("getscu 失敗 (exit=" + r.exitCode() + "): " + tail(r.output()));
        }
        int count = 0;
        try (Stream<Path> walk = Files.walk(outDir)) {
            List<Path> files = walk.filter(Files::isRegularFile).toList();
            for (Path f : files) {
                try {
                    storage.ingest(f);
                    count++;
                } catch (Exception e) {
                    log.warn("取得ファイルの取り込みに失敗: {} ({})", f, e.toString());
                }
            }
        } finally {
            deleteQuietly(outDir);
        }
        log.info("C-GET 完了: study={} 取り込み {} 件", studyUid, count);
        return count;
    }

    /**
     * C-MOVE で study を移動先 AE へ送らせる。destAet を自局 AE にすれば自前 SCP が受信して索引化する。
     *
     * @return movescu の終了コード（0 で成功）
     */
    public int moveStudy(String host, int port, String calledAet, String studyUid, String destAet, boolean tls)
            throws IOException {
        Path tool = tools.require("movescu");
        List<String> cmd = new ArrayList<>(List.of(
                tool.toString(),
                "-b", localAe.aeTitle(),
                "-c", calledAet + "@" + host + ":" + port,
                "--dest", destAet,
                "-L", "STUDY",
                "-m", "StudyInstanceUID=" + studyUid));
        cmd.addAll(tlsArgs(tls));
        Dcm4cheTools.Result r = tools.run(cmd, TOOL_TIMEOUT_MS);
        if (!r.ok()) {
            throw new IOException("movescu 失敗 (exit=" + r.exitCode() + "): " + tail(r.output()));
        }
        log.info("C-MOVE 完了: study={} -> dest={}", studyUid, destAet);
        return r.exitCode();
    }

    /**
     * QR ウィンドウ用 STUDY レベル C-FIND。{@link #findStudies} より多くの属性（生年月日/性別/受付番号/
     * シリーズ数）を返す。
     */
    public List<QrStudyRow> findStudiesForQr(String host, int port, String calledAet, Map<String, String> matchKeys,
                                             boolean tls) throws IOException {
        Path tool = tools.require("findscu");
        Path outDir = Files.createTempDirectory("graphy-qr-find-");
        List<String> cmd = new ArrayList<>(List.of(
                tool.toString(),
                "-b", localAe.aeTitle(),
                "-c", calledAet + "@" + host + ":" + port,
                "-L", "STUDY"));
        for (String key : QR_STUDY_RETURN_KEYS) {
            cmd.add("-r");
            cmd.add(key);
        }
        if (matchKeys != null) {
            matchKeys.forEach((k, v) -> {
                cmd.add("-m");
                cmd.add(k + "=" + v);
            });
        }
        cmd.add("--out-dir");
        cmd.add(outDir.toString());
        cmd.add("--out-file");
        cmd.add("rsp-0000.dcm");
        cmd.addAll(tlsArgs(tls));

        Dcm4cheTools.Result r = tools.run(cmd, TOOL_TIMEOUT_MS);
        if (!r.ok()) {
            deleteQuietly(outDir);
            throw new IOException("findscu(STUDY) 失敗 (exit=" + r.exitCode() + "): " + tail(r.output()));
        }
        List<QrStudyRow> rows = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(outDir)) {
            List<Path> files = walk.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(".dcm")).toList();
            for (Path f : files) {
                try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                    Attributes a = in.readDataset();
                    rows.add(new QrStudyRow(
                            a.getString(Tag.StudyInstanceUID),
                            a.getString(Tag.PatientID),
                            a.getString(Tag.PatientName),
                            a.getString(Tag.PatientBirthDate),
                            a.getString(Tag.PatientSex),
                            a.getString(Tag.StudyDate),
                            a.getString(Tag.StudyDescription),
                            a.getString(Tag.AccessionNumber),
                            a.getString(Tag.ModalitiesInStudy),
                            a.getInt(Tag.NumberOfStudyRelatedSeries, 0),
                            a.getInt(Tag.NumberOfStudyRelatedInstances, 0)));
                } catch (Exception e) {
                    log.warn("C-FIND(STUDY) 応答のパースに失敗: {} ({})", f, e.toString());
                }
            }
        } finally {
            deleteQuietly(outDir);
        }
        log.info("QR C-FIND(STUDY) 完了: {} 件 ({}@{}:{})", rows.size(), calledAet, host, port);
        return rows;
    }

    /** SERIES レベル C-FIND。指定スタディ内のシリーズ一覧を返す。 */
    public List<QrSeriesRow> findSeries(String host, int port, String calledAet, String studyUid,
                                        Map<String, String> matchKeys, boolean tls) throws IOException {
        Path tool = tools.require("findscu");
        Path outDir = Files.createTempDirectory("graphy-qr-findse-");
        List<String> cmd = new ArrayList<>(List.of(
                tool.toString(),
                "-b", localAe.aeTitle(),
                "-c", calledAet + "@" + host + ":" + port,
                "-L", "SERIES",
                "-m", "StudyInstanceUID=" + studyUid));
        for (String key : SERIES_RETURN_KEYS) {
            cmd.add("-r");
            cmd.add(key);
        }
        if (matchKeys != null) {
            matchKeys.forEach((k, v) -> {
                cmd.add("-m");
                cmd.add(k + "=" + v);
            });
        }
        cmd.add("--out-dir");
        cmd.add(outDir.toString());
        cmd.add("--out-file");
        cmd.add("rsp-0000.dcm");
        cmd.addAll(tlsArgs(tls));

        Dcm4cheTools.Result r = tools.run(cmd, TOOL_TIMEOUT_MS);
        if (!r.ok()) {
            deleteQuietly(outDir);
            throw new IOException("findscu(SERIES) 失敗 (exit=" + r.exitCode() + "): " + tail(r.output()));
        }
        List<QrSeriesRow> rows = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(outDir)) {
            List<Path> files = walk.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(".dcm")).toList();
            for (Path f : files) {
                try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                    Attributes a = in.readDataset();
                    rows.add(new QrSeriesRow(
                            a.getString(Tag.SeriesInstanceUID),
                            a.getString(Tag.Modality),
                            a.contains(Tag.SeriesNumber) ? a.getInt(Tag.SeriesNumber, 0) : null,
                            a.getString(Tag.SeriesDescription),
                            a.getString(Tag.ProtocolName),
                            a.getInt(Tag.NumberOfSeriesRelatedInstances, 0)));
                } catch (Exception e) {
                    log.warn("C-FIND(SERIES) 応答のパースに失敗: {} ({})", f, e.toString());
                }
            }
        } finally {
            deleteQuietly(outDir);
        }
        rows.sort(java.util.Comparator.comparing(s -> s.seriesNumber() == null ? Integer.MAX_VALUE : s.seriesNumber()));
        log.info("QR C-FIND(SERIES) 完了: study={} {} 件", studyUid, rows.size());
        return rows;
    }

    /**
     * C-MOVE で<b>シリーズ単位</b>を移動先 AE へ送らせる（{@link #moveStudy} のシリーズ版）。
     * destAet を自局 AE にすれば自前 SCP が受信して索引化する。
     *
     * @return movescu の終了コード（0 で成功）
     */
    public int moveSeries(String host, int port, String calledAet, String studyUid, String seriesUid, String destAet,
                          boolean tls) throws IOException {
        Path tool = tools.require("movescu");
        List<String> cmd = new ArrayList<>(List.of(
                tool.toString(),
                "-b", localAe.aeTitle(),
                "-c", calledAet + "@" + host + ":" + port,
                "--dest", destAet,
                "-L", "SERIES",
                "-m", "StudyInstanceUID=" + studyUid,
                "-m", "SeriesInstanceUID=" + seriesUid));
        cmd.addAll(tlsArgs(tls));
        Dcm4cheTools.Result r = tools.run(cmd, TOOL_TIMEOUT_MS);
        if (!r.ok()) {
            throw new IOException("movescu(SERIES) 失敗 (exit=" + r.exitCode() + "): " + tail(r.output()));
        }
        log.info("C-MOVE(SERIES) 完了: study={} series={} -> dest={}", studyUid, seriesUid, destAet);
        return r.exitCode();
    }

    /**
     * ノードが TLS 指定かつ自局のグローバル TLS 設定が揃っているとき、findscu/getscu/movescu 用の
     * TLS 引数（鍵/信頼ストア + cipher/protocol）を返す。{@code useTls=false} や設定不備なら空。
     */
    private List<String> tlsArgs(boolean useTls) {
        DicomProperties.Tls tls = tlsService.effective();
        if (!useTls || !tls.isUsable()) {
            return List.of();
        }
        List<String> a = new ArrayList<>();
        a.add("--key-store");
        a.add(tls.getKeyStore());
        a.add("--key-store-pass");
        a.add(tls.getKeyStorePassword());
        a.add("--key-store-type");
        a.add(tls.getKeyStoreType());
        a.add("--key-pass");
        a.add(tls.getKeyStorePassword());
        a.add("--trust-store");
        a.add(tls.getTrustStore());
        a.add("--trust-store-pass");
        a.add(tls.getTrustStorePassword());
        a.add("--trust-store-type");
        a.add(tls.getTrustStoreType());
        for (String c : tls.getCipherSuites()) {
            a.add("--tls-cipher");
            a.add(c);
        }
        for (String p : tls.getProtocols()) {
            a.add("--tls-protocol");
            a.add(p);
        }
        return a;
    }

    private static String tail(String s) {
        if (s == null) {
            return "";
        }
        return s.length() <= 800 ? s : s.substring(s.length() - 800);
    }

    private static void deleteQuietly(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted((a, b) -> b.getNameCount() - a.getNameCount()).forEach(p -> {
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
}

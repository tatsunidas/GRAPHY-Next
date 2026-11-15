/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import com.vis.graphynext.dicom.DicomController;
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

    /** PATIENT レベル C-FIND（Patient Root）の返却キー。 */
    private static final List<String> PATIENT_RETURN_KEYS = List.of(
            "PatientID", "PatientName", "PatientBirthDate", "PatientSex");

    /** SERIES レベル C-FIND の返却キー。 */
    private static final List<String> SERIES_RETURN_KEYS = List.of(
            "SeriesInstanceUID", "Modality", "SeriesNumber", "SeriesDescription",
            "ProtocolName", "NumberOfSeriesRelatedInstances");

    private final Dcm4cheTools tools;
    private final com.vis.graphynext.dicom.DicomRemoteAeService remoteAes;
    private final DicomStorageService storage;
    private final com.vis.graphynext.dicom.DicomLocalAeService localAe;
    private final com.vis.graphynext.dicom.DicomTlsService tlsService;
    private final org.springframework.beans.factory.ObjectProvider<com.vis.graphynext.anonymize.ReceiveAnonymizer> anonymizer;
    private final org.springframework.beans.factory.ObjectProvider<com.vis.graphynext.dicom.store.ReceiveCompressor> compressor;

    public DimseQrService(Dcm4cheTools tools, com.vis.graphynext.dicom.DicomRemoteAeService remoteAes,
                          DicomStorageService storage,
                          com.vis.graphynext.dicom.DicomLocalAeService localAe,
                          com.vis.graphynext.dicom.DicomTlsService tlsService,
                          org.springframework.beans.factory.ObjectProvider<com.vis.graphynext.anonymize.ReceiveAnonymizer> anonymizer,
                          org.springframework.beans.factory.ObjectProvider<com.vis.graphynext.dicom.store.ReceiveCompressor> compressor) {
        this.tools = tools;
        this.remoteAes = remoteAes;
        this.storage = storage;
        this.localAe = localAe;
        this.tlsService = tlsService;
        this.anonymizer = anonymizer;
        this.compressor = compressor;
    }

    /**
     * C-FIND（STUDY レベル）で外部 PACS をクエリし、マッチしたスタディ一覧を返す。
     *
     * @param matchKeys 絞り込みキー（例: PatientID=..., StudyDate=...）。空なら全件。
     */
    public List<StudyDto> findStudies(String host, int port, String calledAet, Map<String, String> matchKeys,
                                      boolean tls) throws IOException {
        FindProfile profile = profileFor(calledAet, host, port);
        Path outDir = execFind("findscu", "STUDY", host, port, calledAet, profile, null,
                profile.studyKeysOr(STUDY_RETURN_KEYS), matchKeys, tls, "graphy-findscu-");
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
        return getStudy(host, port, calledAet, studyUid, tls, TOOL_TIMEOUT_MS);
    }

    /** {@link #getStudy(String, int, String, String, boolean)} のタイムアウト指定版（事前取得は大きな検査を扱う）。 */
    public int getStudy(String host, int port, String calledAet, String studyUid, boolean tls, long timeoutMs)
            throws IOException {
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
        Dcm4cheTools.Result r = tools.run(cmd, timeoutMs);
        if (!r.ok()) {
            throw new IOException("getscu 失敗 (exit=" + r.exitCode() + "): " + tail(r.output()));
        }
        int count = 0;
        try (Stream<Path> walk = Files.walk(outDir)) {
            List<Path> files = walk.filter(Files::isRegularFile).toList();
            for (Path f : files) {
                try {
                    // 受信時の匿名化がオンなら、C-STORE と同じく保管前に匿名化する（拒否・失敗したものは取り込まない）。
                    var anon = anonymizer.getIfAvailable();
                    Path toIngest = anon == null ? f : anon.process(f, calledAet);
                    var comp = compressor.getIfAvailable();
                    if (comp != null) {
                        toIngest = comp.process(toIngest); // 匿名化の後に 1 回だけ。失敗・対象外は元のまま
                    }
                    storage.ingest(toIngest);
                    count++;
                } catch (Exception e) {
                    log.warn("取得ファイルの取り込みに失敗: {} ({})", f.getFileName(), e.getClass().getSimpleName());
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
        return moveStudy(host, port, calledAet, studyUid, destAet, tls, TOOL_TIMEOUT_MS);
    }

    /** {@link #moveStudy(String, int, String, String, String, boolean)} のタイムアウト指定版。 */
    public int moveStudy(String host, int port, String calledAet, String studyUid, String destAet, boolean tls,
                         long timeoutMs) throws IOException {
        Path tool = tools.require("movescu");
        List<String> cmd = new ArrayList<>(List.of(
                tool.toString(),
                "-b", localAe.aeTitle(),
                "-c", calledAet + "@" + host + ":" + port,
                "--dest", destAet,
                "-L", "STUDY",
                "-m", "StudyInstanceUID=" + studyUid));
        cmd.addAll(tlsArgs(tls));
        Dcm4cheTools.Result r = tools.run(cmd, timeoutMs);
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
        return findStudiesForQr(host, port, calledAet, matchKeys, tls, profileFor(calledAet, host, port));
    }

    /**
     * 通信先の検索方式（{@link FindProfile}）を明示した版。Patient Root の通信先では、患者 ID が無いとき
     * 先に PATIENT 段で患者を引き、患者ごとに STUDY 段を引く（Patient Root は PATIENT 段から入る方式）。
     */
    public List<QrStudyRow> findStudiesForQr(String host, int port, String calledAet, Map<String, String> matchKeys,
                                             boolean tls, FindProfile profile) throws IOException {
        FindProfile p = FindProfile.orDefault(profile);
        Map<String, String> mk = matchKeys == null ? Map.of() : matchKeys;
        if (p.patientRoot() && !mk.containsKey("PatientID")) {
            Map<String, String> patientMatch = new java.util.LinkedHashMap<>();
            mk.forEach((k, v) -> {
                if ("PatientName".equals(k)) {
                    patientMatch.put(k, v);
                }
            });
            List<String> ids = findPatientIds(host, port, calledAet, patientMatch, tls, p);
            List<QrStudyRow> all = new ArrayList<>();
            for (String id : ids) {
                Map<String, String> m = new java.util.LinkedHashMap<>(mk);
                m.put("PatientID", id);
                all.addAll(queryStudyRows(host, port, calledAet, m, tls, p));
            }
            log.info("QR C-FIND(PATIENT→STUDY) 完了: 患者 {} 人・{} 件 ({}@{}:{})",
                    ids.size(), all.size(), calledAet, host, port);
            return all;
        }
        return queryStudyRows(host, port, calledAet, mk, tls, p);
    }

    /** PATIENT 段の C-FIND（Patient Root）。患者 ID の一覧を返す。 */
    private List<String> findPatientIds(String host, int port, String calledAet, Map<String, String> matchKeys,
                                        boolean tls, FindProfile p) throws IOException {
        Path outDir = execFind("findscu(PATIENT)", "PATIENT", host, port, calledAet, p, null,
                p.patientKeysOr(PATIENT_RETURN_KEYS), matchKeys, tls, "graphy-qr-findpt-");
        List<String> ids = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(outDir)) {
            for (Path f : walk.filter(Files::isRegularFile)
                    .filter(x -> x.getFileName().toString().endsWith(".dcm")).toList()) {
                try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                    String id = in.readDataset().getString(Tag.PatientID);
                    if (id != null && !id.isBlank() && !ids.contains(id)) {
                        ids.add(id);
                    }
                } catch (Exception e) {
                    log.warn("C-FIND(PATIENT) 応答のパースに失敗: {} ({})", f, e.toString());
                }
            }
        } finally {
            deleteQuietly(outDir);
        }
        return ids;
    }

    private List<QrStudyRow> queryStudyRows(String host, int port, String calledAet, Map<String, String> matchKeys,
                                            boolean tls, FindProfile profile) throws IOException {
        Path outDir = execFind("findscu(STUDY)", "STUDY", host, port, calledAet, profile, null,
                profile.studyKeysOr(QR_STUDY_RETURN_KEYS), matchKeys, tls, "graphy-qr-find-");
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

    /** 予約（Modality Worklist）1 件。必要な属性だけ。 */
    public record WorklistEntry(String patientId, String scheduledDate, String modality, String stationAet) {
    }

    /**
     * Modality Worklist の C-FIND（findscu -M MWL）。指定日（YYYYMMDD）に予約された項目を返す。
     * {@code stationAet}・{@code modality} が null か空なら絞らない。
     */
    public List<WorklistEntry> findWorklist(String host, int port, String calledAet, String day, String stationAet,
                                            String modality, boolean tls) throws IOException {
        Path tool = tools.require("findscu");
        Path outDir = Files.createTempDirectory("graphy-mwl-");
        List<String> cmd = new ArrayList<>(List.of(
                tool.toString(),
                "-b", localAe.aeTitle(),
                "-c", calledAet + "@" + host + ":" + port,
                "-M", "MWL",
                "-r", "00100020",
                "-m", "00400100.00400002=" + day,
                "-r", "00400100.00080060",
                "-r", "00400100.00400001"));
        if (stationAet != null && !stationAet.isBlank()) {
            cmd.add("-m");
            cmd.add("00400100.00400001=" + stationAet.trim());
        }
        if (modality != null && !modality.isBlank()) {
            cmd.add("-m");
            cmd.add("00400100.00080060=" + modality.trim());
        }
        cmd.add("--out-dir");
        cmd.add(outDir.toString());
        cmd.add("--out-file");
        cmd.add("rsp-0000.dcm");
        cmd.addAll(tlsArgs(tls));
        Dcm4cheTools.Result r;
        try {
            r = tools.run(cmd, TOOL_TIMEOUT_MS);
        } catch (IOException e) {
            deleteQuietly(outDir);
            throw e;
        }
        if (!r.ok()) {
            deleteQuietly(outDir);
            throw new IOException("findscu(MWL) 失敗 (exit=" + r.exitCode() + "): " + tail(r.output()));
        }
        List<WorklistEntry> out = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(outDir)) {
            for (Path f : walk.filter(Files::isRegularFile).filter(p -> p.getFileName().toString().endsWith(".dcm")).toList()) {
                try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                    Attributes a = in.readDataset();
                    Attributes sps = a.getNestedDataset(Tag.ScheduledProcedureStepSequence);
                    out.add(new WorklistEntry(
                            a.getString(Tag.PatientID),
                            sps == null ? null : sps.getString(Tag.ScheduledProcedureStepStartDate),
                            sps == null ? null : sps.getString(Tag.Modality),
                            sps == null ? null : sps.getString(Tag.ScheduledStationAETitle)));
                } catch (Exception e) {
                    log.warn("C-FIND(MWL) 応答のパースに失敗: {} ({})", f, e.getClass().getSimpleName());
                }
            }
        } finally {
            deleteQuietly(outDir);
        }
        log.info("MWL C-FIND 完了: {} 件 ({}@{}:{})", out.size(), calledAet, host, port);
        return out;
    }

    /** SERIES レベル C-FIND。指定スタディ内のシリーズ一覧を返す。 */
    public List<QrSeriesRow> findSeries(String host, int port, String calledAet, String studyUid,
                                        Map<String, String> matchKeys, boolean tls) throws IOException {
        FindProfile profile = profileFor(calledAet, host, port);
        Path outDir = execFind("findscu(SERIES)", "SERIES", host, port, calledAet, profile,
                Map.of("StudyInstanceUID", studyUid), profile.seriesKeysOr(SERIES_RETURN_KEYS), matchKeys, tls,
                "graphy-qr-findse-");
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

    /** 通信先（AE タイトル・ホスト・ポートが一致する登録）の検索方式。登録が無い・未指定なら既定。 */
    FindProfile profileFor(String calledAet, String host, int port) {
        return remoteAes.list().stream()
                .filter(a -> a.aeTitle().equals(calledAet) && a.port() == port
                        && java.util.Objects.equals(a.host(), host))
                .map(DicomController.RemoteAeDto::find).filter(java.util.Objects::nonNull)
                .findFirst().orElse(FindProfile.DEFAULT);
    }

    /**
     * findscu を実行し、相手の返事を読んで成功のときだけ出力ディレクトリを返す。
     * 🔴 終了コード 0 でも、相手がエラーの status を返していれば失敗にする（0 件と取り違えない）。
     */
    private Path execFind(String what, String level, String host, int port, String calledAet, FindProfile profile,
                          Map<String, String> leadingMatch, List<String> returnKeys, Map<String, String> matchKeys,
                          boolean tls, String tmpPrefix) throws IOException {
        Path tool = tools.require("findscu");
        Path outDir = Files.createTempDirectory(tmpPrefix);
        List<String> cmd = FindArgs.build(tool.toString(), localAe.aeTitle(), calledAet, host, port, level,
                profile, leadingMatch, returnKeys, matchKeys, outDir.toString(), tlsArgs(tls));
        Dcm4cheTools.Result r;
        try {
            r = tools.run(cmd, TOOL_TIMEOUT_MS);
        } catch (IOException e) {
            deleteQuietly(outDir);
            if (e.getMessage() != null && e.getMessage().contains("タイムアウト")) {
                throw new QrFindException(what, new DimseOutcome(DimseOutcome.Kind.TIMEOUT, null, null, null), null);
            }
            throw e;
        }
        DimseOutcome outcome = DimseOutcome.parse(r.exitCode(), r.output());
        if (!outcome.ok()) {
            deleteQuietly(outDir);
            throw new QrFindException(what, outcome, DimseOutcome.evidence(r.output()));
        }
        return outDir;
    }

    /**
     * ノードが TLS 指定かつ自局のグローバル TLS 設定が揃っているとき、findscu/getscu/movescu 用の
     * TLS 引数（鍵/信頼ストア + cipher/protocol）を返す。{@code useTls=false} や設定不備なら空。
     */
    List<String> tlsArgs(boolean useTls) {
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

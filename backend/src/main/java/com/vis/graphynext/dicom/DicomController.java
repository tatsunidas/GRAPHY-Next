/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.dicom.qr.DimseQrService;
import com.vis.graphynext.dicom.qr.QrRetrieveService;
import com.vis.graphynext.dicom.qr.QrSeriesRow;
import com.vis.graphynext.dicom.qr.QrStudyRow;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.DicomSendService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import com.vis.graphynext.settings.SettingsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * DICOM 通信の REST エンドポイント。当面は C-ECHO 疎通確認のみ。
 */
@RestController
@RequestMapping("/api/dicom")
public class DicomController {

    private static final Logger log = LoggerFactory.getLogger(DicomController.class);

    /** Settings(H2) に送信先 Remote AE を JSON 配列で保存するキー。frontend と一致させること。 */
    public static final String REMOTE_AES_KEY = "dicom.remoteAes";

    private final DicomEchoScu echoScu;
    private final DicomProperties props;
    private final DimseQrService qr;
    private final QrRetrieveService qrRetrieve;
    private final DicomSendService send;
    private final DicomStorageService storage;
    private final SettingsService settings;
    private final ObjectMapper mapper;
    private final org.springframework.beans.factory.ObjectProvider<WebDicomDataService> webProvider;
    private final DicomScpLifecycle scp; // scp.enabled=false のとき null

    public DicomController(DicomEchoScu echoScu, DicomProperties props, DimseQrService qr,
                           QrRetrieveService qrRetrieve, DicomSendService send, DicomStorageService storage,
                           SettingsService settings, ObjectMapper mapper,
                           org.springframework.beans.factory.ObjectProvider<WebDicomDataService> webProvider,
                           org.springframework.beans.factory.ObjectProvider<DicomScpLifecycle> scpProvider) {
        this.echoScu = echoScu;
        this.props = props;
        this.qr = qr;
        this.qrRetrieve = qrRetrieve;
        this.send = send;
        this.storage = storage;
        this.settings = settings;
        this.mapper = mapper;
        this.webProvider = webProvider;
        this.scp = scpProvider.getIfAvailable();
    }

    /** リモート AE へ C-ECHO（callingAet 省略時は自局 AE。tls=true で TLS 接続）。 */
    @PostMapping("/echo")
    public EchoResult echo(@RequestBody EchoRequest req) {
        String callingAet = (req.callingAet() == null || req.callingAet().isBlank())
                ? props.getLocalAeTitle() : req.callingAet();
        DicomProperties.Tls tls = req.tls() ? props.getTls() : null;
        return echoScu.echo(req.host(), req.port(), req.calledAet(), callingAet, tls);
    }

    /** ローカル SCP リスナーの状態。 */
    @GetMapping("/scp")
    public Map<String, Object> scpStatus() {
        boolean enabled = scp != null;
        return Map.of(
                "enabled", enabled,
                "running", enabled && scp.getServer().isRunning(),
                "aeTitle", enabled ? scp.getServer().getAeTitle() : props.getLocalAeTitle(),
                "port", enabled ? scp.getServer().getPort() : props.getScp().getPort());
    }

    /** C-FIND: リモート PACS をクエリしてスタディ一覧を返す。 */
    @PostMapping("/qr/find")
    public List<StudyDto> find(@RequestBody QrFindRequest req) throws IOException {
        return qr.findStudies(req.host(), req.port(), req.calledAet(),
                req.matchKeys() == null ? Map.of() : req.matchKeys());
    }

    /** C-GET: リモート PACS から study を取得しローカル索引へ取り込む。 */
    @PostMapping("/qr/get")
    public Map<String, Object> get(@RequestBody QrRequest req) throws IOException {
        int n = qr.getStudy(req.host(), req.port(), req.calledAet(), req.studyUid());
        return Map.of("retrieved", n, "studyUid", req.studyUid());
    }

    /** C-MOVE: リモート PACS から指定 AE（既定は自局）へ study を送らせる。 */
    @PostMapping("/qr/move")
    public Map<String, Object> move(@RequestBody QrMoveRequest req) throws IOException {
        String dest = (req.destAet() == null || req.destAet().isBlank())
                ? props.getLocalAeTitle() : req.destAet();
        int exit = qr.moveStudy(req.host(), req.port(), req.calledAet(), req.studyUid(), dest);
        return Map.of("exitCode", exit, "destAet", dest, "studyUid", req.studyUid());
    }

    // ── QR ウィンドウ（Query/Retrieve） ─────────────────────────────

    /** QR: STUDY レベル C-FIND（生年月日/性別/受付番号/シリーズ数を含む拡張版）。 */
    @PostMapping("/qr/find-studies")
    public List<QrStudyRow> qrFindStudies(@RequestBody QrFindRequest req) throws IOException {
        return qr.findStudiesForQr(req.host(), req.port(), req.calledAet(),
                req.matchKeys() == null ? Map.of() : req.matchKeys());
    }

    /** QR: SERIES レベル C-FIND（指定スタディ内のシリーズ）。 */
    @PostMapping("/qr/find-series")
    public List<QrSeriesRow> qrFindSeries(@RequestBody QrSeriesRequest req) throws IOException {
        return qr.findSeries(req.host(), req.port(), req.calledAet(), req.studyUid(),
                req.matchKeys() == null ? Map.of() : req.matchKeys());
    }

    /**
     * QR: リトリーブ開始（非同期）。両モードとも C-GET で取得し、standalone は索引へ取込・web は dcm4chee へ
     * STOW する。返り値の jobId を {@code GET /qr/retrieve/{jobId}} でポーリングして進捗を取得する。
     */
    @PostMapping("/qr/retrieve")
    public Map<String, String> qrRetrieve(@RequestBody QrRetrieveRequest req) {
        String jobId = qrRetrieve.start(req.host(), req.port(), req.calledAet(),
                req.studyUid(), req.seriesUid(), req.expected());
        return Map.of("jobId", jobId);
    }

    /** QR: リトリーブ進捗。 */
    @GetMapping("/qr/retrieve/{jobId}")
    public QrRetrieveService.JobStatus qrRetrieveStatus(@PathVariable String jobId) {
        QrRetrieveService.JobStatus s = qrRetrieve.status(jobId);
        if (s == null) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.NOT_FOUND, "unknown jobId: " + jobId);
        }
        return s;
    }

    /**
     * QR: 保存済み件数の問い合わせ（バッチ）。standalone はローカル索引、web は dcm4chee QIDO で数える。
     * 各要素 {@code {studyUid, seriesUid?}} に対し {@code {studyUid, seriesUid, storedCount}} を返す。
     */
    @PostMapping("/qr/stored")
    public List<StoredResult> qrStored(@RequestBody List<StoredQuery> queries) {
        WebDicomDataService web = webProvider.getIfAvailable();
        List<StoredResult> out = new ArrayList<>();
        for (StoredQuery q : queries) {
            long count = (web != null)
                    ? web.storedCount(q.studyUid(), q.seriesUid())
                    : storage.storedCount(q.studyUid(), q.seriesUid());
            out.add(new StoredResult(q.studyUid(), q.seriesUid(), count));
        }
        return out;
    }

    /**
     * 設定済みリモート AE 一覧（DICOM Send / C-MOVE 宛先の選択肢として frontend が使う）。
     * application.yml の {@code graphy.dicom.remote-aes}（運用配布の既定値）と、Settings(H2) に
     * GUI から保存された分（{@link #REMOTE_AES_KEY}）を<b>マージ</b>して返す。AE タイトル重複は
     * Settings 側で上書きする。
     */
    @GetMapping("/remote-aes")
    public List<RemoteAeDto> remoteAes() {
        java.util.LinkedHashMap<String, RemoteAeDto> byAet = new java.util.LinkedHashMap<>();
        for (DicomProperties.RemoteAe a : props.getRemoteAes()) {
            if (a.getAeTitle() != null && !a.getAeTitle().isBlank()) {
                byAet.put(a.getAeTitle(), new RemoteAeDto(a.getAeTitle(), a.getHost(), a.getPort()));
            }
        }
        String json = settings.getAll().get(REMOTE_AES_KEY);
        if (json != null && !json.isBlank()) {
            try {
                List<RemoteAeDto> stored = mapper.readValue(json, new TypeReference<List<RemoteAeDto>>() {
                });
                for (RemoteAeDto a : stored) {
                    if (a.aeTitle() != null && !a.aeTitle().isBlank()) {
                        byAet.put(a.aeTitle(), a); // Settings 保存分が YAML を上書き
                    }
                }
            } catch (Exception e) {
                log.warn("Settings の {} を解析できませんでした（無視）: {}", REMOTE_AES_KEY, e.toString());
            }
        }
        return new java.util.ArrayList<>(byAet.values());
    }

    /**
     * DICOM Send: 選択スタディ/シリーズをリモート AE へ C-STORE する（standalone のローカル索引が前提）。
     * callingAet 省略時は自局 AE。tls=true で TLS 接続（設定が揃っている場合のみ実効）。
     */
    @PostMapping("/send")
    public DicomSendService.SendSummary send(@RequestBody SendRequest req) {
        String callingAet = (req.callingAet() == null || req.callingAet().isBlank())
                ? props.getLocalAeTitle() : req.callingAet();
        List<DicomSendService.Selection> selections = (req.selections() == null ? List.<SendSelection>of() : req.selections())
                .stream()
                .map(s -> new DicomSendService.Selection(s.studyUid(), s.seriesUids()))
                .toList();
        return send.send(selections, req.host(), req.port(), req.calledAet(), callingAet, req.tls());
    }

    public record EchoRequest(String host, int port, String calledAet, String callingAet, boolean tls) {
    }

    public record RemoteAeDto(String aeTitle, String host, int port) {
    }

    public record SendSelection(String studyUid, List<String> seriesUids) {
    }

    public record SendRequest(List<SendSelection> selections, String host, int port, String calledAet,
                              String callingAet, boolean tls) {
    }

    public record QrFindRequest(String host, int port, String calledAet, Map<String, String> matchKeys) {
    }

    public record QrRequest(String host, int port, String calledAet, String studyUid) {
    }

    public record QrMoveRequest(String host, int port, String calledAet, String studyUid, String destAet) {
    }

    public record QrSeriesRequest(String host, int port, String calledAet, String studyUid,
                                  Map<String, String> matchKeys) {
    }

    public record QrRetrieveRequest(String host, int port, String calledAet, String studyUid, String seriesUid,
                                    int expected) {
    }

    public record StoredQuery(String studyUid, String seriesUid) {
    }

    public record StoredResult(String studyUid, String seriesUid, long storedCount) {
    }
}

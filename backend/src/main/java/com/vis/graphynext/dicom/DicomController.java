package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.qr.DimseQrService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.List;
import java.util.Map;

/**
 * DICOM 通信の REST エンドポイント。当面は C-ECHO 疎通確認のみ。
 */
@RestController
@RequestMapping("/api/dicom")
public class DicomController {

    private final DicomEchoScu echoScu;
    private final DicomProperties props;
    private final DimseQrService qr;
    private final DicomScpLifecycle scp; // scp.enabled=false のとき null

    public DicomController(DicomEchoScu echoScu, DicomProperties props, DimseQrService qr,
                           org.springframework.beans.factory.ObjectProvider<DicomScpLifecycle> scpProvider) {
        this.echoScu = echoScu;
        this.props = props;
        this.qr = qr;
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

    public record EchoRequest(String host, int port, String calledAet, String callingAet, boolean tls) {
    }

    public record QrFindRequest(String host, int port, String calledAet, Map<String, String> matchKeys) {
    }

    public record QrRequest(String host, int port, String calledAet, String studyUid) {
    }

    public record QrMoveRequest(String host, int port, String calledAet, String studyUid, String destAet) {
    }
}

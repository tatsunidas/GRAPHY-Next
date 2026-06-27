package com.vis.graphynext.dicom;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * DICOM 通信の REST エンドポイント。当面は C-ECHO 疎通確認のみ。
 */
@RestController
@RequestMapping("/api/dicom")
public class DicomController {

    private final DicomEchoScu echoScu;
    private final DicomProperties props;
    private final DicomScpLifecycle scp; // scp.enabled=false のとき null

    public DicomController(DicomEchoScu echoScu, DicomProperties props,
                           org.springframework.beans.factory.ObjectProvider<DicomScpLifecycle> scpProvider) {
        this.echoScu = echoScu;
        this.props = props;
        this.scp = scpProvider.getIfAvailable();
    }

    /** リモート AE へ C-ECHO（callingAet 省略時は自局 AE を使用）。 */
    @PostMapping("/echo")
    public EchoResult echo(@RequestBody EchoRequest req) {
        String callingAet = (req.callingAet() == null || req.callingAet().isBlank())
                ? props.getLocalAeTitle() : req.callingAet();
        return echoScu.echo(req.host(), req.port(), req.calledAet(), callingAet);
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

    public record EchoRequest(String host, int port, String calledAet, String callingAet) {
    }
}

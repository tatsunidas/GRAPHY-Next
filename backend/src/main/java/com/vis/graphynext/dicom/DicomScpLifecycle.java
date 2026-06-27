package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.DicomStoreScp;
import org.dcm4che3.net.TransferCapability;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * SCP リスナーを Spring ライフサイクルに結びつける。
 *
 * <p>{@code graphy.dicom.scp.enabled=true} のときだけ Bean 化され、アプリ起動で
 * リスナーを開始、停止でアンバインドする。standalone モードでの有効化を想定。
 * C-ECHO に加え、受信した DICOM をローカル索引へ取り込む C-STORE も受け付ける。
 */
@Component
@ConditionalOnProperty(prefix = "graphy.dicom.scp", name = "enabled", havingValue = "true")
public class DicomScpLifecycle implements SmartLifecycle {

    private final DicomScpServer server;

    public DicomScpLifecycle(DicomProperties props, DicomStorageService storage) {
        this.server = new DicomScpServer(
                props.getLocalAeTitle(),
                props.getScp().getBindAddress(),
                props.getScp().getPort());

        Path tempDir = Paths.get(props.getStorageDir(), "incoming");
        server.addService(
                new DicomStoreScp(storage, tempDir),
                // 任意の Storage SOP Class / Transfer Syntax を SCP として受理
                new TransferCapability(null, "*", TransferCapability.Role.SCP, "*"));
    }

    public DicomScpServer getServer() {
        return server;
    }

    @Override
    public void start() {
        server.start();
    }

    @Override
    public void stop() {
        server.stop();
    }

    @Override
    public boolean isRunning() {
        return server.isRunning();
    }
}

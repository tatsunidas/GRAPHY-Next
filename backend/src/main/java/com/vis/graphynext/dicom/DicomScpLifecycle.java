/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.DicomStoreScp;
import org.dcm4che3.net.TransferCapability;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;

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

    public DicomScpLifecycle(DicomProperties props, DicomStorageService storage, DicomTlsService tlsService,
                             DicomLocalAeService localAe) {
        this.server = new DicomScpServer(
                localAe.aeTitle(),
                localAe.bindAddress(),
                localAe.scpPort());

        Path tempDir = Paths.get(props.getStorageDir(), "incoming");
        // all-storage("*") は使わず、設定リソースに明示列挙した SOP クラスのみ受理する。
        List<TransferCapability> storageCaps =
                StorageSopClasses.scpCapabilities(props.getStorageSopClassesResource());
        server.addService(
                new DicomStoreScp(storage, tempDir),
                storageCaps.toArray(TransferCapability[]::new));

        // TLS が設定済み（GUI 保存 or application.yml）なら、平文に加えて TLS リスナーも有効化する。
        // リスナーは起動時バインドのため、GUI での TLS 変更は再起動後に反映される。
        DicomProperties.Tls tls = tlsService.effective();
        if (tls.isUsable()) {
            server.enableTls(tls);
        }
    }

    public DicomScpServer getServer() {
        return server;
    }

    @Override
    public void start() {
        com.vis.graphynext.startup.StartupProgress.report("scp", "running", "DICOM 受信(SCP)を開始しています");
        server.start();
        com.vis.graphynext.startup.StartupProgress.report("scp", "ok", "DICOM 受信(SCP)を開始しました");
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

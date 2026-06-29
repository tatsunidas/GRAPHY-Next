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

    public DicomScpLifecycle(DicomProperties props, DicomStorageService storage) {
        this.server = new DicomScpServer(
                props.getLocalAeTitle(),
                props.getScp().getBindAddress(),
                props.getScp().getPort());

        Path tempDir = Paths.get(props.getStorageDir(), "incoming");
        // all-storage("*") は使わず、設定リソースに明示列挙した SOP クラスのみ受理する。
        List<TransferCapability> storageCaps =
                StorageSopClasses.scpCapabilities(props.getStorageSopClassesResource());
        server.addService(
                new DicomStoreScp(storage, tempDir),
                storageCaps.toArray(TransferCapability[]::new));

        // TLS が設定済みなら、平文に加えて TLS リスナーも有効化する。
        if (props.getTls().isUsable()) {
            server.enableTls(props.getTls());
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

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.net.Association;
import org.dcm4che3.net.PDVInputStream;
import org.dcm4che3.net.TransferCapability;
import org.dcm4che3.net.pdu.PresentationContext;
import org.dcm4che3.net.service.BasicCStoreSCP;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * C-MOVE の宛先役。製品の受信（{@code DicomStoreScp}）とは別の、テスト内の最小の C-STORE SCP。
 * 届いた SOP UID と転送構文を数える。受けた転送構文は引数で絞れる。
 */
final class MoveReceiver implements AutoCloseable {

    private final DicomScpServer server;
    /** 届いた SOPInstanceUID → 転送構文。 */
    final Map<String, String> received = new ConcurrentHashMap<>();
    final AtomicInteger associations = new AtomicInteger();
    final int port;

    MoveReceiver(int port, Path dir, long delayMillis, String... acceptTs) throws Exception {
        this.port = port;
        this.server = new DicomScpServer("RCVSCP", "127.0.0.1", port);
        server.addService(new BasicCStoreSCP("*") {
            @Override
            public void onClose(Association as) {
                associations.incrementAndGet();
            }

            @Override
            protected void store(Association as, PresentationContext pc, Attributes rq, PDVInputStream data, Attributes rsp)
                    throws IOException {
                String iuid = rq.getString(Tag.AffectedSOPInstanceUID);
                Attributes fmi = as.createFileMetaInformation(iuid, rq.getString(Tag.AffectedSOPClassUID), pc.getTransferSyntax());
                if (dir != null) {
                    try (DicomOutputStream out = new DicomOutputStream(dir.resolve(iuid + ".dcm").toFile())) {
                        out.writeFileMetaInformation(fmi);
                        data.copyTo(out);
                    }
                } else {
                    data.skipAll();
                }
                received.put(iuid, pc.getTransferSyntax());
                if (delayMillis > 0) {
                    try {
                        Thread.sleep(delayMillis);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
            }
        }, new TransferCapability(null, "*", TransferCapability.Role.SCP, acceptTs));
        server.start();
    }

    @Override
    public void close() {
        server.stop();
    }
}

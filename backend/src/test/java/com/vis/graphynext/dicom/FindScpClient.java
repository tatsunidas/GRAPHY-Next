/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.net.ApplicationEntity;
import org.dcm4che3.net.Association;
import org.dcm4che3.net.Connection;
import org.dcm4che3.net.Device;
import org.dcm4che3.net.DimseRSP;
import org.dcm4che3.net.Priority;
import org.dcm4che3.net.Status;
import org.dcm4che3.net.pdu.AAssociateRQ;
import org.dcm4che3.net.pdu.PresentationContext;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

/** テスト用の C-FIND SCU（dcm4che のクライアント側。検査対象の SCP とは別実装）。 */
final class FindScpClient {

    private FindScpClient() {
    }

    /**
     * @param accepted Presentation Context が受理されたか（受理されなければ要求は送らない）
     * @param status   最終応答のステータス（要求を送っていないとき -1）
     */
    record Found(boolean accepted, int status, List<Attributes> matches) {
    }

    static Found find(int port, String cuid, String callingAet, Attributes keys) throws Exception {
        Device device = new Device("test-find-scu");
        Connection local = new Connection();
        ApplicationEntity ae = new ApplicationEntity(callingAet);
        device.addConnection(local);
        device.addApplicationEntity(ae);
        ae.addConnection(local);
        ExecutorService ex = Executors.newSingleThreadExecutor();
        ScheduledExecutorService sch = Executors.newSingleThreadScheduledExecutor();
        device.setExecutor(ex);
        device.setScheduledExecutor(sch);
        Connection remote = new Connection();
        remote.setHostname("127.0.0.1");
        remote.setPort(port);
        AAssociateRQ rq = new AAssociateRQ();
        rq.setCalledAET("GRAPHYNEXT");
        rq.addPresentationContext(new PresentationContext(1, cuid, UID.ImplicitVRLittleEndian));
        Association as = null;
        try {
            try {
                as = ae.connect(local, remote, rq);
            } catch (Exception refused) {
                return new Found(false, -1, List.of()); // 全コンテキストが受理されないとき、関連ごと拒否されうる
            }
            PresentationContext pc = as.getAAssociateAC().getPresentationContext(1);
            if (pc == null || !pc.isAccepted()) {
                return new Found(false, -1, List.of());
            }
            DimseRSP rsp = as.cfind(cuid, Priority.NORMAL, keys, UID.ImplicitVRLittleEndian, 0);
            List<Attributes> out = new ArrayList<>();
            int status = -1;
            while (rsp.next()) {
                int s = rsp.getCommand().getInt(Tag.Status, -1);
                if (Status.isPending(s)) {
                    out.add(rsp.getDataset());
                } else {
                    status = s;
                }
            }
            return new Found(true, status, out);
        } finally {
            if (as != null) {
                try {
                    as.release();
                } catch (Exception ignore) {
                    // ベストエフォート
                }
            }
            ex.shutdown();
            sch.shutdown();
        }
    }
}

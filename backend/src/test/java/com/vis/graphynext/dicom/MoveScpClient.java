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

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

/** テスト用の C-MOVE SCU（dcm4che のクライアント側。検査対象の SCP とは別実装）。 */
final class MoveScpClient {

    private MoveScpClient() {
    }

    /**
     * @param accepted  Presentation Context が受理されたか（受理されなければ要求は送らない）
     * @param status    最終応答のステータス（要求を送っていないとき -1）
     * @param completed 最終応答の NumberOfCompletedSuboperations（無ければ -1）
     * @param failed    最終応答の NumberOfFailedSuboperations（無ければ -1）
     * @param pendings  途中の Pending 応答の数
     */
    record Moved(boolean accepted, int status, int completed, int failed, int pendings) {
    }

    /** @param cancelAfterPendings 0 より大きければ、その数の Pending を受けた時点で C-CANCEL を送る */
    static Moved move(int port, String cuid, String callingAet, String dest, Attributes keys, int cancelAfterPendings)
            throws Exception {
        Device device = new Device("test-move-scu");
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
                return new Moved(false, -1, -1, -1, 0);
            }
            PresentationContext pc = as.getAAssociateAC().getPresentationContext(1);
            if (pc == null || !pc.isAccepted()) {
                return new Moved(false, -1, -1, -1, 0);
            }
            DimseRSP rsp = as.cmove(cuid, Priority.NORMAL, keys, UID.ImplicitVRLittleEndian, dest);
            int pendings = 0;
            boolean canceled = false;
            int status = -1;
            int completed = -1;
            int failed = -1;
            while (rsp.next()) {
                Attributes cmd = rsp.getCommand();
                int s = cmd.getInt(Tag.Status, -1);
                if (Status.isPending(s)) {
                    pendings++;
                    if (cancelAfterPendings > 0 && pendings >= cancelAfterPendings && !canceled) {
                        canceled = true;
                        rsp.cancel(as);
                    }
                } else {
                    status = s;
                    completed = cmd.getInt(Tag.NumberOfCompletedSuboperations, -1);
                    failed = cmd.getInt(Tag.NumberOfFailedSuboperations, -1);
                }
            }
            return new Moved(true, status, completed, failed, pendings);
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

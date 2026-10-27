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
import org.dcm4che3.net.TransferCapability;
import org.dcm4che3.net.pdu.AAssociateRQ;
import org.dcm4che3.net.pdu.PresentationContext;
import org.dcm4che3.net.pdu.RoleSelection;
import org.dcm4che3.net.service.BasicCStoreSCP;
import org.dcm4che3.net.service.DicomServiceRegistry;
import org.dcm4che3.net.PDVInputStream;

import java.io.OutputStream;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

/**
 * テスト用の C-GET SCU（dcm4che のクライアント側。検査対象の SCP とは別実装）。
 * 同じ接続の上で返ってくる C-STORE を受ける側にもなる（役割選択で SCP ロールを提示）。
 */
final class GetScpClient {

    private GetScpClient() {
    }

    /**
     * @param accepted  GET の Presentation Context が受理されたか
     * @param status    最終応答のステータス（要求を送っていないとき -1）
     * @param completed NumberOfCompletedSuboperations（無ければ -1）
     * @param failed    NumberOfFailedSuboperations（無ければ -1）
     * @param pendings  途中の Pending 応答の数
     * @param received  届いた SOP Instance UID → そのときの転送構文
     * @param roleAccepted 保存 SOP クラスの役割選択（こちらが受ける側）が受理されたか
     * @param storeAssociations 画像を受けた接続の数（C-GET では 1 のはず）
     */
    record Got(boolean accepted, int status, int completed, int failed, int pendings, Map<String, String> received,
               boolean roleAccepted, int storeAssociations) {
    }

    /**
     * @param storageSopClasses 受ける保存 SOP クラス（空なら保存側は何も提示しない）
     * @param roleSelection     true なら保存 SOP クラスに役割選択（自分が SCP）を付ける。false なら付けない
     * @param acceptTs          保存 SOP クラスで受ける転送構文
     */
    static Got get(int port, String cuid, String callingAet, Attributes keys, int cancelAfterPendings,
                   List<String> storageSopClasses, boolean roleSelection, String... acceptTs) throws Exception {
        Map<String, String> received = new ConcurrentHashMap<>();
        Device device = new Device("test-get-scu");
        Connection local = new Connection();
        ApplicationEntity ae = new ApplicationEntity(callingAet);
        device.addConnection(local);
        device.addApplicationEntity(ae);
        ae.addConnection(local);
        for (String sc : storageSopClasses) {
            ae.addTransferCapability(new TransferCapability(null, sc, TransferCapability.Role.SCP, acceptTs));
        }
        DicomServiceRegistry registry = new DicomServiceRegistry();
        registry.addDicomService(new BasicCStoreSCP("*") {
            @Override
            protected void store(Association as, PresentationContext pc, Attributes rq, PDVInputStream data, Attributes rsp)
                    throws java.io.IOException {
                received.put(rq.getString(Tag.AffectedSOPInstanceUID), pc.getTransferSyntax());
                data.copyTo(OutputStream.nullOutputStream());
            }
        });
        device.setDimseRQHandler(registry);
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
        int id = 3;
        for (String sc : storageSopClasses) {
            rq.addPresentationContext(new PresentationContext(id, sc, acceptTs));
            id += 2;
            if (roleSelection) {
                rq.addRoleSelection(new RoleSelection(sc, false, true));
            }
        }
        Association as = null;
        try {
            try {
                as = ae.connect(local, remote, rq);
            } catch (Exception refused) {
                return new Got(false, -1, -1, -1, 0, received, false, 0);
            }
            PresentationContext pc = as.getAAssociateAC().getPresentationContext(1);
            if (pc == null || !pc.isAccepted()) {
                return new Got(false, -1, -1, -1, 0, received, false, 0);
            }
            boolean roleAccepted = false;
            for (String sc : storageSopClasses) {
                RoleSelection rs = as.getAAssociateAC().getRoleSelectionFor(sc);
                roleAccepted |= rs != null && rs.isSCP();
            }
            DimseRSP rsp = as.cget(cuid, Priority.NORMAL, keys, UID.ImplicitVRLittleEndian);
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
            return new Got(true, status, completed, failed, pendings, received, roleAccepted, 1);
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

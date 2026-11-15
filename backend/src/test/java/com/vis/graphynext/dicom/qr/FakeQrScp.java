/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import com.vis.graphynext.dicom.DicomScpServer;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.net.Association;
import org.dcm4che3.net.Commands;
import org.dcm4che3.net.Status;
import org.dcm4che3.net.TransferCapability;
import org.dcm4che3.net.pdu.PresentationContext;
import org.dcm4che3.net.service.BasicCFindSCP;
import org.dcm4che3.net.service.BasicCGetSCP;
import org.dcm4che3.net.service.BasicCMoveSCP;
import org.dcm4che3.net.service.DicomServiceException;
import org.dcm4che3.net.service.QueryTask;
import org.dcm4che3.net.service.RetrieveTask;

import java.io.IOException;
import java.net.ServerSocket;
import java.util.List;
import java.util.Set;

/**
 * 通信先の振る舞いを模す偽の Q/R SCP（テスト用）。実 PACS ごとの癖を、再現できる形で持つ。
 *
 * <ul>
 *   <li>{@link Behavior#NORMAL}: 要求どおり 1 件を返す</li>
 *   <li>{@link Behavior#NO_QR}: Q/R のサービスを受けない（abstract-syntax-not-supported）</li>
 *   <li>{@link Behavior#ERROR_STATUS}: 受けたうえで指定の status で失敗を返す</li>
 *   <li>{@link Behavior#DROP_ON_KEYS}: 要求に {@code dropKeys} のどれかが入っていると、応答せずソケットを切る
 *       （実例: 中継サーバーの切断）</li>
 * </ul>
 */
public final class FakeQrScp implements AutoCloseable {

    public enum Behavior { NORMAL, NO_QR, ERROR_STATUS, DROP_ON_KEYS }

    public final int port;
    private final DicomScpServer server;

    /** C-FIND が受けた要求のキー（直近）。 */
    public volatile Attributes lastFindKeys;
    public volatile String lastFindSopClass;

    private FakeQrScp(int port, DicomScpServer server) {
        this.port = port;
        this.server = server;
    }

    /**
     * @param aet        自分の AE タイトル
     * @param find       C-FIND の振る舞い
     * @param patientRoot Patient Root の FIND を受けるか（false なら Study Root だけ）
     * @param studyRoot  Study Root の FIND を受けるか
     * @param errorStatus ERROR_STATUS のときに返す status
     * @param dropKeys   DROP_ON_KEYS のときに切る契機となるタグ
     * @param retrieve   C-GET / C-MOVE を受けるか（受けるときは、存在しない UID に対し 0000H を返す）
     * @param knownMoveDests MOVE の宛先として知っている AE（null なら何でも受ける。外れると a801H）
     */
    public static FakeQrScp start(String aet, Behavior find, boolean patientRoot, boolean studyRoot,
                                  int errorStatus, Set<Integer> dropKeys, boolean retrieve,
                                  Set<String> knownMoveDests) {
        return start(aet, find, patientRoot, studyRoot, errorStatus, dropKeys, retrieve, knownMoveDests, 0);
    }

    /** @param fixedPort 0 なら空きポート */
    public static FakeQrScp start(String aet, Behavior find, boolean patientRoot, boolean studyRoot,
                                  int errorStatus, Set<Integer> dropKeys, boolean retrieve,
                                  Set<String> knownMoveDests, int fixedPort) {
        int port = fixedPort != 0 ? fixedPort : freePort();
        DicomScpServer server = new DicomScpServer(aet, "127.0.0.1", port);
        FakeQrScp self = new FakeQrScp(port, server);
        if (find != Behavior.NO_QR) {
            String[] cuids = java.util.stream.Stream.of(
                            patientRoot ? UID.PatientRootQueryRetrieveInformationModelFind : null,
                            studyRoot ? UID.StudyRootQueryRetrieveInformationModelFind : null)
                    .filter(java.util.Objects::nonNull).toArray(String[]::new);
            if (cuids.length > 0) {
                TransferCapability[] caps = new TransferCapability[cuids.length];
                for (int i = 0; i < cuids.length; i++) {
                    caps[i] = new TransferCapability(null, cuids[i], TransferCapability.Role.SCP,
                            UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian);
                }
                server.addService(new FindImpl(self, find, errorStatus, dropKeys, cuids), caps);
            }
        }
        if (retrieve) {
            server.addService(new GetImpl(),
                    new TransferCapability(null, UID.StudyRootQueryRetrieveInformationModelGet,
                            TransferCapability.Role.SCP, UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian));
            server.addService(new MoveImpl(knownMoveDests),
                    new TransferCapability(null, UID.StudyRootQueryRetrieveInformationModelMove,
                            TransferCapability.Role.SCP, UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian));
        }
        server.start();
        return self;
    }

    @Override
    public void close() {
        server.stop();
    }

    private static int freePort() {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private static final class FindImpl extends BasicCFindSCP {
        private final FakeQrScp owner;
        private final Behavior behavior;
        private final int errorStatus;
        private final Set<Integer> dropKeys;

        FindImpl(FakeQrScp owner, Behavior behavior, int errorStatus, Set<Integer> dropKeys, String... cuids) {
            super(cuids);
            this.owner = owner;
            this.behavior = behavior;
            this.errorStatus = errorStatus;
            this.dropKeys = dropKeys;
        }

        @Override
        protected QueryTask calculateMatches(Association as, PresentationContext pc, Attributes rq, Attributes keys)
                throws DicomServiceException {
            owner.lastFindKeys = keys;
            owner.lastFindSopClass = rq.getString(Tag.AffectedSOPClassUID);
            if (behavior == Behavior.ERROR_STATUS) {
                throw new DicomServiceException(errorStatus, "fake error");
            }
            if (behavior == Behavior.DROP_ON_KEYS) {
                for (int t : dropKeys) {
                    if (keys.contains(t)) {
                        try {
                            as.getSocket().close(); // 応答も A-ABORT も返さず TCP を切る
                        } catch (IOException ignore) {
                            // 切れればよい
                        }
                        throw new DicomServiceException(Status.UnableToProcess, "dropped");
                    }
                }
            }
            return new OneMatchTask(as, pc, rq, keys);
        }
    }

    private static final class OneMatchTask extends org.dcm4che3.net.service.BasicQueryTask {
        private boolean given;

        OneMatchTask(Association as, PresentationContext pc, Attributes rq, Attributes keys) {
            super(as, pc, rq, keys);
        }

        @Override
        protected boolean hasMoreMatches() {
            return !given;
        }

        @Override
        protected Attributes nextMatch() {
            given = true;
            Attributes a = new Attributes();
            a.setString(Tag.QueryRetrieveLevel, VR.CS, keys.getString(Tag.QueryRetrieveLevel));
            a.setString(Tag.StudyInstanceUID, VR.UI, "1.2.fake.study");
            a.setString(Tag.PatientID, VR.LO, "FAKE1");
            a.setString(Tag.PatientName, VR.PN, "FAKE^PATIENT");
            a.setString(Tag.StudyDate, VR.DA, "20261114");
            a.setString(Tag.ModalitiesInStudy, VR.CS, "CT");
            a.setString(Tag.SeriesInstanceUID, VR.UI, "1.2.fake.series");
            a.setString(Tag.Modality, VR.CS, "CT");
            return a;
        }

        @Override
        protected Attributes adjust(Attributes match) {
            Attributes out = new Attributes();
            for (int tag : keys.tags()) {
                if (match.contains(tag)) {
                    out.addSelected(match, tag);
                } else {
                    out.setNull(tag, keys.getVR(tag));
                }
            }
            return out;
        }
    }

    /** 存在しない UID への GET は、0 件で 0000H を返す。 */
    private static final class GetImpl extends BasicCGetSCP {
        GetImpl() {
            super(UID.StudyRootQueryRetrieveInformationModelGet);
        }

        @Override
        protected RetrieveTask calculateMatches(Association as, PresentationContext pc, Attributes rq,
                                                Attributes keys) throws DicomServiceException {
            return new EmptyRetrieve(as, pc, rq, false);
        }
    }

    /** 存在しない UID への MOVE は、0 件で 0000H を返す。 */
    private static final class MoveImpl extends BasicCMoveSCP {
        private final Set<String> knownDests;

        MoveImpl(Set<String> knownDests) {
            super(UID.StudyRootQueryRetrieveInformationModelMove);
            this.knownDests = knownDests;
        }

        @Override
        protected RetrieveTask calculateMatches(Association as, PresentationContext pc, Attributes rq,
                                                Attributes keys) throws DicomServiceException {
            String dest = rq.getString(Tag.MoveDestination);
            if (knownDests != null && !knownDests.contains(dest)) {
                throw new DicomServiceException(Status.MoveDestinationUnknown, "Unknown AE: " + dest);
            }
            return new EmptyRetrieve(as, pc, rq, true);
        }
    }

    private static final class EmptyRetrieve implements RetrieveTask {
        private final Association as;
        private final PresentationContext pc;
        private final Attributes rq;
        private final boolean move;

        EmptyRetrieve(Association as, PresentationContext pc, Attributes rq, boolean move) {
            this.as = as;
            this.pc = pc;
            this.rq = rq;
            this.move = move;
        }

        @Override
        public void run() {
            try {
                Attributes rsp = move ? Commands.mkCMoveRSP(rq, Status.Success) : Commands.mkCGetRSP(rq, Status.Success);
                as.writeDimseRSP(pc, rsp, null);
            } catch (IOException e) {
                // 切れていれば何もしない
            }
        }

        @Override
        public void onCancelRQ(Association as) {
            // 即時完了するので何もしない
        }
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomStoreScu;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.net.ApplicationEntity;
import org.dcm4che3.net.Association;
import org.dcm4che3.net.Commands;
import org.dcm4che3.net.Connection;
import org.dcm4che3.net.DataWriter;
import org.dcm4che3.net.DataWriterAdapter;
import org.dcm4che3.net.Device;
import org.dcm4che3.net.Dimse;
import org.dcm4che3.net.Status;
import org.dcm4che3.net.TransferCapability;
import org.dcm4che3.net.pdu.AAssociateRQ;
import org.dcm4che3.net.pdu.PresentationContext;
import org.dcm4che3.net.service.BasicCMoveSCP;
import org.dcm4che3.net.service.BasicRetrieveTask;
import org.dcm4che3.net.service.DicomServiceException;
import org.dcm4che3.net.service.InstanceLocator;
import org.dcm4che3.net.service.RetrieveTask;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

/**
 * 他端末からの C-MOVE に応え、ローカル索引の画像を、指定された宛先 AE へ C-STORE で送る（Patient Root / Study Root）。
 *
 * <p>呼び出し AE が許可されていなければ 0xC000。宛先は<b>登録済みの相手先だけ</b>（許可を「すべて」にしても同じ）で、
 * 未登録は 0xA801。TLS を要する宛先で TLS が使えないときは、平文で送らず 0xA702 で失敗にする。
 * 進捗（残り件数）・中止（C-CANCEL）・完了／警告／失敗の件数は dcm4che の {@link BasicRetrieveTask} に任せる。
 */
public class DicomMoveScp extends BasicCMoveSCP {

    private static final Logger log = LoggerFactory.getLogger(DicomMoveScp.class);

    private static final int CONNECT_TIMEOUT_MS = 5000;
    /** AAssociateRQ が提示できる Presentation Context の上限（DICOM 仕様）。 */
    private static final int MAX_PRESENTATION_CONTEXTS = 128;

    private final DicomQrAccess access;
    private final DicomMoveTargets targets;
    private final DicomRemoteAeService remoteAes;
    private final DicomLocalAeService localAe;
    private final DicomTlsService tlsService;
    private final PixelCodec codec;

    public DicomMoveScp(DicomQrAccess access, DicomMoveTargets targets, DicomRemoteAeService remoteAes,
                        DicomLocalAeService localAe, DicomTlsService tlsService, PixelCodec codec) {
        super(UID.PatientRootQueryRetrieveInformationModelMove, UID.StudyRootQueryRetrieveInformationModelMove);
        this.access = access;
        this.targets = targets;
        this.remoteAes = remoteAes;
        this.localAe = localAe;
        this.tlsService = tlsService;
        this.codec = codec;
    }

    /** この SCP が受理する Presentation Context（SCP ロール、Implicit/Explicit VR Little Endian）。 */
    public static TransferCapability[] capabilities() {
        return new TransferCapability[] {
                new TransferCapability(null, UID.PatientRootQueryRetrieveInformationModelMove,
                        TransferCapability.Role.SCP, UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian),
                new TransferCapability(null, UID.StudyRootQueryRetrieveInformationModelMove,
                        TransferCapability.Role.SCP, UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian)
        };
    }

    @Override
    protected RetrieveTask calculateMatches(Association as, PresentationContext pc, Attributes rq, Attributes keys)
            throws DicomServiceException {
        String caller = as.getCallingAET();
        if (!access.allows(caller)) {
            log.warn("C-MOVE を拒否しました（許可されていない相手）: callingAE={} from={}", caller, as.getSocket().getRemoteSocketAddress());
            throw new DicomServiceException(Status.UnableToProcess, "この相手からの取得は許可されていません");
        }
        String dest = rq.getString(Tag.MoveDestination);
        DicomController.RemoteAeDto remote = findDestination(dest);
        if (remote == null) {
            log.warn("C-MOVE の宛先が登録されていません: callingAE={} destination={}", caller, dest);
            throw new DicomServiceException(Status.MoveDestinationUnknown, "宛先 " + dest + " は登録されていません");
        }
        // 受理側の PresentationContext は抽象構文を持たない。要求コマンドの AffectedSOPClassUID で判別する。
        boolean patientRoot = UID.PatientRootQueryRetrieveInformationModelMove.equals(rq.getString(Tag.AffectedSOPClassUID));
        List<DicomMoveTargets.Target> found;
        try {
            found = targets.resolve(patientRoot, keys);
        } catch (DicomServiceException e) {
            throw e;
        } catch (RuntimeException e) {
            log.warn("C-MOVE の対象を保管庫から用意できません: {}", e.toString());
            throw new DicomServiceException(Status.UnableToProcess, "保管庫から画像を用意できませんでした");
        }
        log.info("C-MOVE: callingAE={} level={} destination={} instances={}", caller,
                keys.getString(Tag.QueryRetrieveLevel), dest, found.size());
        if (found.isEmpty()) {
            return new EmptyTask(as, pc, rq);
        }
        return startSending(as, pc, rq, remote, found);
    }

    private DicomController.RemoteAeDto findDestination(String dest) {
        if (dest == null || dest.isBlank()) {
            return null;
        }
        String aet = dest.trim();
        return remoteAes.list().stream().filter(a -> aet.equals(a.aeTitle().trim())).findFirst().orElse(null);
    }

    private RetrieveTask startSending(Association as, PresentationContext pc, Attributes rq,
                                      DicomController.RemoteAeDto remote, List<DicomMoveTargets.Target> found)
            throws DicomServiceException {
        DicomProperties.Tls tls = null;
        if (remote.tls()) {
            tls = tlsService.effective();
            if (tls == null || !tls.isUsable()) {
                throw new DicomServiceException(Status.UnableToPerformSubOperations,
                        "宛先 " + remote.aeTitle() + " は TLS を要しますが、TLS の設定が使えないため送りません");
            }
        }

        List<InstanceLocator> insts = new java.util.ArrayList<>(found.size());
        Map<String, String[]> pcPairs = new LinkedHashMap<>();
        for (DicomMoveTargets.Target t : found) {
            DicomInstance i = t.instance();
            String tsuid = i.getTransferSyntaxUid();
            if (tsuid == null && t.path() != null) {
                tsuid = transferSyntaxOf(t.path());
            }
            String uri = t.path() == null ? null : t.path().toUri().toString();
            insts.add(new InstanceLocator(i.getSopClassUid(), i.getSopInstanceUid(), tsuid, uri));
            if (i.getSopClassUid() == null || tsuid == null) {
                continue;
            }
            pcPairs.putIfAbsent(i.getSopClassUid() + '\t' + tsuid, new String[] {i.getSopClassUid(), tsuid});
            if (codec != null && DicomStoreScu.isLosslessStored(tsuid)) {
                pcPairs.putIfAbsent(i.getSopClassUid() + '\t' + UID.ExplicitVRLittleEndian,
                        new String[] {i.getSopClassUid(), UID.ExplicitVRLittleEndian});
            }
        }

        Device device = new Device("graphy-move-store-scu");
        Connection local = new Connection();
        local.setConnectTimeout(CONNECT_TIMEOUT_MS);
        ApplicationEntity ae = new ApplicationEntity(localAe.aeTitle());
        device.addConnection(local);
        device.addApplicationEntity(ae);
        ae.addConnection(local);
        ExecutorService executor = Executors.newSingleThreadExecutor();
        ScheduledExecutorService scheduled = Executors.newSingleThreadScheduledExecutor();
        device.setExecutor(executor);
        device.setScheduledExecutor(scheduled);

        Connection dst = new Connection();
        dst.setHostname(remote.host());
        dst.setPort(remote.port());
        dst.setConnectTimeout(CONNECT_TIMEOUT_MS);
        if (tls != null) {
            DicomTls.applyKeyMaterial(device, tls);
            DicomTls.applyToConnection(local, tls, false);
            DicomTls.applyToConnection(dst, tls, false);
        }

        AAssociateRQ aarq = new AAssociateRQ();
        aarq.setCalledAET(remote.aeTitle());
        int pcId = 1;
        for (String[] pair : pcPairs.values()) {
            if (pcId > MAX_PRESENTATION_CONTEXTS * 2 - 1) {
                log.warn("提示 PC が上限 {} に達したため一部 SOPClass/TS を提示しません", MAX_PRESENTATION_CONTEXTS);
                break;
            }
            aarq.addPresentationContext(new PresentationContext(pcId, pair[0], pair[1]));
            pcId += 2;
        }

        Association storeas;
        try {
            storeas = ae.connect(local, dst, aarq);
        } catch (Exception e) {
            executor.shutdown();
            scheduled.shutdown();
            log.warn("C-MOVE の宛先に接続できません: {}@{}:{}: {}", remote.aeTitle(), remote.host(), remote.port(), e.toString());
            throw new DicomServiceException(Status.UnableToPerformSubOperations, "宛先 " + remote.aeTitle() + " に接続できません");
        }
        MoveTask task = new MoveTask(as, pc, rq, insts, storeas, codec, executor, scheduled, remote.aeTitle());
        task.setSendPendingRSP(true);
        return task;
    }

    private static String transferSyntaxOf(Path file) {
        try (DicomInputStream din = new DicomInputStream(file.toFile())) {
            Attributes fmi = din.readFileMetaInformation();
            return fmi == null ? null : fmi.getString(Tag.TransferSyntaxUID);
        } catch (IOException e) {
            return null;
        }
    }

    /** 対象が 0 件のとき。宛先に接続せず、成功（残り 0 件）をそのまま返す。 */
    private static final class EmptyTask implements RetrieveTask {

        private final Association as;
        private final PresentationContext pc;
        private final Attributes rq;

        EmptyTask(Association as, PresentationContext pc, Attributes rq) {
            this.as = as;
            this.pc = pc;
            this.rq = rq;
        }

        @Override
        public void run() {
            as.tryWriteDimseRSP(pc, Commands.mkCMoveRSP(rq, Status.Success));
        }

        @Override
        public void onCancelRQ(Association association) {
            // 即座に終わるので何もしない
        }
    }

    /** 宛先への C-STORE を、保管庫のファイルから行う。転送構文の選び方は DICOM Send（{@link DicomStoreScu}）と同じ。 */
    private static final class MoveTask extends BasicRetrieveTask<InstanceLocator> {

        private final PixelCodec codec;
        private final ExecutorService executor;
        private final ScheduledExecutorService scheduled;
        private final String dest;

        MoveTask(Association as, PresentationContext pc, Attributes rq, List<InstanceLocator> insts, Association storeas,
                 PixelCodec codec, ExecutorService executor, ScheduledExecutorService scheduled, String dest) {
            super(Dimse.C_MOVE_RQ, as, pc, rq, insts, storeas);
            this.codec = codec;
            this.executor = executor;
            this.scheduled = scheduled;
            this.dest = dest;
        }

        @Override
        protected String selectTransferSyntaxFor(Association storeas, InstanceLocator inst) throws Exception {
            if (inst.uri == null) {
                throw new DicomServiceException(Status.ProcessingFailure, "ファイルを読めません: " + inst.iuid);
            }
            Set<String> accepted = storeas.getTransferSyntaxesFor(inst.cuid);
            if (inst.tsuid != null && accepted.contains(inst.tsuid)) {
                return inst.tsuid;
            }
            if (codec != null && DicomStoreScu.isLosslessStored(inst.tsuid) && accepted.contains(UID.ExplicitVRLittleEndian)) {
                return UID.ExplicitVRLittleEndian;
            }
            throw new DicomServiceException(Status.ProcessingFailure,
                    "宛先が転送構文 " + inst.tsuid + " を受け付けません: " + inst.iuid);
        }

        @Override
        protected DataWriter createDataWriter(InstanceLocator inst, String tsuid) throws Exception {
            // ファイルは送る前に読み切って閉じる（ネットワーク I/O 中にファイルを掴まない。Windows のロック対策）
            if (tsuid.equals(inst.tsuid)) {
                try (DicomInputStream din = new DicomInputStream(inst.getFile())) {
                    din.readFileMetaInformation();
                    return new DataWriterAdapter(din.readDataset());
                }
            }
            PixelCodec.Uncompressed u = codec.toUncompressed(inst.getFile().toPath());
            if (u == null) {
                throw new DicomServiceException(Status.ProcessingFailure, "圧縮画像を復号できません: " + inst.iuid);
            }
            return new DataWriterAdapter(u.ds());
        }

        @Override
        protected void close() {
            super.close();
            log.info("C-MOVE 完了: destination={} completed={} warning={} failed={} canceled={}", dest,
                    completed.size(), warning.size(), failed.size(), canceled);
            executor.shutdown();
            scheduled.shutdown();
        }
    }
}

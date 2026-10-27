/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.store.DicomInstance;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.net.Association;
import org.dcm4che3.net.Commands;
import org.dcm4che3.net.Dimse;
import org.dcm4che3.net.Status;
import org.dcm4che3.net.TransferCapability;
import org.dcm4che3.net.pdu.PresentationContext;
import org.dcm4che3.net.service.BasicCGetSCP;
import org.dcm4che3.net.service.DicomServiceException;
import org.dcm4che3.net.service.InstanceLocator;
import org.dcm4che3.net.service.RetrieveTask;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 他端末からの C-GET に応え、ローカル索引の画像を、<b>要求を受けた接続の上で</b>返す（Patient Root / Study Root）。
 *
 * <p>C-MOVE（{@link DicomMoveScp}）は別の接続で宛先へ逆接続するので、ファイアウォール越しの相手には返せない。
 * C-GET は同じ接続で返せる。ただし相手が<b>役割選択（SCP/SCU role selection）</b>で「保存 SOP クラスを受ける側になる」と
 * 提示していることが前提で、提示していない相手には画像を返さず、その画像を失敗として数える（黙って落とさない）。
 * 許可（{@link DicomQrAccess}）・対象の解決（{@link DicomMoveTargets}）・転送構文の選び方は C-MOVE と同じ。
 */
public class DicomGetScp extends BasicCGetSCP {

    private static final Logger log = LoggerFactory.getLogger(DicomGetScp.class);

    private final DicomQrAccess access;
    private final DicomMoveTargets targets;
    private final PixelCodec codec;

    public DicomGetScp(DicomQrAccess access, DicomMoveTargets targets, PixelCodec codec) {
        super(UID.PatientRootQueryRetrieveInformationModelGet, UID.StudyRootQueryRetrieveInformationModelGet);
        this.access = access;
        this.targets = targets;
        this.codec = codec;
    }

    /** この SCP が受理する Presentation Context（SCP ロール、Implicit/Explicit VR Little Endian）。 */
    public static TransferCapability[] capabilities() {
        return new TransferCapability[] {
                new TransferCapability(null, UID.PatientRootQueryRetrieveInformationModelGet,
                        TransferCapability.Role.SCP, UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian),
                new TransferCapability(null, UID.StudyRootQueryRetrieveInformationModelGet,
                        TransferCapability.Role.SCP, UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian)
        };
    }

    @Override
    protected RetrieveTask calculateMatches(Association as, PresentationContext pc, Attributes rq, Attributes keys)
            throws DicomServiceException {
        String caller = as.getCallingAET();
        if (!access.allows(caller)) {
            log.warn("C-GET を拒否しました（許可されていない相手）: callingAE={} from={}", caller, as.getSocket().getRemoteSocketAddress());
            throw new DicomServiceException(Status.UnableToProcess, "この相手からの取得は許可されていません");
        }
        boolean patientRoot = UID.PatientRootQueryRetrieveInformationModelGet.equals(rq.getString(Tag.AffectedSOPClassUID));
        List<DicomMoveTargets.Target> found;
        try {
            found = targets.resolve(patientRoot, keys);
        } catch (DicomServiceException e) {
            throw e;
        } catch (RuntimeException e) {
            log.warn("C-GET の対象を保管庫から用意できません: {}", e.toString());
            throw new DicomServiceException(Status.UnableToProcess, "保管庫から画像を用意できませんでした");
        }
        log.info("C-GET: callingAE={} level={} instances={}", caller, keys.getString(Tag.QueryRetrieveLevel), found.size());
        if (found.isEmpty()) {
            return new EmptyTask(as, pc, rq);
        }
        List<InstanceLocator> insts = new ArrayList<>(found.size());
        for (DicomMoveTargets.Target t : found) {
            DicomInstance i = t.instance();
            String tsuid = i.getTransferSyntaxUid();
            if (tsuid == null && t.path() != null) {
                tsuid = transferSyntaxOf(t.path());
            }
            String uri = t.path() == null ? null : t.path().toUri().toString();
            insts.add(new InstanceLocator(i.getSopClassUid(), i.getSopInstanceUid(), tsuid, uri));
        }
        GetTask task = new GetTask(as, pc, rq, insts, codec);
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

    /** 対象が 0 件のとき。成功（残り 0 件）をそのまま返す。 */
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
            as.tryWriteDimseRSP(pc, Commands.mkCGetRSP(rq, Status.Success));
        }

        @Override
        public void onCancelRQ(Association association) {
            // 即座に終わるので何もしない
        }
    }

    /** 受けた接続そのものへ C-STORE する。 */
    private static final class GetTask extends StoredFileRetrieveTask {

        GetTask(Association as, PresentationContext pc, Attributes rq, List<InstanceLocator> insts, PixelCodec codec) {
            super(Dimse.C_GET_RQ, as, pc, rq, insts, as, codec);
        }

        @Override
        protected void close() {
            super.close();
            log.info("C-GET 完了: completed={} warning={} failed={} canceled={}",
                    completed.size(), warning.size(), failed.size(), canceled);
        }
    }
}

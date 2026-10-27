/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.net.Association;
import org.dcm4che3.net.Status;
import org.dcm4che3.net.TransferCapability;
import org.dcm4che3.net.pdu.PresentationContext;
import org.dcm4che3.net.service.BasicCFindSCP;
import org.dcm4che3.net.service.BasicQueryTask;
import org.dcm4che3.net.service.DicomServiceException;
import org.dcm4che3.net.service.QueryTask;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Iterator;
import java.util.List;

/**
 * 他端末からの C-FIND に、ローカル索引の内容で応える（Patient Root / Study Root）。
 *
 * <p>呼び出し AE が許可されていなければ、結果を返さず 0xC000 で失敗にする（接続元はログに残す）。
 * 許可の判定は要求のたびに行う。C-STORE・C-ECHO には関係しない。
 */
public class DicomFindScp extends BasicCFindSCP {

    private static final Logger log = LoggerFactory.getLogger(DicomFindScp.class);

    private final DicomQrAccess access;
    private final DicomFindQuery query;

    public DicomFindScp(DicomQrAccess access, DicomFindQuery query) {
        super(UID.PatientRootQueryRetrieveInformationModelFind, UID.StudyRootQueryRetrieveInformationModelFind);
        this.access = access;
        this.query = query;
    }

    /** この SCP が受理する Presentation Context（SCP ロール、Implicit/Explicit VR Little Endian）。 */
    public static TransferCapability[] capabilities() {
        return new TransferCapability[] {
                new TransferCapability(null, UID.PatientRootQueryRetrieveInformationModelFind,
                        TransferCapability.Role.SCP, UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian),
                new TransferCapability(null, UID.StudyRootQueryRetrieveInformationModelFind,
                        TransferCapability.Role.SCP, UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian)
        };
    }

    @Override
    protected QueryTask calculateMatches(Association as, PresentationContext pc, Attributes rq, Attributes keys)
            throws DicomServiceException {
        String caller = as.getCallingAET();
        if (!access.allows(caller)) {
            log.warn("C-FIND を拒否しました（許可されていない相手）: callingAE={} from={}", caller, as.getSocket().getRemoteSocketAddress());
            throw new DicomServiceException(Status.UnableToProcess, "この相手からの検索は許可されていません");
        }
        // 受理側の PresentationContext は抽象構文を持たない。要求コマンドの AffectedSOPClassUID で判別する。
        boolean patientRoot = UID.PatientRootQueryRetrieveInformationModelFind.equals(rq.getString(Tag.AffectedSOPClassUID));
        List<Attributes> matches = query.find(patientRoot, keys);
        log.info("C-FIND: callingAE={} level={} matches={}", caller, keys.getString(Tag.QueryRetrieveLevel), matches.size());
        return new ListQueryTask(as, pc, rq, keys, matches);
    }

    /** 計算済みの一致を 1 件ずつ返す。戻すのは要求（keys）に含まれた属性だけ。 */
    private static final class ListQueryTask extends BasicQueryTask {

        private final Iterator<Attributes> it;

        ListQueryTask(Association as, PresentationContext pc, Attributes rq, Attributes keys, List<Attributes> matches) {
            super(as, pc, rq, keys);
            this.it = matches.iterator();
        }

        @Override
        protected boolean hasMoreMatches() {
            return it.hasNext();
        }

        @Override
        protected Attributes nextMatch() {
            return it.next();
        }

        /**
         * 要求に含まれたタグを戻す。索引に無い属性は、値の無い（長さ 0）属性として戻す
         * （要求されたものを黙って欠かさない）。
         */
        @Override
        protected Attributes adjust(Attributes match) {
            if (match == null) {
                return null;
            }
            Attributes out = new Attributes(keys.size() + 1);
            // 索引の文字列は Unicode で持っているので、日本語などを欠かさず返せる UTF-8 で返す。
            out.setString(Tag.SpecificCharacterSet, VR.CS, "ISO_IR 192");
            for (int tag : keys.tags()) {
                if (tag == Tag.SpecificCharacterSet) {
                    continue;
                }
                if (tag == Tag.QueryRetrieveLevel) {
                    out.setString(tag, VR.CS, keys.getString(tag)); // 要求のレベルをそのまま返す
                } else if (match.contains(tag)) {
                    out.addSelected(match, tag);
                } else {
                    out.setNull(tag, keys.getVR(tag));
                }
            }
            // 各レベルの一意キー（UID。PATIENT レベルは PatientID）は、要求に無くても必ず返す。
            int[] unique = "PATIENT".equals(keys.getString(Tag.QueryRetrieveLevel))
                    ? new int[] {Tag.PatientID}
                    : new int[] {Tag.StudyInstanceUID, Tag.SeriesInstanceUID, Tag.SOPInstanceUID};
            for (int tag : unique) {
                if (!out.contains(tag) && match.contains(tag)) {
                    out.addSelected(match, tag);
                }
            }
            return out;
        }
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Code;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Map;

/**
 * {@link SrWriter}（Comprehensive SR）と {@link KeyObjectWriter}（KO）で共通の
 * content item / evidence sequence 構築ヘルパー（`fw/report-design.md` §4/§8.2, §8.3）。
 */
final class SrSupport {

    private SrSupport() {
    }

    static Attributes codeItem(Code code) {
        Attributes item = new Attributes();
        item.setString(Tag.CodeValue, VR.SH, code.getCodeValue());
        item.setString(Tag.CodingSchemeDesignator, VR.SH, code.getCodingSchemeDesignator());
        item.setString(Tag.CodeMeaning, VR.LO, code.getCodeMeaning());
        return item;
    }

    /** IMAGE content item（Image Reference Macro, ConceptNameCodeSequence=キー画像共通概念）。 */
    static Attributes imageItem(KeyImageRef k, String sopClassUid) {
        Attributes item = new Attributes();
        item.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
        item.setString(Tag.ValueType, VR.CS, "IMAGE");
        item.newSequence(Tag.ConceptNameCodeSequence, 1).add(codeItem(SrCodes.KEY_IMAGE));
        Attributes sopRef = new Attributes();
        sopRef.setString(Tag.ReferencedSOPClassUID, VR.UI, sopClassUid);
        sopRef.setString(Tag.ReferencedSOPInstanceUID, VR.UI, k.getSopInstanceUid());
        if (k.getFrameNumber() != null) {
            sopRef.setInt(Tag.ReferencedFrameNumber, VR.IS, k.getFrameNumber());
        }
        item.newSequence(Tag.ReferencedSOPSequence, 1).add(sopRef);
        return item;
    }

    static List<ReportParticipant> byType(Report report, ParticipationType type) {
        return report.getParticipants().stream().filter(p -> p.getParticipationType() == type).toList();
    }

    static Attributes personObserverItem(String name) {
        Attributes item = new Attributes();
        item.setString(Tag.ObserverType, VR.CS, "PSN");
        item.setString(Tag.PersonName, VR.PN, name);
        return item;
    }

    static Attributes verifyingObserverItem(ReportParticipant v, Date fallbackDateTime) {
        Attributes item = new Attributes();
        item.setString(Tag.VerifyingObserverName, VR.PN, v.getName());
        if (v.getOrganization() != null && !v.getOrganization().isBlank()) {
            item.setString(Tag.VerifyingOrganization, VR.LO, v.getOrganization());
        }
        Date dt = v.getParticipatedAt() != null ? Date.from(v.getParticipatedAt()) : fallbackDateTime;
        item.setDate(Tag.VerificationDateTime, VR.DT, dt);
        return item;
    }

    static Attributes participantItem(ReportParticipant p) {
        Attributes item = new Attributes();
        item.setString(Tag.ParticipationType, VR.CS,
                p.getParticipationType() == ParticipationType.ENTERER ? "ENT" : "ATTEST");
        item.setString(Tag.ObserverType, VR.CS, "PSN");
        item.setString(Tag.PersonName, VR.PN, p.getName());
        if (p.getParticipatedAt() != null) {
            item.setDate(Tag.ParticipationDateTime, VR.DT, Date.from(p.getParticipatedAt()));
        }
        if (p.getOrganization() != null && !p.getOrganization().isBlank()) {
            item.setString(Tag.InstitutionName, VR.LO, p.getOrganization());
        }
        return item;
    }

    /** {studyUid, series単位にグルーピングされた {sopClassUid, sopInstanceUid} 群} から Evidence の Study item を組む。 */
    static Attributes evidenceStudyItem(String studyInstanceUid, Map<String, List<String[]>> bySeries) {
        Attributes studyItem = new Attributes();
        studyItem.setString(Tag.StudyInstanceUID, VR.UI, studyInstanceUid);
        Sequence seriesSeq = studyItem.newSequence(Tag.ReferencedSeriesSequence, bySeries.size());
        for (Map.Entry<String, List<String[]>> e : bySeries.entrySet()) {
            Attributes seriesItem = new Attributes();
            seriesItem.setString(Tag.SeriesInstanceUID, VR.UI, e.getKey());
            Sequence sopSeq = seriesItem.newSequence(Tag.ReferencedSOPSequence, e.getValue().size());
            for (String[] ref : e.getValue()) {
                Attributes sopItem = new Attributes();
                sopItem.setString(Tag.ReferencedSOPClassUID, VR.UI, ref[0]);
                sopItem.setString(Tag.ReferencedSOPInstanceUID, VR.UI, ref[1]);
                sopSeq.add(sopItem);
            }
            seriesSeq.add(seriesItem);
        }
        return studyItem;
    }

    static void addSeriesSopRef(Map<String, List<String[]>> bySeries, String seriesUid, String sopClassUid, String sopInstanceUid) {
        bySeries.computeIfAbsent(seriesUid, s -> new ArrayList<>()).add(new String[] {sopClassUid, sopInstanceUid});
    }

    static void copyTag(Attributes from, Attributes to, int tag) {
        if (!from.contains(tag)) {
            return;
        }
        VR vr = from.getVR(tag);
        String[] v = from.getStrings(tag);
        if (v != null && v.length > 0) {
            to.setString(tag, vr, v);
        }
    }
}

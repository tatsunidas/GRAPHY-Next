/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Code;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.util.UIDUtils;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 自由記述レポート（Markdown）を DICOM Comprehensive SR（自由記述, 手組み）に変換する
 * （`fw/report-design.md` §4, R2）。TID には拠らない簡易構造:
 * ルート CONTAINER（LOINC 18748-4） - TEXT（History, 任意）/ TEXT（本文）/ IMAGE（キー画像, 任意）。
 *
 * <p>dcm4che に高レベル SR ビルダーは無いため {@link Attributes} をタグレベルで組む。参照シリーズの
 * 幾何は扱わない（RTSTRUCT/SEG と異なり SR は座標を持たない自由記述のため）。
 */
@Component
class SrWriter {

    /** 生成結果。{@code dataset} は FileMetaInformation を含まない本体データセット。 */
    record Result(Attributes dataset, String seriesInstanceUid, String sopInstanceUid) {
    }

    /**
     * @param referenceTemplate 患者/スタディ識別情報の継承元（対象スタディ内の任意の既存インスタンスのヘッダ）
     * @param report            レポート本体（{@code status=DRAFT} 前提、呼び出し側で確認済みとする）
     * @param keyImageSopClassUids キー画像 SOPInstanceUID → SOPClassUID（呼び出し側でローカル索引から解決）
     */
    Result build(Attributes referenceTemplate, Report report, Map<String, String> keyImageSopClassUids) {
        String newSeriesUid = UIDUtils.createUID();
        String newSopUid = UIDUtils.createUID();

        Attributes ds = new Attributes();
        for (int tag : new int[] {
                Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex,
                Tag.StudyInstanceUID, Tag.StudyDate, Tag.StudyTime, Tag.StudyID, Tag.AccessionNumber,
                Tag.ReferringPhysicianName, Tag.StudyDescription }) {
            SrSupport.copyTag(referenceTemplate, ds, tag);
        }
        if (report.getReferringPhysician() != null && !report.getReferringPhysician().isBlank()) {
            ds.setString(Tag.ReferringPhysicianName, VR.PN, report.getReferringPhysician());
        }

        ds.setString(Tag.SpecificCharacterSet, VR.CS, "ISO_IR 192");
        ds.setString(Tag.SOPClassUID, VR.UI, UID.ComprehensiveSRStorage);
        ds.setString(Tag.SOPInstanceUID, VR.UI, newSopUid);
        ds.setString(Tag.Modality, VR.CS, "SR");
        ds.setString(Tag.SeriesInstanceUID, VR.UI, newSeriesUid);
        ds.setInt(Tag.SeriesNumber, VR.IS, 9001);
        ds.setInt(Tag.InstanceNumber, VR.IS, 1);
        String title = report.getTitle() != null && !report.getTitle().isBlank() ? report.getTitle() : "Report";
        ds.setString(Tag.SeriesDescription, VR.LO, "Report: " + title);

        Date now = new Date();
        ds.setDate(Tag.ContentDate, VR.DA, now);
        ds.setDate(Tag.ContentTime, VR.TM, now);
        ds.setString(Tag.CompletionFlag, VR.CS, "COMPLETE");

        List<ReportParticipant> verifiers = SrSupport.byType(report, ParticipationType.VERIFIER);
        ds.setString(Tag.VerificationFlag, VR.CS, verifiers.isEmpty() ? "UNVERIFIED" : "VERIFIED");
        if (!verifiers.isEmpty()) {
            Sequence vSeq = ds.newSequence(Tag.VerifyingObserverSequence, verifiers.size());
            for (ReportParticipant v : verifiers) {
                vSeq.add(SrSupport.verifyingObserverItem(v, now));
            }
        }

        List<ReportParticipant> authors = SrSupport.byType(report, ParticipationType.AUTHOR);
        if (!authors.isEmpty()) {
            Sequence aSeq = ds.newSequence(Tag.AuthorObserverSequence, authors.size());
            for (ReportParticipant a : authors) {
                aSeq.add(SrSupport.personObserverItem(a.getName()));
            }
        }

        List<ReportParticipant> participants = new ArrayList<>(SrSupport.byType(report, ParticipationType.ENTERER));
        participants.addAll(SrSupport.byType(report, ParticipationType.REVIEWER));
        if (!participants.isEmpty()) {
            Sequence pSeq = ds.newSequence(Tag.ParticipantSequence, participants.size());
            for (ReportParticipant p : participants) {
                pSeq.add(SrSupport.participantItem(p));
            }
        }

        ds.setString(Tag.ValueType, VR.CS, "CONTAINER");
        ds.setString(Tag.ContinuityOfContent, VR.CS, "SEPARATE");
        ds.newSequence(Tag.ConceptNameCodeSequence, 1).add(SrSupport.codeItem(SrCodes.DOC_TITLE_IMAGING_REPORT));

        List<Attributes> children = new ArrayList<>();
        if (report.getClinicalHistory() != null && !report.getClinicalHistory().isBlank()) {
            children.add(textItem(SrCodes.HISTORY, report.getClinicalHistory()));
        }
        String bodyText = MarkdownPlainText.flatten(report.getBodyMarkdown());
        if (!bodyText.isBlank()) {
            children.add(textItem(SrCodes.REPORT_BODY, bodyText));
        }
        for (KeyImageRef k : report.getKeyImages()) {
            children.add(SrSupport.imageItem(k, keyImageSopClassUids.get(k.getSopInstanceUid())));
        }
        Sequence cs = ds.newSequence(Tag.ContentSequence, children.size());
        cs.addAll(children);

        Map<String, List<String[]>> bySeries = new LinkedHashMap<>();
        String refSeries = referenceTemplate.getString(Tag.SeriesInstanceUID);
        if (refSeries != null) {
            SrSupport.addSeriesSopRef(bySeries, refSeries,
                    referenceTemplate.getString(Tag.SOPClassUID), referenceTemplate.getString(Tag.SOPInstanceUID));
        }
        for (KeyImageRef k : report.getKeyImages()) {
            SrSupport.addSeriesSopRef(bySeries, k.getSeriesInstanceUid(),
                    keyImageSopClassUids.get(k.getSopInstanceUid()), k.getSopInstanceUid());
        }
        ds.newSequence(Tag.CurrentRequestedProcedureEvidenceSequence, 1)
                .add(SrSupport.evidenceStudyItem(report.getStudyInstanceUid(), bySeries));

        return new Result(ds, newSeriesUid, newSopUid);
    }

    private Attributes textItem(Code concept, String value) {
        Attributes item = new Attributes();
        item.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
        item.setString(Tag.ValueType, VR.CS, "TEXT");
        item.newSequence(Tag.ConceptNameCodeSequence, 1).add(SrSupport.codeItem(concept));
        item.setString(Tag.TextValue, VR.UT, value);
        return item;
    }
}

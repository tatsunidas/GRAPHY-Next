/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import org.dcm4che3.data.Attributes;
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
 * レポートのキー画像を DICOM Key Object Selection Document(KO) に変換する
 * （`fw/report-design.md` §4/§8.3, R3）。SOP Class {@code 1.2.840.10008.5.1.4.1.1.88.59}。
 *
 * <p>KO の IOD は SR（Comprehensive SR 等）と異なり <b>SR Document General Module を持たない</b>
 * （NEMA PS3.3 確認済み）。代わりに <i>Key Object Document Module</i>（ContentDate/ContentTime/
 * InstanceNumber/CurrentRequestedProcedureEvidenceSequence, いずれも Type 1）と
 * <i>Key Object Document Series Module</i>（Modality=KO/SeriesInstanceUID/SeriesNumber, Type 1、
 * ReferencedPerformedProcedureStepSequence は Type 2 で空シーケンスを許容）を持つ。
 * そのため {@code CompletionFlag}/{@code VerificationFlag}/Author・Verifying Observer・Participant
 * Sequence は KO には**含めない**（SR 側の付帯情報で足りる。KO はあくまで SR の姉妹アーティファクト）。
 */
@Component
class KeyObjectWriter {

    record Result(Attributes dataset, String seriesInstanceUid, String sopInstanceUid) {
    }

    /**
     * @param referenceTemplate    患者/スタディ識別情報の継承元
     * @param report               キー画像を 1 件以上持つレポート
     * @param keyImageSopClassUids キー画像 SOPInstanceUID → SOPClassUID
     */
    Result build(Attributes referenceTemplate, Report report, Map<String, String> keyImageSopClassUids) {
        if (report.getKeyImages().isEmpty()) {
            throw new IllegalStateException("キー画像が無いレポートから KO は生成できません: " + report.getId());
        }
        String newSeriesUid = UIDUtils.createUID();
        String newSopUid = UIDUtils.createUID();

        Attributes ds = new Attributes();
        for (int tag : new int[] {
                Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex,
                Tag.StudyInstanceUID, Tag.StudyDate, Tag.StudyTime, Tag.StudyID, Tag.AccessionNumber,
                Tag.ReferringPhysicianName, Tag.StudyDescription }) {
            SrSupport.copyTag(referenceTemplate, ds, tag);
        }

        ds.setString(Tag.SpecificCharacterSet, VR.CS, "ISO_IR 192");
        ds.setString(Tag.SOPClassUID, VR.UI, UID.KeyObjectSelectionDocumentStorage);
        ds.setString(Tag.SOPInstanceUID, VR.UI, newSopUid);

        // Key Object Document Series Module（Type 1: Modality/SeriesInstanceUID/SeriesNumber。
        // ReferencedPerformedProcedureStepSequence は Type 2 なので空シーケンスで満たす）。
        ds.setString(Tag.Modality, VR.CS, "KO");
        ds.setString(Tag.SeriesInstanceUID, VR.UI, newSeriesUid);
        ds.setInt(Tag.SeriesNumber, VR.IS, 9002);
        String title = report.getTitle() != null && !report.getTitle().isBlank() ? report.getTitle() : "Report";
        ds.setString(Tag.SeriesDescription, VR.LO, "Key Images: " + title);
        ds.newSequence(Tag.ReferencedPerformedProcedureStepSequence, 0);

        // Key Object Document Module（Type 1 属性）。
        Date now = new Date();
        ds.setDate(Tag.ContentDate, VR.DA, now);
        ds.setDate(Tag.ContentTime, VR.TM, now);
        ds.setInt(Tag.InstanceNumber, VR.IS, 1);

        Map<String, List<String[]>> bySeries = new LinkedHashMap<>();
        for (KeyImageRef k : report.getKeyImages()) {
            SrSupport.addSeriesSopRef(bySeries, k.getSeriesInstanceUid(),
                    keyImageSopClassUids.get(k.getSopInstanceUid()), k.getSopInstanceUid());
        }
        ds.newSequence(Tag.CurrentRequestedProcedureEvidenceSequence, 1)
                .add(SrSupport.evidenceStudyItem(report.getStudyInstanceUid(), bySeries));

        // SR Document Content Module: ルート CONTAINER（DCM 113000 "Of Interest"）+ IMAGE 群。
        ds.setString(Tag.ValueType, VR.CS, "CONTAINER");
        ds.setString(Tag.ContinuityOfContent, VR.CS, "SEPARATE");
        ds.newSequence(Tag.ConceptNameCodeSequence, 1).add(SrSupport.codeItem(SrCodes.KEY_IMAGE));

        List<Attributes> children = new ArrayList<>();
        for (KeyImageRef k : report.getKeyImages()) {
            children.add(SrSupport.imageItem(k, keyImageSopClassUids.get(k.getSopInstanceUid())));
        }
        Sequence cs = ds.newSequence(Tag.ContentSequence, children.size());
        cs.addAll(children);

        return new Result(ds, newSeriesUid, newSopUid);
    }
}

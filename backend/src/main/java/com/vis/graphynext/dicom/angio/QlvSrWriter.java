/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Code;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.util.UIDUtils;

import java.util.Date;

/**
 * QLV（左室造影）の結果を Comprehensive SR として組み立てる
 * （{@code fw/angio-design.md} §9.2 / A5b）。純関数。
 *
 * <h3>コードの方針</h3>
 * {@link QcaSrWriter} と同じ。標準コードを確認できていないので <b>private scheme
 * （99GRAPHYNEXT）</b>で書く。自信の無い標準コードを当てずっぽうで書くと、
 * <b>他システムが別の意味として解釈する</b>ので private のほうが安全。
 *
 * <h3>🚨 未校正でも EF は書くが、容積は書かない</h3>
 * 体積は長さの 3 乗に比例するので、未知の倍率は EF = 1 − ESV/EDV で完全に打ち消される。
 * よって<b>未校正でも EF は正しい</b>。一方で容積の絶対値は出せないので、
 * {@code unit == null} のときは EDV/ESV の項目を<b>書かない</b>（px³ を mL と偽らない）。
 * Kennedy 補正は定数項を持つアフィン変換でスケール不変ではないため、同様に書かない。
 */
final class QlvSrWriter {

    private static final Code DOC_TITLE = new Code("18748-4", "LN", null, "Diagnostic Imaging Report");
    private static final Code QLV_CONTAINER = new Code("QLV", "99GRAPHYNEXT", null, "Quantitative Left Ventriculography");
    private static final Code EF = new Code("EF", "99GRAPHYNEXT", null, "Ejection Fraction");
    private static final Code EDV = new Code("EDV", "99GRAPHYNEXT", null, "End Diastolic Volume");
    private static final Code ESV = new Code("ESV", "99GRAPHYNEXT", null, "End Systolic Volume");
    private static final Code EF_CORR = new Code("EFCORR", "99GRAPHYNEXT", null, "Ejection Fraction (Kennedy corrected)");
    private static final Code EDV_CORR = new Code("EDVCORR", "99GRAPHYNEXT", null, "End Diastolic Volume (Kennedy corrected)");
    private static final Code ESV_CORR = new Code("ESVCORR", "99GRAPHYNEXT", null, "End Systolic Volume (Kennedy corrected)");
    private static final Code CALIBRATION = new Code("CALIB", "99GRAPHYNEXT", null, "Spatial Calibration");
    private static final Code FRAME_SELECTION = new Code("FRAMESEL", "99GRAPHYNEXT", null, "ED/ES Frame Selection");
    private static final Code METHOD = new Code("METHOD", "99GRAPHYNEXT", null, "Analysis Method");
    private static final Code OF_INTEREST = new Code("113000", "DCM", null, "Of Interest");

    private QlvSrWriter() {
    }

    record Result(Attributes dataset, String seriesInstanceUid, String sopInstanceUid) {
    }

    static Result build(Attributes referenceTemplate, QlvSrRequest req) {
        String seriesUid = UIDUtils.createUID();
        String sopUid = UIDUtils.createUID();
        Date now = new Date();
        boolean calibrated = req.unit() != null && !req.unit().isBlank();

        Attributes ds = new Attributes();
        for (int tag : new int[] {
                Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex,
                Tag.StudyInstanceUID, Tag.StudyDate, Tag.StudyTime, Tag.StudyID, Tag.AccessionNumber,
                Tag.ReferringPhysicianName, Tag.StudyDescription }) {
            if (referenceTemplate != null && referenceTemplate.containsValue(tag)) {
                ds.setString(tag, referenceTemplate.getVR(tag), referenceTemplate.getString(tag));
            }
        }
        ds.setString(Tag.SpecificCharacterSet, VR.CS, "ISO_IR 192");
        ds.setString(Tag.SOPClassUID, VR.UI, UID.ComprehensiveSRStorage);
        ds.setString(Tag.SOPInstanceUID, VR.UI, sopUid);
        ds.setString(Tag.Modality, VR.CS, "SR");
        ds.setString(Tag.SeriesInstanceUID, VR.UI, seriesUid);
        ds.setInt(Tag.SeriesNumber, VR.IS, 9101);
        ds.setInt(Tag.InstanceNumber, VR.IS, 1);
        ds.setDate(Tag.ContentDate, VR.DA, now);
        ds.setDate(Tag.ContentTime, VR.TM, now);
        ds.setString(Tag.SeriesDescription, VR.LO, "QLV");
        ds.setString(Tag.CompletionFlag, VR.CS, "COMPLETE");
        ds.setString(Tag.VerificationFlag, VR.CS, "UNVERIFIED");

        ds.setString(Tag.ValueType, VR.CS, "CONTAINER");
        ds.setString(Tag.ContinuityOfContent, VR.CS, "SEPARATE");
        ds.newSequence(Tag.ConceptNameCodeSequence, 1).add(codeItem(DOC_TITLE));

        Sequence root = ds.newSequence(Tag.ContentSequence, 4);

        // ED と ES の両方を参照する。どちらのフレームで測ったかが残らないと再現できない。
        root.add(imageRef(referenceTemplate, req.sopInstanceUid(), req.edFrameNumber()));
        if (req.esFrameNumber() != null && !req.esFrameNumber().equals(req.edFrameNumber())) {
            root.add(imageRef(referenceTemplate, req.sopInstanceUid(), req.esFrameNumber()));
        }

        Attributes group = new Attributes();
        group.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
        group.setString(Tag.ValueType, VR.CS, "CONTAINER");
        group.setString(Tag.ContinuityOfContent, VR.CS, "SEPARATE");
        group.newSequence(Tag.ConceptNameCodeSequence, 1).add(codeItem(QLV_CONTAINER));
        Sequence items = group.newSequence(Tag.ContentSequence, 10);

        // EF は校正の有無によらず書ける（スケール不変）。
        items.add(num(EF, req.ejectionFraction(), "%"));
        if (calibrated && req.edvMl() != null && req.esvMl() != null) {
            items.add(num(EDV, req.edvMl(), "mL"));
            items.add(num(ESV, req.esvMl(), "mL"));
        }
        if (calibrated && req.kennedyEjectionFraction() != null) {
            items.add(num(EF_CORR, req.kennedyEjectionFraction(), "%"));
            if (req.kennedyEdvMl() != null) {
                items.add(num(EDV_CORR, req.kennedyEdvMl(), "mL"));
            }
            if (req.kennedyEsvMl() != null) {
                items.add(num(ESV_CORR, req.kennedyEsvMl(), "mL"));
            }
        }
        if (req.calibration() != null && !req.calibration().isBlank()) {
            items.add(text(CALIBRATION, req.calibration()));
        }
        // ED/ES を人が選んだか自動提案のままかは**必ず**残す。
        // 全自動でも "automatic" と明示する（項目が無いことを「人が選んだ」と読ませない）。
        items.add(text(FRAME_SELECTION,
                req.frameSelection() != null && !req.frameSelection().isBlank()
                        ? req.frameSelection()
                        : "automatic (area curve)"));
        items.add(text(METHOD,
                (req.method() != null && !req.method().isBlank() ? req.method() : "Area-Length (single plane)")
                        + " — GRAPHY-Next QLV (research use only). "
                        + "Area-Length assumes an ellipsoidal ventricle. "
                        + (calibrated
                                ? "Kennedy regression is affine and therefore requires spatial calibration."
                                : "NOT SPATIALLY CALIBRATED: ejection fraction is still valid (scale invariant), "
                                        + "but absolute volumes and the Kennedy correction are not reported.")));
        root.add(group);

        return new Result(ds, seriesUid, sopUid);
    }

    private static Attributes imageRef(Attributes template, String sopUid, Integer frameNumber) {
        Attributes img = new Attributes();
        img.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
        img.setString(Tag.ValueType, VR.CS, "IMAGE");
        img.newSequence(Tag.ConceptNameCodeSequence, 1).add(codeItem(OF_INTEREST));
        Attributes sopRef = new Attributes();
        sopRef.setString(Tag.ReferencedSOPClassUID, VR.UI,
                template == null ? "1.2.840.10008.5.1.4.1.1.12.1"
                        : template.getString(Tag.SOPClassUID, "1.2.840.10008.5.1.4.1.1.12.1"));
        sopRef.setString(Tag.ReferencedSOPInstanceUID, VR.UI, sopUid);
        if (frameNumber != null) {
            sopRef.setInt(Tag.ReferencedFrameNumber, VR.IS, frameNumber);
        }
        img.newSequence(Tag.ReferencedSOPSequence, 1).add(sopRef);
        return img;
    }

    private static Attributes codeItem(Code code) {
        Attributes item = new Attributes();
        item.setString(Tag.CodeValue, VR.SH, code.getCodeValue());
        item.setString(Tag.CodingSchemeDesignator, VR.SH, code.getCodingSchemeDesignator());
        item.setString(Tag.CodeMeaning, VR.LO, code.getCodeMeaning());
        return item;
    }

    private static Attributes num(Code concept, double value, String ucumUnit) {
        Attributes item = new Attributes();
        item.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
        item.setString(Tag.ValueType, VR.CS, "NUM");
        item.newSequence(Tag.ConceptNameCodeSequence, 1).add(codeItem(concept));
        Attributes measured = new Attributes();
        measured.setDouble(Tag.NumericValue, VR.DS, Math.round(value * 1000.0) / 1000.0);
        measured.newSequence(Tag.MeasurementUnitsCodeSequence, 1)
                .add(codeItem(new Code(ucumUnit, "UCUM", null, ucumUnit)));
        item.newSequence(Tag.MeasuredValueSequence, 1).add(measured);
        return item;
    }

    private static Attributes text(Code concept, String value) {
        Attributes item = new Attributes();
        item.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
        item.setString(Tag.ValueType, VR.CS, "TEXT");
        item.newSequence(Tag.ConceptNameCodeSequence, 1).add(codeItem(concept));
        item.setString(Tag.TextValue, VR.UT, value);
        return item;
    }
}

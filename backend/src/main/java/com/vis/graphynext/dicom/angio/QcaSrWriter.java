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
 * QCA 解析結果を Comprehensive SR として組み立てる（{@code fw/angio-design.md} §14.2 / A10）。純関数。
 *
 * <h3>コードの方針</h3>
 * MLD / RVD / %DS などに対応する DICOM 標準コードを<b>確認できていない</b>ため、
 * {@code report/SrCodes} と同じ方針で <b>private scheme（99GRAPHYNEXT）＋人が読める CodeMeaning</b>
 * で書く。標準コードが確定したら差し替える（設計 §20-4）。
 * <p>⚠️ 自信の無い標準コードを当てずっぽうで書くと、<b>他システムが別の意味として解釈する</b>ので
 * かえって危ない。private であることが明示されているほうが安全。
 *
 * <h3>単位</h3>
 * UCUM（"mm" / "%"）。未校正の解析は {@code unit="px"} が来るので、その場合は
 * <b>UCUM ではなく private の単位コード</b>にして「mm を騙らない」。
 */
final class QcaSrWriter {

    /** ルート文書タイトル（report/SrCodes と同じ LOINC を使う）。 */
    private static final Code DOC_TITLE = new Code("18748-4", "LN", null, "Diagnostic Imaging Report");
    private static final Code QCA_CONTAINER = new Code("QCA", "99GRAPHYNEXT", null, "Quantitative Coronary Analysis");
    private static final Code MLD = new Code("MLD", "99GRAPHYNEXT", null, "Minimum Lumen Diameter");
    private static final Code RVD = new Code("RVD", "99GRAPHYNEXT", null, "Reference Vessel Diameter");
    private static final Code PCT_DS = new Code("PCTDS", "99GRAPHYNEXT", null, "Percent Diameter Stenosis");
    private static final Code PCT_AS = new Code("PCTAS", "99GRAPHYNEXT", null, "Percent Area Stenosis");
    private static final Code LESION_LENGTH = new Code("LESLEN", "99GRAPHYNEXT", null, "Lesion Length");
    private static final Code CALIBRATION = new Code("CALIB", "99GRAPHYNEXT", null, "Spatial Calibration");
    private static final Code VESSEL = new Code("VESSEL", "99GRAPHYNEXT", null, "Vessel Segment");
    private static final Code METHOD = new Code("METHOD", "99GRAPHYNEXT", null, "Analysis Method");
    private static final Code MANUAL = new Code("MANUAL", "99GRAPHYNEXT", null, "Manual Correction");
    private static final Code DIAMETER_METHOD =
            new Code("DIAMMETHOD", "99GRAPHYNEXT", null, "Diameter Measurement Method");
    /** キー画像と同じ概念（report/SrCodes と揃える）。 */
    private static final Code OF_INTEREST = new Code("113000", "DCM", null, "Of Interest");

    private QcaSrWriter() {
    }

    record Result(Attributes dataset, String seriesInstanceUid, String sopInstanceUid) {
    }

    static Result build(Attributes referenceTemplate, QcaSrRequest req) {
        String seriesUid = UIDUtils.createUID();
        String sopUid = UIDUtils.createUID();
        Date now = new Date();
        boolean mm = !"px".equalsIgnoreCase(req.unit());

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
        ds.setInt(Tag.SeriesNumber, VR.IS, 9100);
        ds.setInt(Tag.InstanceNumber, VR.IS, 1);
        ds.setDate(Tag.ContentDate, VR.DA, now);
        ds.setDate(Tag.ContentTime, VR.TM, now);
        ds.setString(Tag.SeriesDescription, VR.LO, "QCA");
        ds.setString(Tag.CompletionFlag, VR.CS, "COMPLETE");
        ds.setString(Tag.VerificationFlag, VR.CS, "UNVERIFIED");

        ds.setString(Tag.ValueType, VR.CS, "CONTAINER");
        ds.setString(Tag.ContinuityOfContent, VR.CS, "SEPARATE");
        ds.newSequence(Tag.ConceptNameCodeSequence, 1).add(codeItem(DOC_TITLE));

        Sequence root = ds.newSequence(Tag.ContentSequence, 8);

        // 解析対象の画像（フレーム番号込み）。どのフレームを測ったのかが残らないと再現できない。
        Attributes img = new Attributes();
        img.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
        img.setString(Tag.ValueType, VR.CS, "IMAGE");
        img.newSequence(Tag.ConceptNameCodeSequence, 1).add(codeItem(OF_INTEREST));
        Attributes sopRef = new Attributes();
        sopRef.setString(Tag.ReferencedSOPClassUID, VR.UI,
                referenceTemplate == null ? "1.2.840.10008.5.1.4.1.1.12.1"
                        : referenceTemplate.getString(Tag.SOPClassUID, "1.2.840.10008.5.1.4.1.1.12.1"));
        sopRef.setString(Tag.ReferencedSOPInstanceUID, VR.UI, req.sopInstanceUid());
        if (req.frameNumber() != null) {
            sopRef.setInt(Tag.ReferencedFrameNumber, VR.IS, req.frameNumber());
        }
        img.newSequence(Tag.ReferencedSOPSequence, 1).add(sopRef);
        root.add(img);

        // 計測はまとめて 1 つの CONTAINER に入れる。
        Attributes group = new Attributes();
        group.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
        group.setString(Tag.ValueType, VR.CS, "CONTAINER");
        group.setString(Tag.ContinuityOfContent, VR.CS, "SEPARATE");
        group.newSequence(Tag.ConceptNameCodeSequence, 1).add(codeItem(QCA_CONTAINER));
        Sequence items = group.newSequence(Tag.ContentSequence, 8);

        if (req.vesselLabel() != null && !req.vesselLabel().isBlank()) {
            items.add(text(VESSEL, req.vesselLabel()));
        }
        items.add(num(MLD, req.mld(), mm ? "mm" : "px", mm));
        items.add(num(RVD, req.rvd(), mm ? "mm" : "px", mm));
        items.add(num(PCT_DS, req.percentDiameterStenosis(), "%", true));
        items.add(num(PCT_AS, req.percentAreaStenosis(), "%", true));
        items.add(num(LESION_LENGTH, req.lesionLength(), mm ? "mm" : "px", mm));
        if (req.calibration() != null && !req.calibration().isBlank()) {
            // 数値だけ残して出自を落とすと、あとから「この 1.5mm は何を基準に測ったのか」が分からなくなる。
            items.add(text(CALIBRATION, req.calibration()));
        }
        // 手修正の有無は**必ず**残す。手で直した値を自動値と同じ顔で保存すると、
        // 読む側が再現性を判断できない（設計 §8.6）。
        items.add(text(MANUAL,
                req.manualCorrection() != null && !req.manualCorrection().isBlank()
                        ? req.manualCorrection()
                        : "None (fully automatic)"));
        // 🚨 **測り方を必ず残す**（設計 §16.5）。密度計測と半値法では径の絶対値が
        //    10% 以上違ううえ、密度計測のときは**画面の輪郭（半値法）と数値が別方式**になる。
        //    これを書かないと、あとから数値の食い違いを説明できない。
        boolean densitometric = "densitometric".equalsIgnoreCase(req.diameterMethod());
        items.add(text(DIAMETER_METHOD, densitometric
                ? "Densitometric (attenuation integrated to a cross-sectional area; no shape assumed). "
                        + "The drawn outline comes from the half-maximum method and is a different measurement."
                : "Half-maximum (edge-based)."));
        // 面積狭窄率が円形断面の仮定であること・単一投影であることを SR 自体に残す。
        items.add(text(METHOD,
                "GRAPHY-Next QCA (research use only). %Area assumes a circular cross-section; "
                        + "single projection is affected by foreshortening and vessel overlap."
                        + (mm ? "" : " NOT SPATIALLY CALIBRATED: lengths are in pixels.")));
        root.add(group);

        return new Result(ds, seriesUid, sopUid);
    }

    private static Attributes codeItem(Code code) {
        Attributes item = new Attributes();
        item.setString(Tag.CodeValue, VR.SH, code.getCodeValue());
        item.setString(Tag.CodingSchemeDesignator, VR.SH, code.getCodingSchemeDesignator());
        item.setString(Tag.CodeMeaning, VR.LO, code.getCodeMeaning());
        return item;
    }

    /** NUM content item。{@code ucum=false} なら private の単位コード（"px" を UCUM と偽らない）。 */
    private static Attributes num(Code concept, double value, String unit, boolean ucum) {
        Attributes item = new Attributes();
        item.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
        item.setString(Tag.ValueType, VR.CS, "NUM");
        item.newSequence(Tag.ConceptNameCodeSequence, 1).add(codeItem(concept));
        Attributes measured = new Attributes();
        measured.setDouble(Tag.NumericValue, VR.DS, round3(value));
        Code unitCode = ucum
                ? new Code(unit, "UCUM", null, unit)
                : new Code(unit, "99GRAPHYNEXT", null, "pixels (not spatially calibrated)");
        measured.newSequence(Tag.MeasurementUnitsCodeSequence, 1).add(codeItem(unitCode));
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

    private static double round3(double v) {
        return Math.round(v * 1000.0) / 1000.0;
    }
}

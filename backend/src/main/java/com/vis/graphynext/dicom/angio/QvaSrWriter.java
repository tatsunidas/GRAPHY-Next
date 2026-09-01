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
import java.util.Locale;

/**
 * QVA（末梢・脳血管）解析結果を Comprehensive SR として組み立てる
 * （{@code fw/angio-design.md} §9.1 / A5a）。純関数。
 *
 * <h3>コードの方針</h3>
 * {@link QcaSrWriter} と同じ。標準コードを確認できていないので <b>private scheme
 * （99GRAPHYNEXT）＋人が読める CodeMeaning</b> で書く。自信の無い標準コードを当てずっぽうで
 * 書くと、<b>他システムが別の意味として解釈する</b>ぶんかえって危ない。
 *
 * <h3>🚨 瘤を「瘤」と書くときは基準も一緒に書く</h3>
 * 「動脈瘤」という語だけを SR に残すと、<b>どの基準で瘤と呼んだのかが読む側に分からない</b>。
 * 参照径の何倍を瘤と呼んだか（{@link QvaSrRequest.Dilation#criterion()}）と、参照径をどう
 * 決めたかを本文に書く。
 *
 * <p>🔴 <b>基準はここで決めない。</b> 利用者が設定（{@code xa.aneurysmRatio}）で変えられるので、
 * <b>画面が判定に使った値をそのまま受け取って書く</b>。ここに定数を持つと、画面と保存物が
 * 別々の基準を主張する（しかも SR を読む側にはそれが分からない）。
 */
final class QvaSrWriter {

    private static final Code DOC_TITLE = new Code("18748-4", "LN", null, "Diagnostic Imaging Report");
    private static final Code QVA_CONTAINER =
            new Code("QVA", "99GRAPHYNEXT", null, "Quantitative Vascular Analysis");
    private static final Code MLD = new Code("MLD", "99GRAPHYNEXT", null, "Minimum Lumen Diameter");
    private static final Code RVD = new Code("RVD", "99GRAPHYNEXT", null, "Reference Vessel Diameter");
    private static final Code PCT_DS = new Code("PCTDS", "99GRAPHYNEXT", null, "Percent Diameter Stenosis");
    private static final Code LESION_LENGTH = new Code("LESLEN", "99GRAPHYNEXT", null, "Lesion Length");
    private static final Code MAX_DIAMETER = new Code("MAXD", "99GRAPHYNEXT", null, "Maximum Lumen Diameter");
    private static final Code DILATION_RATIO =
            new Code("DILRATIO", "99GRAPHYNEXT", null, "Dilatation Ratio (max / reference)");
    private static final Code PCT_DILATION = new Code("PCTDIL", "99GRAPHYNEXT", null, "Percent Dilatation");
    private static final Code DILATION_LENGTH = new Code("DILLEN", "99GRAPHYNEXT", null, "Dilatation Length");
    private static final Code NECK_PROX = new Code("NECKPROX", "99GRAPHYNEXT", null, "Proximal Neck Diameter");
    private static final Code NECK_DIST = new Code("NECKDIST", "99GRAPHYNEXT", null, "Distal Neck Diameter");
    private static final Code ECCENTRICITY = new Code("ECC", "99GRAPHYNEXT", null, "Dilatation Eccentricity");
    private static final Code ASSESSMENT = new Code("ASSESS", "99GRAPHYNEXT", null, "Assessment");
    private static final Code CALIBRATION = new Code("CALIB", "99GRAPHYNEXT", null, "Spatial Calibration");
    private static final Code VESSEL = new Code("VESSEL", "99GRAPHYNEXT", null, "Vessel Segment");
    private static final Code METHOD = new Code("METHOD", "99GRAPHYNEXT", null, "Analysis Method");
    private static final Code MANUAL = new Code("MANUAL", "99GRAPHYNEXT", null, "Manual Correction");
    /** {@link QcaSrWriter} と同じコード（2D QCA と別の意味に読まれないよう揃える）。 */
    private static final Code DIAMETER_METHOD =
            new Code("DIAMMETHOD", "99GRAPHYNEXT", null, "Diameter Measurement Method");
    private static final Code OF_INTEREST = new Code("113000", "DCM", null, "Of Interest");

    private QvaSrWriter() {
    }

    record Result(Attributes dataset, String seriesInstanceUid, String sopInstanceUid) {
    }

    static Result build(Attributes referenceTemplate, QvaSrRequest req) {
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
        ds.setInt(Tag.SeriesNumber, VR.IS, 9105);
        ds.setInt(Tag.InstanceNumber, VR.IS, 1);
        ds.setDate(Tag.ContentDate, VR.DA, now);
        ds.setDate(Tag.ContentTime, VR.TM, now);
        ds.setString(Tag.SeriesDescription, VR.LO, "QVA");
        ds.setString(Tag.CompletionFlag, VR.CS, "COMPLETE");
        ds.setString(Tag.VerificationFlag, VR.CS, "UNVERIFIED");

        ds.setString(Tag.ValueType, VR.CS, "CONTAINER");
        ds.setString(Tag.ContinuityOfContent, VR.CS, "SEPARATE");
        ds.newSequence(Tag.ConceptNameCodeSequence, 1).add(codeItem(DOC_TITLE));

        Sequence root = ds.newSequence(Tag.ContentSequence, 4);

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

        Attributes group = new Attributes();
        group.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
        group.setString(Tag.ValueType, VR.CS, "CONTAINER");
        group.setString(Tag.ContinuityOfContent, VR.CS, "SEPARATE");
        group.newSequence(Tag.ConceptNameCodeSequence, 1).add(codeItem(QVA_CONTAINER));
        Sequence items = group.newSequence(Tag.ContentSequence, 16);

        if (req.vesselLabel() != null && !req.vesselLabel().isBlank()) {
            items.add(text(VESSEL, req.vesselLabel()));
        }
        String unit = mm ? "mm" : "px";
        items.add(num(RVD, req.rvd(), unit, mm));
        items.add(num(MLD, req.mld(), unit, mm));
        items.add(num(PCT_DS, req.percentDiameterStenosis(), "%", true));
        items.add(num(LESION_LENGTH, req.lesionLength(), unit, mm));

        QvaSrRequest.Dilation d = req.dilation();
        if (d != null) {
            items.add(num(MAX_DIAMETER, d.maxDiameter(), unit, mm));
            // 比は無次元。UCUM の "1" を使う（"%" と混ぜない）。
            items.add(num(DILATION_RATIO, d.ratio(), "1", true));
            items.add(num(PCT_DILATION, d.percentDilation(), "%", true));
            items.add(num(DILATION_LENGTH, d.length(), unit, mm));
            items.add(num(NECK_PROX, d.proximalNeck(), unit, mm));
            items.add(num(NECK_DIST, d.distalNeck(), unit, mm));
            if (d.eccentricity() != null) {
                items.add(num(ECCENTRICITY, d.eccentricity(), "1", true));
            }
            // 🚨 「瘤」という語だけを残さない。基準と、比が系統誤差に強いことを一緒に書く。
            items.add(text(ASSESSMENT, String.format(Locale.ROOT,
                    "%s (criterion: max/reference >= %.2f; measured %.2f). "
                            + "The reference diameter is interpolated from the healthy ends of the analysed segment.",
                    d.aneurysmal() ? "Aneurysm" : "Dilated but below the aneurysm criterion",
                    d.criterion(), d.ratio())));
        } else {
            items.add(text(ASSESSMENT, "No dilatation above the reference diameter."));
        }

        if (req.calibration() != null && !req.calibration().isBlank()) {
            items.add(text(CALIBRATION, req.calibration()));
        }
        items.add(text(MANUAL,
                req.manualCorrection() != null && !req.manualCorrection().isBlank()
                        ? req.manualCorrection()
                        : "None (fully automatic)"));
        // 🚨 **測り方を必ず残す**（§16.5）。半値法と密度計測では絶対値が 10% 以上違う。
        boolean densitometric = "densitometric".equalsIgnoreCase(req.diameterMethod());
        items.add(text(DIAMETER_METHOD, densitometric
                ? "Densitometric (attenuation integrated to a cross-sectional area; no shape assumed for the "
                        + "dilated segment, but the healthy segment is assumed circular when the reference "
                        + "attenuation coefficient is derived from it). The drawn outline comes from the "
                        + "half-maximum method and is a different measurement."
                : "Half-maximum (edge-based)."));
        items.add(text(METHOD,
                "GRAPHY-Next QVA (research use only). Single projection: the maximum diameter is the largest "
                        + "diameter in the projected direction, not necessarily the largest diameter of the "
                        + "aneurysm. "
                        + (densitometric
                                ? "Diameters are densitometric, so no edge-detection bias is applied to them; "
                                        + "scatter, overlapping vessels or heavy noise can make them read high "
                                        + "instead. "
                                : "Diameters come from the half-maximum method, which reads low for a rounded "
                                        + "lumen; the factor depends on the diameter and on the shape of the "
                                        + "cross-section, so it does NOT cancel in the dilatation ratio "
                                        + "(unlike percent stenosis, which compares the same cross-section). ")
                        + "Not a 3D-RA aneurysm detection."
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

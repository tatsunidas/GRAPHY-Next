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
 * 3D QCA の結果を Comprehensive SR として組み立てる（{@code fw/angio-design.md} §10 / A6a）。純関数。
 *
 * <h3>コードの方針</h3>
 * {@link QcaSrWriter} / {@link QlvSrWriter} と同じ <b>private scheme（99GRAPHYNEXT）</b>。
 * 確認できていない標準コードを当てずっぽうで書くと、他システムが別の意味に解釈する。
 *
 * <h3>🚨 「どう作った結果か」を必ず残す</h3>
 * 3D の値は<b>2 方向の選び方と、角度補正の有無で変わる</b>。数値だけを残した SR は再現できず、
 * しかも<b>もっともらしい mm として読まれる</b>。したがって次を必ず書く:
 * <ul>
 *   <li><b>2 方向の元インスタンスとフレーム</b>（片方だけでは足りない）</li>
 *   <li><b>視線の角度差</b>（小さいと三角測量が退化する）</li>
 *   <li><b>アンカー数と、角度補正を掛けたか</b>。アンカー 3 未満では補正が退化して掛からず、
 *       装置の角度誤差がそのまま形の歪みになる（§10.2.2）</li>
 *   <li><b>アンカーの再投影誤差</b>。対応付けの再投影誤差は幾何の指標にならない（§10.2.2）ので書かない</li>
 *   <li><b>各方向の短縮の度合い</b>。潰れた方向では長さが系統的に短く出る（§10.3.1）</li>
 * </ul>
 *
 * <h3>🔴 系統誤差を注記に必ず書く</h3>
 * <b>径の測り方（{@code diameterMethod}）で注記が変わる</b>。半値法なら過小に出るが、
 * その係数は断面の形で 0.745〜0.918 まで動く（円柱に固有の 0.870 を定数として書かない。§16.4/§16.5）。
 * 密度計測（A4c）なら係数は乗らないが、<b>基準の減弱係数を健常部から取るので健常部は円と仮定</b>し、
 * <b>画面の輪郭（半値法）と数値が別方式</b>になる（§16.5.2）。
 * 断面積は<b>楕円の主軸が 2 方向の測定方向に一致するという仮定</b>の下でしか出ない（§10.2.6）。
 * また、患者座標系での<b>姿勢は復元できない</b>（先頭視点を固定するため。§10.3）。
 */
final class Qca3dSrWriter {

    private static final Code DOC_TITLE = new Code("18748-4", "LN", null, "Diagnostic Imaging Report");
    private static final Code QCA3D_CONTAINER =
            new Code("QCA3D", "99GRAPHYNEXT", null, "Three-dimensional Quantitative Coronary Analysis");
    private static final Code LENGTH = new Code("LEN3D", "99GRAPHYNEXT", null, "3D Centerline Length");
    private static final Code MIN_AREA = new Code("MINAREA", "99GRAPHYNEXT", null, "Minimum Cross-sectional Area");
    private static final Code MIN_EQ_DIAM =
            new Code("MINEQD", "99GRAPHYNEXT", null, "Minimum Equivalent Diameter");
    private static final Code PCT_DS = new Code("PCTDS", "99GRAPHYNEXT", null, "Percent Diameter Stenosis (3D)");
    private static final Code PCT_AS = new Code("PCTAS", "99GRAPHYNEXT", null, "Percent Area Stenosis (3D)");
    private static final Code MLD = new Code("MLD", "99GRAPHYNEXT", null, "Minimum Lumen Diameter (3D)");
    private static final Code RVD = new Code("RVD", "99GRAPHYNEXT", null, "Reference Vessel Diameter (3D)");
    private static final Code LESION_LEN = new Code("LESIONLEN", "99GRAPHYNEXT", null, "Lesion Length (3D)");
    private static final Code SEPARATION = new Code("VIEWSEP", "99GRAPHYNEXT", null, "Angle Between View Directions");
    private static final Code ANCHORS = new Code("ANCHORS", "99GRAPHYNEXT", null, "Anchor Point Count");
    private static final Code ANCHOR_ERR =
            new Code("ANCHORERR", "99GRAPHYNEXT", null, "Anchor Reprojection Error");
    private static final Code FORESHORTEN_A = new Code("FORESHRTA", "99GRAPHYNEXT", null, "Visible Length Fraction (view A)");
    private static final Code FORESHORTEN_B = new Code("FORESHRTB", "99GRAPHYNEXT", null, "Visible Length Fraction (view B)");
    /** {@link QcaSrWriter} と同じコード（2D と 3D で別の意味に読まれないよう揃える）。 */
    private static final Code DIAMETER_METHOD =
            new Code("DIAMMETHOD", "99GRAPHYNEXT", null, "Diameter Measurement Method");
    private static final Code ANGLE_CORRECTION =
            new Code("ANGCORR", "99GRAPHYNEXT", null, "Positioner Angle Correction");
    private static final Code CALIBRATION = new Code("CALIB", "99GRAPHYNEXT", null, "Spatial Calibration");
    private static final Code METHOD = new Code("METHOD", "99GRAPHYNEXT", null, "Analysis Method");
    private static final Code OF_INTEREST = new Code("113000", "DCM", null, "Of Interest");

    private Qca3dSrWriter() {
    }

    record Result(Attributes dataset, String seriesInstanceUid, String sopInstanceUid) {
    }

    static Result build(Attributes referenceTemplate, Qca3dSrRequest req) {
        String seriesUid = UIDUtils.createUID();
        String sopUid = UIDUtils.createUID();
        Date now = new Date();
        boolean calibrated = req.calibration() != null && !req.calibration().isBlank()
                && req.minAreaMm2() != null;

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
        ds.setInt(Tag.SeriesNumber, VR.IS, 9102);
        ds.setInt(Tag.InstanceNumber, VR.IS, 1);
        ds.setDate(Tag.ContentDate, VR.DA, now);
        ds.setDate(Tag.ContentTime, VR.TM, now);
        ds.setString(Tag.SeriesDescription, VR.LO, "QCA 3D");
        ds.setString(Tag.CompletionFlag, VR.CS, "COMPLETE");
        ds.setString(Tag.VerificationFlag, VR.CS, "UNVERIFIED");

        ds.setString(Tag.ValueType, VR.CS, "CONTAINER");
        ds.setString(Tag.ContinuityOfContent, VR.CS, "SEPARATE");
        ds.newSequence(Tag.ConceptNameCodeSequence, 1).add(codeItem(DOC_TITLE));

        Sequence root = ds.newSequence(Tag.ContentSequence, 4);
        // 🚨 2 方向の**両方**を参照する。片方だけでは 3D の値を再現できない。
        root.add(imageRef(referenceTemplate, req.viewASopInstanceUid(), req.viewAFrameNumber()));
        if (req.viewBSopInstanceUid() != null
                && !req.viewBSopInstanceUid().equals(req.viewASopInstanceUid())) {
            root.add(imageRef(referenceTemplate, req.viewBSopInstanceUid(), req.viewBFrameNumber()));
        } else if (req.viewBFrameNumber() != null
                && !req.viewBFrameNumber().equals(req.viewAFrameNumber())) {
            root.add(imageRef(referenceTemplate, req.viewASopInstanceUid(), req.viewBFrameNumber()));
        }

        Attributes group = new Attributes();
        group.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
        group.setString(Tag.ValueType, VR.CS, "CONTAINER");
        group.setString(Tag.ContinuityOfContent, VR.CS, "SEPARATE");
        group.newSequence(Tag.ConceptNameCodeSequence, 1).add(codeItem(QCA3D_CONTAINER));
        Sequence items = group.newSequence(Tag.ContentSequence, 12);

        // 長さは校正に依らない（幾何は SID/SOD と検出器ピッチで決まる）。
        items.add(num(LENGTH, req.lengthMm(), "mm"));
        // 断面は径から作るので、径が px のときは出せない。
        if (calibrated) {
            items.add(num(MIN_AREA, req.minAreaMm2(), "mm2"));
            if (req.minEquivalentDiameterMm() != null) {
                items.add(num(MIN_EQ_DIAM, req.minEquivalentDiameterMm(), "mm"));
            }
            // 狭窄率は比なので半値法の系統誤差がほぼ打ち消される。MLD/RVD の絶対値には残る。
            if (req.percentDiameterStenosis() != null) {
                items.add(num(PCT_DS, req.percentDiameterStenosis(), "%"));
            }
            if (req.percentAreaStenosis() != null) {
                items.add(num(PCT_AS, req.percentAreaStenosis(), "%"));
            }
            if (req.mldMm() != null) {
                items.add(num(MLD, req.mldMm(), "mm"));
            }
            if (req.rvdMm() != null) {
                items.add(num(RVD, req.rvdMm(), "mm"));
            }
            if (req.lesionLengthMm() != null) {
                items.add(num(LESION_LEN, req.lesionLengthMm(), "mm"));
            }
        }
        items.add(num(SEPARATION, req.separationDeg(), "deg"));
        items.add(num(ANCHORS, req.anchorCount(), "{count}"));
        items.add(num(ANCHOR_ERR, req.anchorReprojectionPx(), "{pixel}"));
        if (req.visibleFractionA() != null) {
            items.add(num(FORESHORTEN_A, req.visibleFractionA() * 100.0, "%"));
        }
        if (req.visibleFractionB() != null) {
            items.add(num(FORESHORTEN_B, req.visibleFractionB() * 100.0, "%"));
        }
        // 🚨 補正の有無は**必ず**書く。掛けていない結果は装置の角度誤差をそのまま含む。
        //    「項目が無い＝補正した」と読まれないよう、掛けていない場合も明示する。
        items.add(text(ANGLE_CORRECTION, req.angleCorrected()
                ? "applied (bundle adjustment from anchor points)"
                : "NOT APPLIED (fewer than 3 anchor points; positioner angle error remains as shape distortion)"));
        if (req.calibration() != null && !req.calibration().isBlank()) {
            items.add(text(CALIBRATION, req.calibration()));
        }
        // 🚨 **測り方を必ず残す**（§16.5）。半値法と密度計測では絶対値が 10% 以上違う。
        items.add(text(DIAMETER_METHOD, diameterMethodNote(req.diameterMethod())));
        items.add(text(METHOD, methodNote(calibrated, req.diameterMethod())));
        root.add(group);

        return new Result(ds, seriesUid, sopUid);
    }

    /** 径の測り方の説明。null は半値法（安全側）として扱う。 */
    private static String diameterMethodNote(String method) {
        if ("densitometric".equalsIgnoreCase(method)) {
            return "Densitometric (attenuation integrated to a cross-sectional area; no shape assumed for the "
                    + "lesion, but the healthy segment is assumed circular when the reference attenuation "
                    + "coefficient is derived from it). The drawn outline comes from the half-maximum method "
                    + "and is a different measurement.";
        }
        if ("mixed".equalsIgnoreCase(method)) {
            return "MIXED: the two views were measured with different methods (half-maximum and densitometric). "
                    + "The fused cross-section is not in either sense; do not compare these absolute values.";
        }
        return "Half-maximum (edge-based).";
    }

    private static String methodNote(boolean calibrated, String diameterMethod) {
        StringBuilder sb = new StringBuilder();
        sb.append("Two-view 3D reconstruction (epipolar-constrained monotone correspondence, ")
                .append("least-squares triangulation) — GRAPHY-Next 3D QCA (research use only). ");
        // 姿勢は復元できない。長さ・狭窄率は正しいが向きは信用できない。
        sb.append("Shape is recovered but the pose in patient coordinates is NOT: view A is held fixed ")
                .append("as the gauge, so its positioner angle error remains as a pose error of the model. ");
        // 短縮は長さを系統的に短くする。
        sb.append("Segments compressed along a view direction lose arc length during 2D centerline ")
                .append("extraction, which shortens the reported length. ");
        // 非同時収集。
        sb.append("If the two views were acquired in different heartbeats, cardiac phase matching is approximate. ");
        if (calibrated) {
            // 🔴 系統誤差。数値と同じ場所に書く。**測り方で内容が変わる**（§16.5）。
            sb.append("Cross-sectional area assumes the ellipse axes coincide with the two measurement ")
                    .append("directions; it is exact for a circular section and for orthogonal views. ");
            if ("densitometric".equalsIgnoreCase(diameterMethod)) {
                sb.append("Diameters are densitometric, so no edge-detection bias is applied to them; ")
                        .append("scatter, overlapping vessels or heavy noise can make them read high instead. ")
                        .append("Percent stenosis is a ratio and is largely unaffected either way.");
            } else if ("mixed".equalsIgnoreCase(diameterMethod)) {
                sb.append("The two views were measured with DIFFERENT diameter methods, so the absolute ")
                        .append("cross-section is not in either sense. Use the percent stenosis, not the ")
                        .append("absolute values.");
            } else {
                sb.append("Diameters come from the half-maximum method, which reads low for a rounded lumen ")
                        .append("(about 13% for a circular cross-section, and about 24% for areas, as the ")
                        .append("square); the factor depends on the shape of the cross-section, so it is not ")
                        .append("a constant. Percent stenosis is a ratio and largely cancels this bias; ")
                        .append("absolute MLD and RVD do not.");
            }
        } else {
            sb.append("NOT SPATIALLY CALIBRATED: cross-sectional areas are not reported.");
        }
        return sb.toString();
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

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * QCA 結果の SR 書き出し（{@code fw/angio-design.md} §14.2 / A10）。
 *
 * <p>方針の要は「**確認できていない標準コードを当てずっぽうで書かない**」こと。
 * private scheme なら他システムは「知らないコード」として扱うが、間違った標準コードを書くと
 * **別の意味として解釈される**。
 */
class QcaSrWriterTest {

    private static Attributes template() {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, "1.2.840.10008.5.1.4.1.1.12.1");
        ds.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        ds.setString(Tag.PatientID, VR.LO, "P001");
        return ds;
    }

    private static QcaSrRequest req(String unit) {
        return req(unit, null);
    }

    private static QcaSrRequest req(String unit, String manualCorrection) {
        return req(unit, manualCorrection, null);
    }

    private static QcaSrRequest req(String unit, String manualCorrection, String diameterMethod) {
        return new QcaSrRequest("1.2.3", "1.2.3.9", "1.2.3.10", 12, unit,
                "カテーテル 6Fr / 0.208 mm/px", "LAD proximal", manualCorrection, diameterMethod,
                1.47, 3.00, 51.0, 76.0, 6.2);
    }

    private static Attributes measurementGroup(Attributes ds) {
        for (Attributes item : ds.getSequence(Tag.ContentSequence)) {
            if ("CONTAINER".equals(item.getString(Tag.ValueType))) {
                return item;
            }
        }
        return null;
    }

    private static Attributes findByCode(Attributes group, String codeValue) {
        for (Attributes item : group.getSequence(Tag.ContentSequence)) {
            Attributes concept = item.getNestedDataset(Tag.ConceptNameCodeSequence);
            if (concept != null && codeValue.equals(concept.getString(Tag.CodeValue))) {
                return item;
            }
        }
        return null;
    }

    private static double numOf(Attributes item) {
        return item.getNestedDataset(Tag.MeasuredValueSequence).getDouble(Tag.NumericValue, Double.NaN);
    }

    private static Attributes unitOf(Attributes item) {
        return item.getNestedDataset(Tag.MeasuredValueSequence)
                .getNestedDataset(Tag.MeasurementUnitsCodeSequence);
    }

    @Test
    void writesComprehensiveSr() {
        var r = QcaSrWriter.build(template(), req("mm"));
        assertEquals(UID.ComprehensiveSRStorage, r.dataset().getString(Tag.SOPClassUID));
        assertEquals("SR", r.dataset().getString(Tag.Modality));
        assertEquals("P001", r.dataset().getString(Tag.PatientID));
        assertEquals("COMPLETE", r.dataset().getString(Tag.CompletionFlag));
    }

    @Test
    void referencesTheAnalyzedFrame() {
        // どのフレームを測ったかが残らないと再現できない。
        var r = QcaSrWriter.build(template(), req("mm"));
        Attributes img = null;
        for (Attributes item : r.dataset().getSequence(Tag.ContentSequence)) {
            if ("IMAGE".equals(item.getString(Tag.ValueType))) {
                img = item;
            }
        }
        assertNotNull(img);
        Attributes ref = img.getNestedDataset(Tag.ReferencedSOPSequence);
        assertEquals("1.2.3.10", ref.getString(Tag.ReferencedSOPInstanceUID));
        assertEquals(12, ref.getInt(Tag.ReferencedFrameNumber, -1));
    }

    @Test
    void writesAllMeasurementsWithUcumUnits() {
        var r = QcaSrWriter.build(template(), req("mm"));
        Attributes g = measurementGroup(r.dataset());
        assertNotNull(g);
        assertEquals(1.47, numOf(findByCode(g, "MLD")), 1e-9);
        assertEquals(3.0, numOf(findByCode(g, "RVD")), 1e-9);
        assertEquals(51.0, numOf(findByCode(g, "PCTDS")), 1e-9);
        assertEquals(76.0, numOf(findByCode(g, "PCTAS")), 1e-9);
        assertEquals(6.2, numOf(findByCode(g, "LESLEN")), 1e-9);
        assertEquals("mm", unitOf(findByCode(g, "MLD")).getString(Tag.CodeValue));
        assertEquals("UCUM", unitOf(findByCode(g, "MLD")).getString(Tag.CodingSchemeDesignator));
        assertEquals("%", unitOf(findByCode(g, "PCTDS")).getString(Tag.CodeValue));
    }

    @Test
    void usesPrivateSchemeForUnverifiedConcepts() {
        // 標準コードが確認できていない概念は private scheme で書く（別の意味に解釈されないように）。
        var r = QcaSrWriter.build(template(), req("mm"));
        Attributes g = measurementGroup(r.dataset());
        Attributes concept = findByCode(g, "MLD").getNestedDataset(Tag.ConceptNameCodeSequence);
        assertEquals("99GRAPHYNEXT", concept.getString(Tag.CodingSchemeDesignator));
        assertEquals("Minimum Lumen Diameter", concept.getString(Tag.CodeMeaning));
    }

    @Test
    void uncalibratedAnalysisDoesNotClaimMillimetres() {
        // ★ 未校正（px）の結果を UCUM の mm として書くと、他システムは mm として読む。
        var r = QcaSrWriter.build(template(), req("px"));
        Attributes g = measurementGroup(r.dataset());
        Attributes unit = unitOf(findByCode(g, "MLD"));
        assertEquals("px", unit.getString(Tag.CodeValue));
        assertEquals("99GRAPHYNEXT", unit.getString(Tag.CodingSchemeDesignator));
        // 方法の注記にも未校正であることを残す。
        String method = findByCode(g, "METHOD").getString(Tag.TextValue);
        assertTrue(method.contains("NOT SPATIALLY CALIBRATED"));
    }

    @Test
    void keepsCalibrationProvenanceAndCaveats() {
        var r = QcaSrWriter.build(template(), req("mm"));
        Attributes g = measurementGroup(r.dataset());
        // 数値だけ残して出自を落とさない。
        assertEquals("カテーテル 6Fr / 0.208 mm/px", findByCode(g, "CALIB").getString(Tag.TextValue));
        assertEquals("LAD proximal", findByCode(g, "VESSEL").getString(Tag.TextValue));
        String method = findByCode(g, "METHOD").getString(Tag.TextValue);
        assertTrue(method.contains("research use only"));
        assertTrue(method.contains("circular cross-section"));
    }

    /**
     * 手修正の有無は<b>常に</b>書く（設計 §8.6）。
     *
     * <p>「手修正の項目が無い」を「全自動だった」と読むことはできない — 項目を書かない実装と
     * 区別が付かないため。全自動なら明示的に "None" と書く。
     */
    @Test
    void alwaysRecordsWhetherTheResultWasHandEdited() {
        Attributes autoRun = measurementGroup(QcaSrWriter.build(template(), req("mm")).dataset());
        assertEquals("None (fully automatic)", findByCode(autoRun, "MANUAL").getString(Tag.TextValue));

        Attributes edited = measurementGroup(
                QcaSrWriter.build(template(), req("mm", "waypoints=2; edges=5; reference=segments")).dataset());
        assertEquals("waypoints=2; edges=5; reference=segments",
                findByCode(edited, "MANUAL").getString(Tag.TextValue));
    }

    @Test
    void worksWithoutTemplate() {
        // 参照インスタンスのヘッダが読めなくても落ちない（保存自体は成立させる）。
        var r = QcaSrWriter.build(null, req("mm"));
        assertNotNull(r.dataset().getString(Tag.SOPInstanceUID));
        Sequence content = r.dataset().getSequence(Tag.ContentSequence);
        assertNotNull(content);
    }

    @Test
    void 径の測り方を必ず残す() throws Exception {
        // 🚨 半値法と密度計測では絶対値が 10% 以上違う。書かないと、あとから他社の
        //    QCA と比べたときに差の原因が分からなくなる（設計 §16.5）。
        Attributes halfMaxRun = measurementGroup(QcaSrWriter.build(template(), req("mm")).dataset());
        String halfMax = findByCode(halfMaxRun, "DIAMMETHOD").getString(Tag.TextValue);
        assertTrue(halfMax.contains("Half-maximum"), halfMax);

        Attributes densRun = measurementGroup(
                QcaSrWriter.build(template(), req("mm", null, "densitometric")).dataset());
        String dens = findByCode(densRun, "DIAMMETHOD").getString(Tag.TextValue);
        assertTrue(dens.contains("Densitometric"), dens);
        // 輪郭が別方式であることまで書く（画面と数値の食い違いを説明できるように）。
        assertTrue(dens.contains("half-maximum"), dens);
    }
}

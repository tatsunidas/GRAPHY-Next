/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * QVA 結果の SR 書き出し（{@code fw/angio-design.md} §9.1 / A5a）。
 *
 * <p>ここで守りたいのは 2 つ。
 * <ol>
 *   <li><b>拡張が無いときに 0 で埋めない</b>。「瘤 0mm」は「瘤が無い」とは違う主張になる。</li>
 *   <li><b>「動脈瘤」という語だけを残さない</b>。どの基準で瘤と呼んだのかが読む側に分からない。</li>
 * </ol>
 */
class QvaSrWriterTest {

    private static Attributes template() {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, "1.2.840.10008.5.1.4.1.1.12.1");
        ds.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        ds.setString(Tag.PatientID, VR.LO, "P001");
        return ds;
    }

    private static QvaSrRequest req(String unit, QvaSrRequest.Dilation dilation) {
        return req(unit, dilation, "densitometric");
    }

    private static QvaSrRequest req(String unit, QvaSrRequest.Dilation dilation, String diameterMethod) {
        return new QvaSrRequest("1.2.3", "1.2.3.9", "1.2.3.10", 4, unit,
                "DICOM PixelSpacing（GEOMETRY） (0.2250 mm/px)", "右浅大腿動脈", null,
                diameterMethod,
                2.10, 3.00, 30.0, 8.4, dilation);
    }

    private static QvaSrRequest.Dilation dilation(double ratio, boolean aneurysmal, Double eccentricity) {
        return new QvaSrRequest.Dilation(3.0 * ratio, ratio, (ratio - 1) * 100, 18.0, 3.0, 3.0,
                eccentricity, aneurysmal);
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
    void writesComprehensiveSrSeparateFromQca() {
        var r = QvaSrWriter.build(template(), req("mm", dilation(2.0, true, 0.1)));
        assertEquals(UID.ComprehensiveSRStorage, r.dataset().getString(Tag.SOPClassUID));
        assertEquals("QVA", r.dataset().getString(Tag.SeriesDescription));
        // QCA（9100）と混ざらない系列番号。
        assertEquals(9105, r.dataset().getInt(Tag.SeriesNumber, -1));
    }

    @Test
    void writesStenosisAndDilationMeasurements() {
        var r = QvaSrWriter.build(template(), req("mm", dilation(2.0, true, 0.08)));
        Attributes g = measurementGroup(r.dataset());
        assertEquals(3.0, numOf(findByCode(g, "RVD")), 1e-9);
        assertEquals(2.10, numOf(findByCode(g, "MLD")), 1e-9);
        assertEquals(30.0, numOf(findByCode(g, "PCTDS")), 1e-9);
        assertEquals(6.0, numOf(findByCode(g, "MAXD")), 1e-9);
        assertEquals(2.0, numOf(findByCode(g, "DILRATIO")), 1e-9);
        assertEquals(100.0, numOf(findByCode(g, "PCTDIL")), 1e-9);
        assertEquals(18.0, numOf(findByCode(g, "DILLEN")), 1e-9);
        // 比と偏心度は無次元。"%" と混ぜない。
        assertEquals("1", unitOf(findByCode(g, "DILRATIO")).getString(Tag.CodeValue));
        assertEquals("1", unitOf(findByCode(g, "ECC")).getString(Tag.CodeValue));
        assertEquals("mm", unitOf(findByCode(g, "MAXD")).getString(Tag.CodeValue));
    }

    @Test
    void aneurysmIsAlwaysWrittenWithItsCriterion() {
        var r = QvaSrWriter.build(template(), req("mm", dilation(2.0, true, null)));
        String assessment = findByCode(measurementGroup(r.dataset()), "ASSESS").getString(Tag.TextValue);
        assertTrue(assessment.contains("Aneurysm"), assessment);
        // ★ 基準（1.5 倍）と実測値の両方が入っていること。
        assertTrue(assessment.contains("1.5"), assessment);
        assertTrue(assessment.contains("2.00"), assessment);
        // 参照径の決め方も残す（両端から内挿している、という前提が読めないと数値が使えない）。
        assertTrue(assessment.contains("healthy ends"), assessment);
    }

    @Test
    void dilatedButBelowCriterionIsNotCalledAnAneurysm() {
        var r = QvaSrWriter.build(template(), req("mm", dilation(1.2, false, null)));
        String assessment = findByCode(measurementGroup(r.dataset()), "ASSESS").getString(Tag.TextValue);
        assertTrue(assessment.contains("below the aneurysm criterion"), assessment);
        assertTrue(!assessment.startsWith("Aneurysm"), assessment);
    }

    @Test
    void noDilationWritesNothingRatherThanZeros() {
        // 🚨 「瘤 0mm」を書かない。無いものは項目ごと書かない。
        var r = QvaSrWriter.build(template(), req("mm", null));
        Attributes g = measurementGroup(r.dataset());
        assertNull(findByCode(g, "MAXD"));
        assertNull(findByCode(g, "DILRATIO"));
        assertNull(findByCode(g, "DILLEN"));
        assertNotNull(findByCode(g, "MLD"));
        assertTrue(findByCode(g, "ASSESS").getString(Tag.TextValue).contains("No dilatation"));
    }

    @Test
    void eccentricityIsOmittedWhenItCannotBeMeasured() {
        var r = QvaSrWriter.build(template(), req("mm", dilation(2.0, true, null)));
        assertNull(findByCode(measurementGroup(r.dataset()), "ECC"));
    }

    @Test
    void uncalibratedAnalysisDoesNotClaimMillimetres() {
        var r = QvaSrWriter.build(template(), req("px", dilation(2.0, true, 0.9)));
        Attributes g = measurementGroup(r.dataset());
        Attributes unit = unitOf(findByCode(g, "MAXD"));
        assertEquals("px", unit.getString(Tag.CodeValue));
        assertEquals("99GRAPHYNEXT", unit.getString(Tag.CodingSchemeDesignator));
        assertTrue(findByCode(g, "METHOD").getString(Tag.TextValue).contains("NOT SPATIALLY CALIBRATED"));
        // 比は校正に依らないので UCUM のまま。
        assertEquals("UCUM", unitOf(findByCode(g, "DILRATIO")).getString(Tag.CodingSchemeDesignator));
    }

    @Test
    void methodRecordsTheProjectionAndBiasLimits() {
        var r = QvaSrWriter.build(template(), req("mm", dilation(2.0, true, 0.9), "half-max"));
        String method = findByCode(measurementGroup(r.dataset()), "METHOD").getString(Tag.TextValue);
        assertTrue(method.contains("Single projection"), method);
        // 🔴 拡張比は太さの違う 2 点の比なので、**%DS と違って係数が打ち消されない**（§16.4）。
        //    かつて "ratios are unaffected" と書いていたのは誤り。
        assertTrue(method.contains("does NOT cancel in the dilatation ratio"), method);
        assertFalse(method.contains("ratios are unaffected"), method);
        // 3D-RA のプラグインと取り違えられないようにする。
        assertTrue(method.contains("Not a 3D-RA aneurysm detection"), method);
        assertTrue(findByCode(measurementGroup(r.dataset()), "DIAMMETHOD")
                .getString(Tag.TextValue).contains("Half-maximum"));
    }

    @Test
    void 密度計測なら半値法の系統誤差を書かない() {
        // 🚨 A4c 以降、報告する径は密度計測（設計 §16.5.1）。
        var r = QvaSrWriter.build(template(), req("mm", dilation(2.0, true, 0.9)));
        Attributes g = measurementGroup(r.dataset());
        String method = findByCode(g, "METHOD").getString(Tag.TextValue);
        assertFalse(method.contains("half-maximum method, which reads low"), method);
        assertTrue(method.contains("densitometric"), method);
        assertTrue(method.contains("read high"), method);
        String how = findByCode(g, "DIAMMETHOD").getString(Tag.TextValue);
        assertTrue(how.contains("Densitometric"), how);
        assertTrue(how.contains("healthy segment is assumed circular"), how);
    }

    @Test
    void alwaysRecordsWhetherTheResultWasHandEdited() {
        var auto = QvaSrWriter.build(template(), req("mm", dilation(2.0, true, 0.1)));
        assertTrue(findByCode(measurementGroup(auto.dataset()), "MANUAL").getString(Tag.TextValue)
                .contains("None (fully automatic)"));
        var edited = QvaSrWriter.build(template(),
                new QvaSrRequest("1.2.3", "1.2.3.9", "1.2.3.10", 4, "mm", null, null,
                        "waypoints=2; reference=ends", "densitometric",
                        2.1, 3.0, 30.0, 8.4, dilation(2.0, true, 0.1)));
        assertEquals("waypoints=2; reference=ends",
                findByCode(measurementGroup(edited.dataset()), "MANUAL").getString(Tag.TextValue));
    }
}

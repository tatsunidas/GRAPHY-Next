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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 3D QCA 結果の SR 書き出し（{@code fw/angio-design.md} §10 / A6a）。
 *
 * <p>ここで守る一番大事な規則は <b>「どう作った結果かを必ず残す」</b>。
 * 3D の値は 2 方向の選び方と角度補正の有無で変わるのに、数値だけを見ると
 * <b>もっともらしい mm として読まれる</b>。したがって
 * 2 方向の参照・視線の角度差・アンカー数・補正の有無・短縮の度合いを必ず書く。
 */
class Qca3dSrWriterTest {

    private static Attributes template() {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, "1.2.840.10008.5.1.4.1.1.12.1");
        ds.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        ds.setString(Tag.PatientID, VR.LO, "P001");
        return ds;
    }

    private static Qca3dSrRequest calibrated() {
        return new Qca3dSrRequest("1.2.3", "1.2.3.9", "1.2.3.10", 1, "1.2.3.11", 1,
                90.0, 5, 0.01, true, 63.1, 5.018, 2.528, 0.783, 0.485,
                "DICOM PixelSpacing (GEOMETRY) 0.225 mm/px",
                49.2, 74.2, 1.42, 2.80, 4.1);
    }

    private static Qca3dSrRequest uncalibrated() {
        return new Qca3dSrRequest("1.2.3", "1.2.3.9", "1.2.3.10", 1, "1.2.3.11", 1,
                90.0, 5, 0.01, true, 63.1, null, null, 0.783, 0.485, null,
                null, null, null, null, null);
    }

    private static Qca3dSrRequest notCorrected() {
        return new Qca3dSrRequest("1.2.3", "1.2.3.9", "1.2.3.10", 1, "1.2.3.11", 1,
                90.0, 2, 1.61, false, 63.1, 5.018, 2.528, 0.783, 0.485,
                "DICOM PixelSpacing (GEOMETRY) 0.225 mm/px",
                49.2, 74.2, 1.42, 2.80, 4.1);
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

    private static double numericOf(Attributes item) {
        return item.getNestedDataset(Tag.MeasuredValueSequence).getDouble(Tag.NumericValue, Double.NaN);
    }

    @Test
    void writesComprehensiveSr() {
        Attributes ds = Qca3dSrWriter.build(template(), calibrated()).dataset();
        assertEquals(UID.ComprehensiveSRStorage, ds.getString(Tag.SOPClassUID));
        assertEquals("SR", ds.getString(Tag.Modality));
        assertEquals("QCA 3D", ds.getString(Tag.SeriesDescription));
        assertEquals("P001", ds.getString(Tag.PatientID));
    }

    @Test
    void referencesBothViews() {
        // 🚨 3D の値は「どの 2 方向から作ったか」で変わる。片方だけの SR は再現できない。
        Attributes ds = Qca3dSrWriter.build(template(), calibrated()).dataset();
        int images = 0;
        for (Attributes item : ds.getSequence(Tag.ContentSequence)) {
            if ("IMAGE".equals(item.getString(Tag.ValueType))) {
                images++;
            }
        }
        assertEquals(2, images, "2 方向の元インスタンスを両方参照すること");
    }

    @Test
    void writesGeometryProvenance() {
        Attributes g = measurementGroup(Qca3dSrWriter.build(template(), calibrated()).dataset());
        assertNotNull(g);
        assertEquals(90.0, numericOf(findByCode(g, "VIEWSEP")), 1e-6);
        assertEquals(5.0, numericOf(findByCode(g, "ANCHORS")), 1e-6);
        assertEquals(0.01, numericOf(findByCode(g, "ANCHORERR")), 1e-6);
        assertEquals(63.1, numericOf(findByCode(g, "LEN3D")), 1e-6);
    }

    @Test
    void writesForeshorteningForBothViews() {
        // 短縮は長さを系統的に短くする。どちらの方向がどれだけ潰れていたかを残す。
        Attributes g = measurementGroup(Qca3dSrWriter.build(template(), calibrated()).dataset());
        assertEquals(78.3, numericOf(findByCode(g, "FORESHRTA")), 1e-6);
        assertEquals(48.5, numericOf(findByCode(g, "FORESHRTB")), 1e-6);
    }

    @Test
    void writesAngleCorrectionEvenWhenNotApplied() {
        // 🚨 「項目が無い＝補正した」と読ませない。掛けていないことも明示する。
        Attributes applied = measurementGroup(Qca3dSrWriter.build(template(), calibrated()).dataset());
        assertTrue(findByCode(applied, "ANGCORR").getString(Tag.TextValue).startsWith("applied"));

        Attributes not = measurementGroup(Qca3dSrWriter.build(template(), notCorrected()).dataset());
        String text = findByCode(not, "ANGCORR").getString(Tag.TextValue);
        assertTrue(text.contains("NOT APPLIED"), text);
        assertTrue(text.contains("shape distortion"), text);
    }

    @Test
    void omitsAreaWhenUncalibrated() {
        // 🚨 px の径から mm² は作れない。長さ（幾何だけで決まる）は書けるが、断面は書かない。
        Attributes g = measurementGroup(Qca3dSrWriter.build(template(), uncalibrated()).dataset());
        assertNotNull(findByCode(g, "LEN3D"), "長さは校正に依らないので書く");
        assertNull(findByCode(g, "MINAREA"), "未校正で断面積を書いてはいけない");
        assertNull(findByCode(g, "MINEQD"), "未校正で等価直径を書いてはいけない");
        assertNull(findByCode(g, "CALIB"));
        assertTrue(findByCode(g, "METHOD").getString(Tag.TextValue).contains("NOT SPATIALLY CALIBRATED"));
    }

    @Test
    void writesAreaWhenCalibrated() {
        Attributes g = measurementGroup(Qca3dSrWriter.build(template(), calibrated()).dataset());
        assertEquals(5.018, numericOf(findByCode(g, "MINAREA")), 1e-6);
        assertEquals(2.528, numericOf(findByCode(g, "MINEQD")), 1e-6);
        assertNotNull(findByCode(g, "CALIB"));
    }

    @Test
    void writesStenosisWhenCalibrated() {
        Attributes g = measurementGroup(Qca3dSrWriter.build(template(), calibrated()).dataset());
        assertEquals(49.2, numericOf(findByCode(g, "PCTDS")), 1e-6);
        assertEquals(74.2, numericOf(findByCode(g, "PCTAS")), 1e-6);
        assertEquals(1.42, numericOf(findByCode(g, "MLD")), 1e-6);
        assertEquals(2.80, numericOf(findByCode(g, "RVD")), 1e-6);
        assertEquals(4.1, numericOf(findByCode(g, "LESIONLEN")), 1e-6);
    }

    @Test
    void omitsStenosisWhenUncalibrated() {
        // 狭窄率は比なので単位に依らないように見えるが、断面が出せていない以上、
        // そもそも 3D の径が無い。あるように見せない。
        Attributes g = measurementGroup(Qca3dSrWriter.build(template(), uncalibrated()).dataset());
        assertNull(findByCode(g, "PCTDS"));
        assertNull(findByCode(g, "MLD"));
    }

    @Test
    void methodNoteStatesTheSystematicBiasAndPoseLimitation() {
        // 🔴 系統誤差と「姿勢は復元できない」ことを、数値と同じ場所に書く。
        // 別ページの注記では読まれない。
        String note = findByCode(measurementGroup(Qca3dSrWriter.build(template(), calibrated()).dataset()), "METHOD")
                .getString(Tag.TextValue);
        assertTrue(note.contains("13%"), note);
        assertTrue(note.contains("24%"), note);
        assertTrue(note.contains("pose in patient coordinates is NOT"), note);
        assertTrue(note.contains("cardiac phase matching is approximate"), note);
        assertTrue(note.contains("research use only"), note);
        // 比では打ち消され、絶対値には残る——という非対称を書いておく。
        assertTrue(note.contains("Percent stenosis is a ratio and largely cancels"), note);
    }

    @Test
    void usesPrivateCodingScheme() {
        // 確認できていない標準コードを当てずっぽうで書かない（他システムが別の意味に読む）。
        Attributes g = measurementGroup(Qca3dSrWriter.build(template(), calibrated()).dataset());
        for (Attributes item : g.getSequence(Tag.ContentSequence)) {
            Attributes concept = item.getNestedDataset(Tag.ConceptNameCodeSequence);
            assertEquals("99GRAPHYNEXT", concept.getString(Tag.CodingSchemeDesignator),
                    "概念コードはすべて private scheme であること");
        }
    }
}

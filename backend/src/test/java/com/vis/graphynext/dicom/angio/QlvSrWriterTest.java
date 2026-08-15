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
 * QLV 結果の SR 書き出し（{@code fw/angio-design.md} §9.2 / A5b）。
 *
 * <p>ここで守る一番大事な規則は
 * <b>「未校正なら EF は書くが、容積と Kennedy 補正は書かない」</b>。
 * EF は体積が長さの 3 乗に比例することからスケール不変で、校正が無くても正しい。
 * 一方 Kennedy 補正（V = 0.928·V − 3.8 mL）は定数項を持つアフィン変換なので不変ではなく、
 * 未校正データに当てると意味の無い値になる。
 */
class QlvSrWriterTest {

    private static Attributes template() {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, "1.2.840.10008.5.1.4.1.1.12.1");
        ds.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        ds.setString(Tag.PatientID, VR.LO, "P001");
        return ds;
    }

    private static QlvSrRequest calibrated() {
        return new QlvSrRequest("1.2.3", "1.2.3.9", "1.2.3.10", 31, 43, "mL",
                "カテーテル 6Fr / 0.208 mm/px", "manual", 60.1,
                122.5, 48.9, 109.9, 41.6, 62.1, "Area-Length (single plane)");
    }

    private static QlvSrRequest uncalibrated() {
        return new QlvSrRequest("1.2.3", "1.2.3.9", "1.2.3.10", 31, 43, null,
                null, "automatic (area curve)", 60.1,
                null, null, null, null, null, "Area-Length (single plane)");
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
        Attributes ds = QlvSrWriter.build(template(), calibrated()).dataset();
        assertEquals(UID.ComprehensiveSRStorage, ds.getString(Tag.SOPClassUID));
        assertEquals("SR", ds.getString(Tag.Modality));
        assertEquals("QLV", ds.getString(Tag.SeriesDescription));
        // 患者・スタディの識別情報を参照元から引き継ぐ。
        assertEquals("P001", ds.getString(Tag.PatientID));
    }

    @Test
    void referencesBothEdAndEsFrames() {
        // どちらのフレームで測ったかが残らないと再現できない。
        Attributes ds = QlvSrWriter.build(template(), calibrated()).dataset();
        int frames = 0;
        for (Attributes item : ds.getSequence(Tag.ContentSequence)) {
            if (!"IMAGE".equals(item.getString(Tag.ValueType))) {
                continue;
            }
            Attributes ref = item.getNestedDataset(Tag.ReferencedSOPSequence);
            assertNotNull(ref);
            frames++;
        }
        assertEquals(2, frames, "ED と ES の 2 フレームを参照すること");
    }

    @Test
    void writesEfAndVolumesWhenCalibrated() {
        Attributes group = measurementGroup(QlvSrWriter.build(template(), calibrated()).dataset());
        assertNotNull(group);
        assertEquals(60.1, numericOf(findByCode(group, "EF")), 1e-6);
        assertEquals(122.5, numericOf(findByCode(group, "EDV")), 1e-6);
        assertEquals(48.9, numericOf(findByCode(group, "ESV")), 1e-6);
        assertEquals(62.1, numericOf(findByCode(group, "EFCORR")), 1e-6);
    }

    @Test
    void writesEfButNoVolumesWhenUncalibrated() {
        // ★これがこのクラスの主眼。EF はスケール不変なので書けるが、
        //   容積の絶対値と Kennedy 補正は書けない。
        Attributes group = measurementGroup(QlvSrWriter.build(template(), uncalibrated()).dataset());
        assertNotNull(group);
        assertEquals(60.1, numericOf(findByCode(group, "EF")), 1e-6, "未校正でも EF は書く");
        assertNull(findByCode(group, "EDV"), "未校正で容積を書いてはいけない");
        assertNull(findByCode(group, "ESV"), "未校正で容積を書いてはいけない");
        assertNull(findByCode(group, "EFCORR"), "Kennedy 補正はアフィンなので未校正では書けない");
        assertNull(findByCode(group, "EDVCORR"));
    }

    @Test
    void statesUncalibratedInMethodText() {
        // 読む側が「なぜ容積が無いのか」を判断できるように、本文にも書く。
        Attributes group = measurementGroup(QlvSrWriter.build(template(), uncalibrated()).dataset());
        String method = findByCode(group, "METHOD").getString(Tag.TextValue);
        assertTrue(method.contains("NOT SPATIALLY CALIBRATED"), method);
        assertTrue(method.contains("scale invariant"), "EF が有効な理由も残すこと: " + method);
    }

    @Test
    void alwaysRecordsHowFramesWereChosen() {
        // 自動提案のままか人が選んだかは**結果の意味を変える**（PVC 直後の心拍は EF を過大評価する）。
        // 項目が無いことを「人が選んだ」と読ませないため、全自動でも必ず書く。
        Attributes auto = measurementGroup(QlvSrWriter.build(template(), uncalibrated()).dataset());
        assertEquals("automatic (area curve)", findByCode(auto, "FRAMESEL").getString(Tag.TextValue));
        Attributes manual = measurementGroup(QlvSrWriter.build(template(), calibrated()).dataset());
        assertEquals("manual", findByCode(manual, "FRAMESEL").getString(Tag.TextValue));
    }

    @Test
    void usesPrivateSchemeForUnconfirmedCodes() {
        // 確認できていない標準コードを当てずっぽうで書くと、他システムが別の意味に解釈する。
        Attributes group = measurementGroup(QlvSrWriter.build(template(), calibrated()).dataset());
        for (String code : new String[] { "EF", "EDV", "ESV", "EFCORR", "FRAMESEL", "METHOD" }) {
            Attributes concept = findByCode(group, code).getNestedDataset(Tag.ConceptNameCodeSequence);
            assertEquals("99GRAPHYNEXT", concept.getString(Tag.CodingSchemeDesignator), code);
        }
        // 単位は UCUM でよい（%・mL は確定している）。
        Attributes unit = findByCode(group, "EDV")
                .getNestedDataset(Tag.MeasuredValueSequence)
                .getNestedDataset(Tag.MeasurementUnitsCodeSequence);
        assertEquals("UCUM", unit.getString(Tag.CodingSchemeDesignator));
        assertEquals("mL", unit.getString(Tag.CodeValue));
    }

    @Test
    void statesResearchUseOnly() {
        Attributes group = measurementGroup(QlvSrWriter.build(template(), calibrated()).dataset());
        String method = findByCode(group, "METHOD").getString(Tag.TextValue);
        assertTrue(method.contains("research use only"), method);
        assertTrue(method.contains("ellipsoidal"), "手法の仮定を残すこと: " + method);
    }
}

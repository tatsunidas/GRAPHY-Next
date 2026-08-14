/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.dose;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * RDSR（X-Ray Radiation Dose SR）の読み取り（{@code fw/angio-design.md} §14.2 / A9）。
 *
 * <p>実 RDSR は入手経路が未確定（設計 §20-5）なので、ここでは**構造だけ実物どおりに組んだ合成 SR**で
 * 検証する。パーサは<b>コード値ではなく CodeMeaning で突き合わせる</b>設計なので、
 * 装置ごとのコード表の差にはこのテストでは踏み込まない（実データを見てから育てる）。
 */
class RdsrParserTest {

    private static Attributes code(String value, String meaning) {
        Attributes a = new Attributes();
        a.setString(Tag.CodeValue, VR.SH, value);
        a.setString(Tag.CodingSchemeDesignator, VR.SH, "DCM");
        a.setString(Tag.CodeMeaning, VR.LO, meaning);
        return a;
    }

    private static Attributes container(String codeValue, String meaning) {
        Attributes n = new Attributes();
        n.setString(Tag.ValueType, VR.CS, "CONTAINER");
        n.newSequence(Tag.ConceptNameCodeSequence, 1).add(code(codeValue, meaning));
        return n;
    }

    private static Attributes num(String codeValue, String meaning, double value, String unit) {
        Attributes n = new Attributes();
        n.setString(Tag.ValueType, VR.CS, "NUM");
        n.newSequence(Tag.ConceptNameCodeSequence, 1).add(code(codeValue, meaning));
        Attributes measured = new Attributes();
        measured.setDouble(Tag.NumericValue, VR.DS, value);
        measured.newSequence(Tag.MeasurementUnitsCodeSequence, 1).add(code(unit, unit));
        n.newSequence(Tag.MeasuredValueSequence, 1).add(measured);
        return n;
    }

    private static Attributes codeItem(String codeValue, String meaning, String valueMeaning) {
        Attributes n = new Attributes();
        n.setString(Tag.ValueType, VR.CS, "CODE");
        n.newSequence(Tag.ConceptNameCodeSequence, 1).add(code(codeValue, meaning));
        n.newSequence(Tag.ConceptCodeSequence, 1).add(code("x", valueMeaning));
        return n;
    }

    private static Attributes uidRef(String codeValue, String meaning, String uid) {
        Attributes n = new Attributes();
        n.setString(Tag.ValueType, VR.CS, "UIDREF");
        n.newSequence(Tag.ConceptNameCodeSequence, 1).add(code(codeValue, meaning));
        n.setString(Tag.UID, VR.UI, uid);
        return n;
    }

    private static void addChild(Attributes parent, Attributes child) {
        Sequence seq = parent.getSequence(Tag.ContentSequence);
        if (seq == null) {
            seq = parent.newSequence(Tag.ContentSequence, 4);
        }
        seq.add(child);
    }

    /** 実物どおりの入れ子（root → Accumulated / Irradiation Event × 2）。 */
    private static Attributes sampleRdsr() {
        Attributes root = new Attributes();
        root.setString(Tag.SOPClassUID, VR.UI, RdsrParser.RDSR_SOP_CLASS);
        root.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.4");
        root.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        root.setString(Tag.SeriesInstanceUID, VR.UI, "1.2.3.9");
        root.setString(Tag.ContentDate, VR.DA, "20260814");
        root.setString(Tag.ContentTime, VR.TM, "093000");
        root.setString(Tag.Manufacturer, VR.LO, "ACME");

        Attributes acc = container("113702", "Accumulated X-Ray Dose Data");
        addChild(acc, num("113722", "Dose Area Product Total", 12.5, "Gy.m2"));
        addChild(acc, num("113725", "Dose (RP) Total", 340.0, "mGy"));
        addChild(acc, num("113730", "Fluoro Time", 180.0, "s"));
        addChild(root, acc);

        Attributes ev1 = container("113706", "Irradiation Event X-Ray Data");
        addChild(ev1, codeItem("113721", "Irradiation Event Type", "Fluoroscopy"));
        addChild(ev1, uidRef("113769", "Irradiation Event UID", "1.9.9.1"));
        addChild(ev1, num("113738", "Dose Area Product", 3.5, "Gy.m2"));
        addChild(ev1, num("113734", "Positioner Primary Angle", -30.0, "deg"));
        addChild(root, ev1);

        Attributes ev2 = container("113706", "Irradiation Event X-Ray Data");
        addChild(ev2, codeItem("113721", "Irradiation Event Type", "Stationary Acquisition"));
        addChild(ev2, uidRef("113769", "Irradiation Event UID", "1.9.9.2"));
        addChild(ev2, num("113738", "Dose Area Product", 9.0, "Gy.m2"));
        addChild(root, ev2);
        return root;
    }

    @Test
    void nonRdsrIsIgnored() {
        Attributes ct = new Attributes();
        ct.setString(Tag.SOPClassUID, VR.UI, "1.2.840.10008.5.1.4.1.1.2");
        assertFalse(RdsrParser.isRdsr(ct));
        assertNull(RdsrParser.parse(ct));
        assertNull(RdsrParser.parse(null));
    }

    @Test
    void readsIdentityAndDateTime() {
        RdsrParser.DoseReport r = RdsrParser.parse(sampleRdsr());
        assertNotNull(r);
        assertEquals("1.2.3.4", r.sopInstanceUid());
        assertEquals("1.2.3", r.studyInstanceUid());
        assertEquals("20260814093000", r.contentDateTime());
        assertEquals("ACME", r.manufacturer());
    }

    @Test
    void readsAccumulatedValuesWithUnits() {
        RdsrParser.DoseReport r = RdsrParser.parse(sampleRdsr());
        assertEquals(3, r.accumulated().size());
        RdsrParser.DoseItem dap = r.accumulated().get(0);
        assertEquals("Dose Area Product Total", dap.meaning());
        assertEquals(12.5, dap.numericValue());
        assertEquals("Gy.m2", dap.unit());
        // コード値も参考として残す（対応表を育てるため）。
        assertEquals("113722", dap.code());
    }

    @Test
    void readsIrradiationEvents() {
        RdsrParser.DoseReport r = RdsrParser.parse(sampleRdsr());
        assertEquals(2, r.events().size());
        RdsrParser.IrradiationEvent e0 = r.events().get(0);
        assertEquals("Fluoroscopy", e0.eventType());
        assertEquals("1.9.9.1", e0.eventUid());
        // イベント配下の値（角度などの付随情報も含めて）全部拾えていること。
        assertTrue(e0.items().stream().anyMatch(i -> "Dose Area Product".equals(i.meaning()) && i.numericValue() == 3.5));
        assertTrue(e0.items().stream().anyMatch(i -> "Positioner Primary Angle".equals(i.meaning())));
    }

    @Test
    void eventValuesAreNotCountedAsAccumulated() {
        // 照射イベント配下の Dose Area Product が積算に混ざると二重計上になる。
        RdsrParser.DoseReport r = RdsrParser.parse(sampleRdsr());
        assertEquals(12.5, RdsrParser.sumByMeaning(r.accumulated(), "dose area product total"));
        assertEquals(3, r.accumulated().size());
    }

    @Test
    void summingIsCaseInsensitiveAndReturnsNullWhenAbsent() {
        RdsrParser.DoseReport r = RdsrParser.parse(sampleRdsr());
        assertEquals(340.0, RdsrParser.sumByMeaning(r.accumulated(), "DOSE (RP) TOTAL"));
        // 見つからない項目は 0 ではなく null（「0 だった」と区別する）。
        assertNull(RdsrParser.sumByMeaning(r.accumulated(), "no such concept"));
    }

    @Test
    void handlesEmptyContentGracefully() {
        Attributes bare = new Attributes();
        bare.setString(Tag.SOPClassUID, VR.UI, RdsrParser.RDSR_SOP_CLASS);
        RdsrParser.DoseReport r = RdsrParser.parse(bare);
        assertNotNull(r);
        assertEquals(List.of(), r.accumulated());
        assertEquals(List.of(), r.events());
        assertNull(r.contentDateTime());
    }

    @Test
    void numWithoutMeasuredValueDoesNotCrash() {
        // 値が空の NUM（測定不能を示す）を含む SR。落ちずに読み飛ばせること。
        Attributes root = new Attributes();
        root.setString(Tag.SOPClassUID, VR.UI, RdsrParser.RDSR_SOP_CLASS);
        Attributes acc = container("113702", "Accumulated X-Ray Dose Data");
        Attributes broken = new Attributes();
        broken.setString(Tag.ValueType, VR.CS, "NUM");
        broken.newSequence(Tag.ConceptNameCodeSequence, 1).add(code("1", "Dose Area Product Total"));
        addChild(acc, broken);
        addChild(root, acc);
        RdsrParser.DoseReport r = RdsrParser.parse(root);
        assertEquals(1, r.accumulated().size());
        assertNull(r.accumulated().get(0).numericValue());
        assertNull(RdsrParser.sumByMeaning(r.accumulated(), "dose area product total"));
    }
}

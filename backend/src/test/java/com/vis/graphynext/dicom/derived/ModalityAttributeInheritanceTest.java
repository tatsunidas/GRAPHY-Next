/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.derived;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 派生シリーズのモダリティ別属性引き継ぎ（設計 {@code fw/registration-design.md} §8.3）。
 *
 * <p>守りたいのは 1 点に尽きる: <b>「見た目は PET なのに SUV が計算できない」シリーズを
 * 作らないこと</b>。画像は開けてしまうので、この壊れ方は最も気付くのが遅い。
 */
class ModalityAttributeInheritanceTest {

    /** SUV が計算できる PET のヘッダ。 */
    private static Attributes petTemplate() {
        Attributes a = new Attributes();
        a.setString(Tag.Modality, VR.CS, "PT");
        a.setString(Tag.PatientID, VR.LO, "P1");
        a.setString(Tag.Units, VR.CS, "BQML");
        a.setString(Tag.CorrectedImage, VR.CS, "DECY", "ATTN");
        a.setString(Tag.DecayCorrection, VR.CS, "START");
        a.setString(Tag.SeriesDate, VR.DA, "20260809");
        a.setString(Tag.SeriesTime, VR.TM, "101500");
        a.setDouble(Tag.PatientWeight, VR.DS, 62.5);

        Sequence rad = a.newSequence(Tag.RadiopharmaceuticalInformationSequence, 1);
        Attributes item = new Attributes();
        item.setDouble(Tag.RadionuclideTotalDose, VR.DS, 2.4e8);
        item.setString(Tag.RadiopharmaceuticalStartTime, VR.TM, "093000");
        item.setDouble(Tag.RadionuclideHalfLife, VR.DS, 6586.2);
        rad.add(item);
        return a;
    }

    @Test
    void petTagsAreInherited() {
        Attributes dst = new Attributes();
        ModalityAttributeInheritance.inherit(petTemplate(), dst, "PT");

        assertEquals("BQML", dst.getString(Tag.Units));
        assertEquals("START", dst.getString(Tag.DecayCorrection));
        assertEquals(62.5, dst.getDouble(Tag.PatientWeight, 0), 1e-9);
        assertEquals("101500", dst.getString(Tag.SeriesTime));

        Sequence rad = dst.getSequence(Tag.RadiopharmaceuticalInformationSequence);
        assertEquals(1, rad.size());
        assertEquals(6586.2, rad.get(0).getDouble(Tag.RadionuclideHalfLife, 0), 1e-9);
        assertEquals("093000", rad.get(0).getString(Tag.RadiopharmaceuticalStartTime));
    }

    @Test
    void sequenceIsDeepCopied() {
        // 参照だけ渡すと、元の Attributes を書き換えたときに派生側も変わってしまう。
        Attributes tmpl = petTemplate();
        Attributes dst = new Attributes();
        ModalityAttributeInheritance.inherit(tmpl, dst, "PT");

        tmpl.getSequence(Tag.RadiopharmaceuticalInformationSequence)
                .get(0).setDouble(Tag.RadionuclideHalfLife, VR.DS, 1.0);

        assertEquals(6586.2,
                dst.getSequence(Tag.RadiopharmaceuticalInformationSequence)
                        .get(0).getDouble(Tag.RadionuclideHalfLife, 0),
                1e-9);
    }

    @Test
    void ctIsUnaffected() {
        Attributes tmpl = new Attributes();
        tmpl.setString(Tag.Modality, VR.CS, "CT");
        tmpl.setString(Tag.PatientID, VR.LO, "P1");
        Attributes dst = new Attributes();
        ModalityAttributeInheritance.inherit(tmpl, dst, "CT");

        assertEquals("P1", dst.getString(Tag.PatientID));
        // PET 固有タグは付かない。
        assertFalse(dst.contains(Tag.Units));
        assertTrue(ModalityAttributeInheritance.missingRequired(dst, "CT").isEmpty());
    }

    @Test
    void completePetPassesTheRequiredCheck() {
        Attributes dst = new Attributes();
        ModalityAttributeInheritance.inherit(petTemplate(), dst, "PT");
        assertTrue(ModalityAttributeInheritance.missingRequired(dst, "PT").isEmpty());
    }

    @Test
    void missingUnitsIsReported() {
        Attributes tmpl = petTemplate();
        tmpl.remove(Tag.Units);
        Attributes dst = new Attributes();
        ModalityAttributeInheritance.inherit(tmpl, dst, "PT");

        List<String> missing = ModalityAttributeInheritance.missingRequired(dst, "PT");
        assertEquals(1, missing.size());
        assertTrue(missing.get(0).contains("Units"), missing.toString());
    }

    @Test
    void missingHalfLifeInsideTheSequenceIsReported() {
        // ★ シーケンスは在るのに中身が空、が最も嫌らしい。表側の存在だけ見ていると通ってしまう。
        Attributes tmpl = petTemplate();
        tmpl.getSequence(Tag.RadiopharmaceuticalInformationSequence)
                .get(0).remove(Tag.RadionuclideHalfLife);
        Attributes dst = new Attributes();
        ModalityAttributeInheritance.inherit(tmpl, dst, "PT");

        List<String> missing = ModalityAttributeInheritance.missingRequired(dst, "PT");
        assertEquals(1, missing.size());
        assertTrue(missing.get(0).contains("RadionuclideHalfLife"), missing.toString());
    }

    @Test
    void missingWeightAndDoseAreBothReported() {
        Attributes tmpl = petTemplate();
        tmpl.remove(Tag.PatientWeight);
        tmpl.getSequence(Tag.RadiopharmaceuticalInformationSequence)
                .get(0).remove(Tag.RadionuclideTotalDose);
        Attributes dst = new Attributes();
        ModalityAttributeInheritance.inherit(tmpl, dst, "PT");

        List<String> missing = ModalityAttributeInheritance.missingRequired(dst, "PT");
        assertEquals(2, missing.size(), missing.toString());
    }

    @Test
    void nmIsTreatedLikePet() {
        Attributes dst = new Attributes();
        ModalityAttributeInheritance.inherit(petTemplate(), dst, "NM");
        assertEquals("BQML", dst.getString(Tag.Units));
        assertTrue(ModalityAttributeInheritance.missingRequired(dst, "NM").isEmpty());
    }

    @Test
    void mrInheritsAcquisitionParameters() {
        Attributes tmpl = new Attributes();
        tmpl.setDouble(Tag.MagneticFieldStrength, VR.DS, 3.0);
        tmpl.setDouble(Tag.RepetitionTime, VR.DS, 500.0);
        tmpl.setDouble(Tag.EchoTime, VR.DS, 12.0);
        Attributes dst = new Attributes();
        ModalityAttributeInheritance.inherit(tmpl, dst, "MR");

        assertEquals(3.0, dst.getDouble(Tag.MagneticFieldStrength, 0), 1e-9);
        assertEquals(500.0, dst.getDouble(Tag.RepetitionTime, 0), 1e-9);
        // MR は定量が標準化されていないので必須チェックは掛けない。
        assertTrue(ModalityAttributeInheritance.missingRequired(dst, "MR").isEmpty());
    }

    @Test
    void rescaleTypeFollowsUnitsForPet() {
        // 従来は「CT なら HU」しか無く、PET には何も入らなかった。
        assertEquals("HU", ModalityAttributeInheritance.defaultRescaleType("CT", new Attributes()));
        assertEquals("BQML", ModalityAttributeInheritance.defaultRescaleType("PT", petTemplate()));

        Attributes noUnits = petTemplate();
        noUnits.remove(Tag.Units);
        assertNull(ModalityAttributeInheritance.defaultRescaleType("PT", noUnits));
        assertNull(ModalityAttributeInheritance.defaultRescaleType("MR", petTemplate()));
    }

    @Test
    void suvAlreadyAppliedSeriesKeepsItsMarker() {
        // Units=GML / SUVType は「もう SUV 化済み」の印。これを落とすと二重に SUV 化される。
        Attributes tmpl = petTemplate();
        tmpl.setString(Tag.Units, VR.CS, "GML");
        tmpl.setString(Tag.SUVType, VR.CS, "BW");
        Attributes dst = new Attributes();
        ModalityAttributeInheritance.inherit(tmpl, dst, "PT");

        assertEquals("GML", dst.getString(Tag.Units));
        assertEquals("BW", dst.getString(Tag.SUVType));
        assertEquals("GML", ModalityAttributeInheritance.defaultRescaleType("PT", tmpl));
    }
}

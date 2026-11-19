/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 値の種類の判定。ヘッダだけから決めること、「離散の校正値」と確認できたときだけ mode 0・丸めを使うことを、
 * 正例（離散・連続・任意単位がそれぞれ出る）と負例（離散になりそうで、ならないもの）で確かめる。
 */
class ValueKindTest {

    private static final ValueKind.Spec AUTO = new ValueKind.Spec("auto", null, false);

    private static Attributes ct(String imageType0, String rescaleType, String slope, String intercept) {
        Attributes ds = new Attributes();
        ds.setString(Tag.Modality, VR.CS, "CT");
        ds.setString(Tag.ImageType, VR.CS, imageType0, "PRIMARY", "AXIAL");
        if (rescaleType != null) {
            ds.setString(Tag.RescaleType, VR.LO, rescaleType);
        }
        if (slope != null) {
            ds.setString(Tag.RescaleSlope, VR.DS, slope);
        }
        if (intercept != null) {
            ds.setString(Tag.RescaleIntercept, VR.DS, intercept);
        }
        return ds;
    }

    private static Attributes mr(String rescaleType) {
        Attributes ds = new Attributes();
        ds.setString(Tag.Modality, VR.CS, "MR");
        ds.setString(Tag.ImageType, VR.CS, "ORIGINAL", "PRIMARY", "M");
        if (rescaleType != null) {
            ds.setString(Tag.RescaleType, VR.LO, rescaleType);
        }
        return ds;
    }

    private static ValueKind decide(Attributes first, Attributes last, ValueKind.Spec spec) {
        ValueCalibration vc = ValueCalibration.resolve("auto", first, last);
        return ValueKind.decide(vc.facts(), vc, spec);
    }

    private static ValueKind decide(Attributes first, ValueKind.Spec spec) {
        return decide(first, null, spec);
    }

    // ---- 正例 ----

    @Test
    void anOriginalCtInHuWithIntegerRescaleIsDiscreteAndUsesMode0() {
        ValueKind k = decide(ct("ORIGINAL", "HU", "1", "-1024"), ct("ORIGINAL", "HU", "1", "-1024"), AUTO);
        assertEquals(ValueKind.DISCRETE, k.kind());
        assertEquals(0, k.ivhMode());
        assertNull(k.ivhBinWidth());
        assertFalse(k.rounding(), "丸めは既定 off");
        assertTrue(k.basis().contains("RescaleType=HU") && k.basis().contains("ImageType=ORIGINAL"), k.basis());
        assertTrue(k.flags().isEmpty());
    }

    @Test
    void roundingIsAvailableOnlyForDiscrete() {
        ValueKind k = decide(ct("ORIGINAL", "HU", "1", "-1024"), new ValueKind.Spec("auto", null, true));
        assertTrue(k.rounding());
        assertTrue(k.flags().isEmpty());
    }

    @Test
    void anMrAndAMammoAreArbitraryUnitsAndUseMode2() {
        ValueKind k = decide(mr(null), AUTO);
        assertEquals(ValueKind.ARBITRARY, k.kind());
        assertEquals(2, k.ivhMode());
        Attributes mg = new Attributes();
        mg.setString(Tag.Modality, VR.CS, "MG");
        assertEquals(ValueKind.ARBITRARY, decide(mg, AUTO).kind());
        assertEquals(2, decide(mg, AUTO).ivhMode());
    }

    @Test
    void aComputedImageWithAUnitIsContinuousAndNeedsABinWidth() {
        // 計算画像（ADC）: Rescale Type が単位。ビン幅の指定があれば mode 1
        Attributes adc = mr("mm2/s");
        ValueKind k = decide(adc, new ValueKind.Spec("auto", 0.0001, false));
        assertEquals(ValueKind.CONTINUOUS, k.kind());
        assertEquals(1, k.ivhMode());
        assertEquals(0.0001, k.ivhBinWidth());
        assertTrue(k.basis().contains("unit=mm2/s"), k.basis());
        assertFalse(k.rounding());
    }

    // ---- 負例: 離散になりそうで、ならないもの（値を壊さない側に倒す）----

    @Test
    void aDerivedCtInHuIsNotDiscrete() {
        ValueKind k = decide(ct("DERIVED", "HU", "1", "-1024"), AUTO);
        assertFalse(ValueKind.DISCRETE.equals(k.kind()), "派生の CT は離散と確認できない");
        assertFalse(Integer.valueOf(0).equals(k.ivhMode()), "mode 0 にしない");
        assertFalse(k.rounding());
    }

    @Test
    void aCtWithAFractionalSlopeIsNotDiscrete() {
        assertFalse(ValueKind.DISCRETE.equals(decide(ct("ORIGINAL", "HU", "0.5", "-1024"), AUTO).kind()));
        assertFalse(ValueKind.DISCRETE.equals(decide(ct("ORIGINAL", "HU", "1", "-1024.5"), AUTO).kind()));
    }

    @Test
    void aCtWhoseLastSliceHasAFractionalSlopeIsNotDiscrete() {
        ValueKind k = decide(ct("ORIGINAL", "HU", "1", "-1024"), ct("ORIGINAL", "HU", "1.5", "-1024"), AUTO);
        assertFalse(ValueKind.DISCRETE.equals(k.kind()));
    }

    @Test
    void aCtWithoutRescaleIsNotDiscrete() {
        assertFalse(ValueKind.DISCRETE.equals(decide(ct("ORIGINAL", "HU", null, null), AUTO).kind()), "傾き・切片が読めない");
        assertFalse(ValueKind.DISCRETE.equals(decide(ct("ORIGINAL", null, null, null), AUTO).kind()));
    }

    @Test
    void aCtWithAnotherRescaleTypeIsNotDiscrete() {
        // Rescale Type が HU 以外と書かれた CT（単位が別）は離散にしない
        assertFalse(ValueKind.DISCRETE.equals(decide(ct("ORIGINAL", "US", "1", "-1024"), AUTO).kind()));
        assertFalse(ValueKind.DISCRETE.equals(decide(ct("ORIGINAL", "MGML", "1", "0"), AUTO).kind()));
    }

    @Test
    void anOriginalCtWithoutRescaleTypeIsDiscrete() {
        // 実データ（TCIA の CT など）は Rescale Type が空のことが多い。CT の画素値は HU と DICOM が定める
        ValueKind k = decide(ct("ORIGINAL", null, "1", "-1024"), AUTO);
        assertEquals(ValueKind.DISCRETE, k.kind());
        assertEquals(0, k.ivhMode());
        assertTrue(k.basis().contains("RescaleType=absent(CT)"), k.basis());
    }

    @Test
    void anMrWithoutRescaleTypeIsNeverDiscreteEvenWithIntegerRescale() {
        Attributes m = mr(null);
        m.setString(Tag.RescaleSlope, VR.DS, "1");
        m.setString(Tag.RescaleIntercept, VR.DS, "0");
        assertFalse(ValueKind.DISCRETE.equals(decide(m, AUTO).kind()), "空の Rescale Type を HU とみなすのは CT だけ");
    }

    @Test
    void aParametricMapIsNeverDiscrete() {
        Attributes pm = ct("ORIGINAL", "HU", "1", "0");
        pm.setString(Tag.SOPClassUID, VR.UI, UID.ParametricMapStorage);
        assertFalse(ValueKind.DISCRETE.equals(decide(pm, AUTO).kind()), "浮動小数の画素は離散ではない");
    }

    @Test
    void aContinuousUnitWithoutABinWidthFallsBackToArbitraryWithAFlag() {
        // ADC: 単位はあるが、単位ごとの既定のビン幅は置かない → 値を作らず任意単位（mode 2）。旗を付ける
        ValueKind k = decide(mr("mm2/s"), AUTO);
        assertEquals(ValueKind.ARBITRARY, k.kind());
        assertEquals(2, k.ivhMode());
        assertTrue(k.flags().contains(ValueKind.FLAG_BINWIDTH_UNSET), k.flags().toString());
    }

    @Test
    void anExplicitContinuousWithoutABinWidthIsRefused() {
        assertThrows(IllegalArgumentException.class,
                () -> decide(mr("mm2/s"), new ValueKind.Spec("continuous", null, false)));
    }

    @Test
    void roundingOnANonDiscreteImageIsIgnoredWithAFlag() {
        ValueKind k = decide(mr(null), new ValueKind.Spec("auto", null, true));
        assertFalse(k.rounding());
        assertTrue(k.flags().contains(ValueKind.FLAG_ROUNDING_IGNORED));
    }

    @Test
    void anOverrideIsHonouredAndFlagged() {
        ValueKind k = decide(mr(null), new ValueKind.Spec("discrete", null, true));
        assertEquals(ValueKind.DISCRETE, k.kind());
        assertEquals(0, k.ivhMode());
        assertTrue(k.rounding());
        assertTrue(k.flags().contains(ValueKind.FLAG_OVERRIDDEN));
        // 同じ種類を指定したときは旗を付けない
        assertTrue(decide(ct("ORIGINAL", "HU", "1", "-1024"), new ValueKind.Spec("discrete", null, false)).flags().isEmpty());
    }

    @Test
    void invalidSpecsAreRefused() {
        assertThrows(IllegalArgumentException.class, () -> decide(mr(null), new ValueKind.Spec("xyz", null, false)));
        assertThrows(IllegalArgumentException.class, () -> decide(mr(null), new ValueKind.Spec("auto", -1.0, false)));
        assertThrows(IllegalArgumentException.class, () -> decide(mr(null), new ValueKind.Spec("auto", 0.0, false)));
    }

    @Test
    void noSpecKeepsTheLegacyBehaviour() {
        ValueKind k = decide(ct("ORIGINAL", "HU", "1", "-1024"), null);
        assertEquals(ValueKind.LEGACY, k.kind());
        assertNull(k.ivhMode());
        Map<String, String> s = Map.of("INT_binCount", "32");
        assertEquals(s, RoiFeatureService.applyValueKind(s, k), "従来は設定に何も足さない");
        assertThrows(IllegalArgumentException.class,
                () -> decide(mr(null), new ValueKind.Spec(null, null, true)), "分類しないのに丸めだけを指定した");
    }

    // ---- 設定への反映 ----

    @Test
    void appliesTheModeAndKeepsAnExplicitSetting() {
        ValueKind k = decide(mr(null), AUTO);
        Map<String, String> out = RoiFeatureService.applyValueKind(Map.of("INT_binCount", "32"), k);
        assertEquals("2", out.get("INT_IVH_MODE"));
        // 利用者が同じキーを直接渡したときは、そちらを優先する
        Map<String, String> explicit = RoiFeatureService.applyValueKind(Map.of("INT_IVH_MODE", "0"), k);
        assertEquals("0", explicit.get("INT_IVH_MODE"));
        ValueKind d = decide(ct("ORIGINAL", "HU", "1", "-1024"), new ValueKind.Spec("auto", null, true));
        assertEquals("1", RoiFeatureService.applyValueKind(Map.of(), d).get("BOOL_interpolation_intensity_rounding"));
        ValueKind c = decide(mr("mm2/s"), new ValueKind.Spec("auto", 0.0002, false));
        assertEquals("1", RoiFeatureService.applyValueKind(Map.of(), c).get("INT_IVH_MODE"));
        assertEquals("2.0E-4", RoiFeatureService.applyValueKind(Map.of(), c).get("DOUBLE_IVH_binWidth"));
    }
}

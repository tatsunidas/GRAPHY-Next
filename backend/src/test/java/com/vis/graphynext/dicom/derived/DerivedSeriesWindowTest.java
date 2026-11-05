/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.derived;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * 派生シリーズの窓（W/L）。<b>プラグインの出力は元画像とは別の量</b>なので、元の窓を引き継がない
 * （実機: 0〜14.7 Gy の線量マップに、元の SPECT の窓 3887/7774 が残って真っ黒になった）。
 * 本体の機能による派生（producer なし）は同じ量なので、今までどおり引き継ぐ。
 */
class DerivedSeriesWindowTest {

    private static final DerivedSeriesRequest.Producer PLUGIN =
            new DerivedSeriesRequest.Producer("dosimetry", "Dosimetry", "0.1.2");

    private static DerivedSeriesRequest req(DerivedSeriesRequest.Producer producer) {
        return req(producer, null, null);
    }

    private static DerivedSeriesRequest req(DerivedSeriesRequest.Producer producer, Double wc, Double ww) {
        return new DerivedSeriesRequest("1.2.3", "1.2.4", "Dose map", null, 2, 2,
                new double[] {1.0, 1.0}, 1.0, 1.0, null, null, null, null, null, null, null, null, wc, ww, producer, null,
                List.of(new DerivedSeriesRequest.Frame(1, null, "")));
    }

    private static Attributes build(DerivedSeriesRequest.Producer producer, Double wc, Double ww) {
        DerivedSeriesRequest r = req(producer, wc, ww);
        return new DerivedSeriesService(null, null).buildInstance(sourceWithWindow(), r, "1.2.9", 1001, "OT",
                r.frames().get(0), new byte[8]);
    }

    private static Attributes sourceWithWindow() {
        Attributes t = new Attributes();
        t.setString(Tag.Modality, VR.CS, "NM");
        t.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        t.setDouble(Tag.WindowCenter, VR.DS, 3887.0);
        t.setDouble(Tag.WindowWidth, VR.DS, 7774.0);
        t.setString(Tag.VOILUTFunction, VR.CS, "LINEAR");
        return t;
    }

    private static Attributes build(DerivedSeriesRequest.Producer producer) {
        DerivedSeriesService svc = new DerivedSeriesService(null, null);
        return svc.buildInstance(sourceWithWindow(), req(producer), "1.2.9", 1001, "OT",
                req(producer).frames().get(0), new byte[8]);
    }

    @Test
    void pluginOutput_dropsTheSourceWindow() {
        Attributes a = build(PLUGIN);
        assertFalse(a.contains(Tag.WindowCenter));
        assertFalse(a.contains(Tag.WindowWidth));
        assertFalse(a.contains(Tag.VOILUTFunction));
    }

    @Test
    void pluginOutput_writesTheWindowThePluginSpecified() {
        Attributes a = build(PLUGIN, 0.0015, 0.003);
        assertEquals(0.0015, a.getDouble(Tag.WindowCenter, Double.NaN), 1e-12);
        assertEquals(0.003, a.getDouble(Tag.WindowWidth, Double.NaN), 1e-12);
        assertEquals(VR.DS, a.getVR(Tag.WindowCenter));
    }

    @Test
    void pluginWindow_isWrittenAsLinearExact_soAWidthBelowOneIsNotInverted() {
        // 幅 0.003 の窓（ADC）。LINEAR のままだと上下が逆転する（DICOM の式は幅 1 以上が前提）。
        Attributes a = build(PLUGIN, 0.0015, 0.003);
        assertEquals("LINEAR_EXACT", a.getString(Tag.VOILUTFunction));
        assertEquals(VR.CS, a.getVR(Tag.VOILUTFunction));
        // 窓を渡さないときは付けない（元の VOILUTFunction も外れたまま）
        assertFalse(build(PLUGIN).contains(Tag.VOILUTFunction));
        // producer なしの本体の機能は、元の VOILUTFunction をそのまま引き継ぐ（プラグインの指定は無視）
        assertEquals("LINEAR", build(null, 0.0015, 0.003).getString(Tag.VOILUTFunction));
    }

    @Test
    void coreDerivation_ignoresAPluginWindowAndKeepsTheSourceOne() {
        Attributes a = build(null, 0.0015, 0.003);
        assertEquals(3887.0, a.getDouble(Tag.WindowCenter, 0), 0.0);
        assertEquals(7774.0, a.getDouble(Tag.WindowWidth, 0), 0.0);
    }

    @Test
    void rejectsHalfSpecifiedNonFiniteOrNonPositiveWidthWindows() {
        DerivedSeriesService svc = new DerivedSeriesService(null, null);
        for (Double[] w : new Double[][] {
                {1.0, null}, {null, 1.0}, {Double.NaN, 1.0}, {1.0, Double.POSITIVE_INFINITY}, {1.0, 0.0}, {1.0, -2.0}}) {
            assertThrows(IllegalArgumentException.class, () -> svc.create(req(PLUGIN, w[0], w[1])), w[0] + "/" + w[1]);
        }
    }

    @Test
    void coreDerivation_keepsTheSourceWindow() {
        Attributes a = build(null);
        assertEquals(3887.0, a.getDouble(Tag.WindowCenter, 0), 0.0);
        assertEquals(7774.0, a.getDouble(Tag.WindowWidth, 0), 0.0);
        assertEquals("LINEAR", a.getString(Tag.VOILUTFunction));
    }
}

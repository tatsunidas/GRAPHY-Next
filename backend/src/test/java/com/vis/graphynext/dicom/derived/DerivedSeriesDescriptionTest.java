/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.derived;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * プラグイン由来の派生シリーズ（fw/plugin-architecture.md §7 の H4b）で、
 * <b>出所が必ず残る</b>ことを固定する。プラグインは本体と同じ権限で動くため、
 * 出力の由来を消せる状態にしないことが要件。
 */
class DerivedSeriesDescriptionTest {

    private static final DerivedSeriesRequest.Producer PLUGIN =
            new DerivedSeriesRequest.Producer("bone-mask", "Bone Mask", "1.2.0");

    private static DerivedSeriesRequest req(String seriesDescription, String derivation,
                                            DerivedSeriesRequest.Producer producer) {
        return new DerivedSeriesRequest("1.2.3", "1.2.4", seriesDescription, null, 4, 4,
                new double[] {1.0, 1.0}, 1.0, 1.0, null, derivation, null, null, null, producer,
                List.of(new DerivedSeriesRequest.Frame(1, null, "")));
    }

    @Test
    void seriesDescription_prefixesPluginOutput() {
        assertEquals("[Plugin] Bone mask", DerivedSeriesService.seriesDescription(req("Bone mask", null, PLUGIN)));
    }

    @Test
    void seriesDescription_noPrefixForCoreFeatures() {
        assertEquals("Axial Reslice", DerivedSeriesService.seriesDescription(req("Axial Reslice", null, null)));
    }

    @Test
    void seriesDescription_doesNotDoublePrefix() {
        assertEquals("[Plugin] Bone mask",
                DerivedSeriesService.seriesDescription(req("[Plugin] Bone mask", null, PLUGIN)));
    }

    @Test
    void seriesDescription_blankFallsBackToDefaultWithPrefix() {
        assertEquals("[Plugin] Reslice", DerivedSeriesService.seriesDescription(req(" ", null, PLUGIN)));
    }

    @Test
    void seriesDescription_truncatedToLoLimit_keepingPrefix() {
        String longDesc = "x".repeat(80);
        String out = DerivedSeriesService.seriesDescription(req(longDesc, null, PLUGIN));
        assertEquals(64, out.length());
        // 接頭辞を優先して末尾を切る（「プラグイン出力」が消えないことが重要）。
        assertTrue(out.startsWith("[Plugin] "));
    }

    @Test
    void derivationDescription_includesPluginIdAndVersion() {
        assertEquals("Threshold 300 HU (GRAPHY-Next plugin: bone-mask 1.2.0)",
                DerivedSeriesService.derivationDescription(req("d", "Threshold 300 HU", PLUGIN)));
    }

    @Test
    void derivationDescription_blankStillIdentifiesPlugin() {
        assertEquals("Plugin output (GRAPHY-Next plugin: bone-mask 1.2.0)",
                DerivedSeriesService.derivationDescription(req("d", null, PLUGIN)));
    }

    @Test
    void derivationDescription_keepsIdWhenVersionMissing() {
        DerivedSeriesRequest.Producer noVersion = new DerivedSeriesRequest.Producer("p", "P", null);
        assertEquals("Plugin output (GRAPHY-Next plugin: p)",
                DerivedSeriesService.derivationDescription(req("d", null, noVersion)));
    }

    @Test
    void derivationDescription_unchangedForCoreFeatures() {
        assertEquals("Oblique reslice (GRAPHY-Next Slicer)",
                DerivedSeriesService.derivationDescription(req("d", null, null)));
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.vis.graphynext.anonymize.AnonymizeService;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** fw/remote-compute-design.md §3.2 の表。破れると画素に写った患者情報が外へ出る。 */
class RemoteBurnPolicyTest {

    private static final String CT = "1.2.840.10008.5.1.4.1.1.2";
    private static final String SC = "1.2.840.10008.5.1.4.1.1.7";
    private static final String SC_MF = "1.2.840.10008.5.1.4.1.1.7.4";
    private static final String VL_PHOTO = "1.2.840.10008.5.1.4.1.1.77.1.4";

    private static AnonymizeService.SeriesBurnFacts facts(int burnable, int blocked, int unmasked, int yes,
                                                          String modality, String sop) {
        return new AnonymizeService.SeriesBurnFacts(
                new AnonymizeService.BurnPreflight(burnable, blocked, unmasked, List.of()), yes,
                modality == null ? Set.of() : Set.of(modality), Set.of(sop), burnable + blocked + unmasked);
    }

    private static RemoteBurnPolicy.Decision decide(AnonymizeService.SeriesBurnFacts f) {
        return RemoteBurnPolicy.decide(f);
    }

    @Test
    void ctAndMrWithoutDeclarationAreSentWithoutPainting() {
        RemoteBurnPolicy.Decision d = decide(facts(0, 0, 10, 0, "CT", CT));
        assertTrue(d.allowed());
        assertFalse(d.burnIn());
        assertTrue(decide(facts(0, 0, 10, 0, "MR", "1.2.840.10008.5.1.4.1.1.4")).allowed());
    }

    @Test
    void declaredBurnedInWithoutMaskIsRefused() {
        assertEquals("burnin-declared", decide(facts(0, 0, 10, 1, "CT", CT)).reason());
    }

    @Test
    void riskyModalitiesWithoutMaskAreRefused() {
        for (String m : List.of("US", "XA", "RF", "ES", "SC", "OT", "DX", "CR", "MG", "XC")) {
            RemoteBurnPolicy.Decision d = decide(facts(0, 0, 3, 0, m, CT));
            assertFalse(d.allowed(), m);
            assertEquals("burnin-risky-modality", d.reason(), m);
        }
    }

    @Test
    void secondaryCaptureAndVisibleLightAreRefusedEvenAsCt() {
        // SC で作り直された CT（スクリーンショット）は BurnedInAnnotation を当てにできない
        assertEquals("burnin-risky-sop-class", decide(facts(0, 0, 1, 0, "CT", SC)).reason());
        assertEquals("burnin-risky-sop-class", decide(facts(0, 0, 1, 0, "CT", SC_MF)).reason());
        assertEquals("burnin-risky-sop-class", decide(facts(0, 0, 1, 0, "CT", VL_PHOTO)).reason());
        // 接頭辞が同じだけの別クラス（.1.70 など）までは巻き込まない
        assertTrue(decide(facts(0, 0, 1, 0, "CT", "1.2.840.10008.5.1.4.1.1.70")).allowed());
    }

    @Test
    void maskedSeriesIsSentWithPainting() {
        RemoteBurnPolicy.Decision d = decide(facts(5, 0, 0, 5, "US", "1.2.840.10008.5.1.4.1.1.3.1"));
        assertTrue(d.allowed());
        assertTrue(d.burnIn());
    }

    @Test
    void maskThatCannotBePaintedIsRefused() {
        assertEquals("burnin-mask-blocked", decide(facts(4, 1, 0, 5, "XA", CT)).reason());
        assertEquals("burnin-mask-partial", decide(facts(4, 0, 1, 0, "XA", CT)).reason());
    }

    @Test
    void unknownOrEmptyIsRefused() {
        assertEquals("series-not-found", decide(facts(0, 0, 0, 0, "CT", CT)).reason());
        assertEquals("burnin-unknown-modality", decide(facts(0, 0, 2, 0, null, CT)).reason());
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 画素間隔（PixelSpacing）の無い画像: 旗を付け、体積を mm³ として出さない（単位の取り違えを避ける）。 */
class UncalibratedSpacingTest {

    private static RadiomicsMapEngine.LoadedVolume volume(double row, double col) {
        return new RadiomicsMapEngine.LoadedVolume(null, null, 4, 4, 2, 1, true, null, null, row, col, null, null, null, null, false);
    }

    @Test
    void aVolumeWithPixelSpacingHasNoFlag() {
        assertTrue(RoiFeatureService.spacingCalibrated(volume(0.7, 0.7)));
        assertEquals(List.of(), RoiFeatureService.loadFlagsOf(volume(0.7, 0.7)));
    }

    @Test
    void aVolumeWithoutPixelSpacingIsFlagged() {
        assertFalse(RoiFeatureService.spacingCalibrated(volume(0, 0)));
        assertEquals(List.of(RoiFeatureService.FLAG_UNCALIBRATED_SPACING), RoiFeatureService.loadFlagsOf(volume(0, 0)));
        // 片方だけ無いのも、校正されていない
        assertFalse(RoiFeatureService.spacingCalibrated(volume(0.7, 0)));
    }

    @Test
    void theVolumeIsDroppedButTheVoxelCountsStay() {
        RoiFeatureResult.RoiSize s = new RoiFeatureResult.RoiSize(100L, 90L, 100L, 123.4, 50, false);
        RoiFeatureResult.RoiSize n = s.withoutVolume();
        assertNull(n.volumeMm3());
        assertEquals(100L, n.initialVoxels());
        assertEquals(90L, n.intensityVoxels());
        assertEquals(100L, n.morphVoxels());
        assertEquals(50, n.smallRoiWarnVoxels());
        assertEquals(false, n.smallRoi());
    }

    @Test
    void theFlagReachesTheProvenanceRecordAndTheBatchQcFlags() {
        RoiFeatureResult.Provenance p = new RoiFeatureResult.Provenance("g", "rj", java.time.Instant.EPOCH, "sha")
                .withCalibration(ValueCalibration.UNSET, ValueKind.NONE, List.of(RoiFeatureService.FLAG_UNCALIBRATED_SPACING));
        assertEquals(List.of(RoiFeatureService.FLAG_UNCALIBRATED_SPACING), p.recordFlags());
        assertNull(p.valueKind(), "値の種類を分類しないときは、種類の欄は空のまま（旗だけ付く）");
        RoiFeatureResult r = new RoiFeatureResult("rj", java.time.Instant.EPOCH, false, 1, List.of(), null, p, null,
                new RoiFeatureResult.RoiSize(1L, 1L, 1L, null, null, null), false);
        assertTrue(RadiomicsBatchService.qcFlagsOf(r).contains(RoiFeatureService.FLAG_UNCALIBRATED_SPACING));
    }
}

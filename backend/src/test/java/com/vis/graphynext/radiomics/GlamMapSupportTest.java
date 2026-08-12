/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import io.github.tatsunidas.radiomics.main.RadiomicsJ;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * GLAM を可視化マップに載せるための前提の回帰テスト。
 *
 * <p>ここで守っているのは、黙って壊れる 3 つの筋道（設計 {@code fw/texture-radiomics-design.md} §11）。
 * <ul>
 *   <li>maxRadius がカーネルを超えると、値は変わらないまま巨大な配列を窓ごとに捨てる</li>
 *   <li>3D 専用・マスク必須の前提を外すと、RadiomicsJ の例外がボクセルごとに握り潰され、
 *       <b>全面ゼロのマップが黙って出来上がる</b></li>
 *   <li>{@code RadiomicsJ.glam*} はプロセス広域なので、戻し忘れると次の計算に漏れる</li>
 * </ul>
 */
class GlamMapSupportTest {

    private static TextureSeriesRequest request(String feature, int filterSize, boolean force2D) {
        return new TextureSeriesRequest("1.2.3", "1.2.3.4", null, 0, feature, filterSize, 1, force2D,
                0, 0, new HashMap<>(), null, null, null);
    }

    // ── 族の判定 ────────────────────────────────────────────────

    @Test
    void recognisesTheGlamFamily() {
        assertTrue(GlamMapSupport.isGlam("GLAM_SecondVirialCoefficient_Mean"));
        assertFalse(GlamMapSupport.isGlam("GLCM_JointEntropy"));
        assertFalse(GlamMapSupport.isGlam(null));
        // 接頭辞が一致するだけの別族に引っかからないこと
        assertFalse(GlamMapSupport.isGlam("GLAMOUR_Something"));
    }

    // ── maxRadius ──────────────────────────────────────────────

    @Test
    void capsMaxRadiusAtTheKernelRadius() {
        Map<String, String> settings = new HashMap<>();
        // 既定の 100 をそのまま渡すと、窓の外を見ようとして 1 窓あたり数百 KB を捨てる
        settings.put("INT_GLAM_maxRadius", "100");
        assertEquals(3, GlamMapSupport.maxRadiusFor(7, settings));
        assertEquals(7, GlamMapSupport.maxRadiusFor(15, settings));
    }

    @Test
    void derivesMaxRadiusFromTheKernelWhenNotConfigured() {
        assertEquals(5, GlamMapSupport.maxRadiusFor(11, new HashMap<>()));
        Map<String, String> zero = new HashMap<>();
        zero.put("INT_GLAM_maxRadius", "0");
        assertEquals(5, GlamMapSupport.maxRadiusFor(11, zero));
    }

    @Test
    void honoursASmallerConfiguredRadius() {
        Map<String, String> settings = new HashMap<>();
        settings.put("INT_GLAM_maxRadius", "2");
        assertEquals(2, GlamMapSupport.maxRadiusFor(15, settings));
    }

    @Test
    void neverGoesBelowTwo() {
        // RadiomicsJ 自身も 2 で頭打ちにする。ここで揃えておかないと設定と実際がずれる
        assertEquals(2, GlamMapSupport.maxRadiusFor(3, new HashMap<>()));
    }

    // ── 前提のチェック ──────────────────────────────────────────

    @Test
    void rejectsTwoDimensionalRequests() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> GlamMapSupport.validate(request("GLAM_PotentialEnergy_Mean", 7, true), 40, true, null));
        assertTrue(e.getMessage().contains("3D"));
    }

    @Test
    void rejectsAVolumeThatIsASingleSlice() {
        assertThrows(IllegalArgumentException.class,
                () -> GlamMapSupport.validate(request("GLAM_PotentialEnergy_Mean", 7, false), 1, true, null));
    }

    @Test
    void rejectsAKernelTooSmallToHoldADistance() {
        assertThrows(IllegalArgumentException.class,
                () -> GlamMapSupport.validate(request("GLAM_PotentialEnergy_Mean", 3, false), 40, true, null));
    }

    @Test
    void rejectsAWholeImageBecauseTheWindowCountIsNotWorkable() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> GlamMapSupport.validate(request("GLAM_PotentialEnergy_Mean", 7, false), 40, false, null));
        assertTrue(e.getMessage().contains("マスク"));
    }

    @Test
    void acceptsAThreeDimensionalRequestWithAMask() {
        GlamMapSupport.validate(request("GLAM_PotentialEnergy_Mean", 7, false), 40, true, null);
        // 非等方は警告だけで通す（等方へのリサンプルは利用者の判断）
        GlamMapSupport.validate(request("GLAM_PotentialEnergy_Mean", 7, false), 40, true, "not isotropic");
    }

    // ── 境界補正と相性の悪い行列 ─────────────────────────────────

    @Test
    void knowsWhichMatricesTheBoundaryCorrectionRuins() {
        assertTrue(GlamMapSupport.dependsOnBoundaryCorrection("GLAM_ConfigurationalDisorderIndex_Mean"));
        assertTrue(GlamMapSupport.dependsOnBoundaryCorrection("GLAM_FrustrationIndex_Maximum"));
        assertFalse(GlamMapSupport.dependsOnBoundaryCorrection("GLAM_SecondVirialCoefficient_Mean"));
    }

    // ── プロセス広域 static の上書きと復元 ────────────────────────

    @Test
    void appliesTheSettingsAndPutsThemBack() throws Exception {
        Integer originalReferenceVoxels = RadiomicsJ.glamMaxReferenceVoxels;
        Boolean originalBoundaryCorrection = RadiomicsJ.glamBoundaryCorrection;
        Integer originalRandomisations = RadiomicsJ.glamNumRandomisations;
        Double originalProminence = RadiomicsJ.glamPeakProminence;

        Map<String, String> settings = new HashMap<>();
        settings.put("INT_GLAM_maxReferenceVoxels", "1000");
        settings.put("BOOL_GLAM_boundaryCorrection", "0");
        settings.put("INT_GLAM_numRandomisations", "4");
        settings.put("DOUBLE_GLAM_peakProminence", "2.5");

        String result = GlamMapSupport.runWithSettings(settings, () -> {
            assertEquals(1000, RadiomicsJ.glamMaxReferenceVoxels);
            assertEquals(Boolean.FALSE, RadiomicsJ.glamBoundaryCorrection);
            assertEquals(4, RadiomicsJ.glamNumRandomisations);
            assertEquals(2.5, RadiomicsJ.glamPeakProminence, 1e-9);
            return "done";
        });

        assertEquals("done", result);
        assertEquals(originalReferenceVoxels, RadiomicsJ.glamMaxReferenceVoxels);
        assertEquals(originalBoundaryCorrection, RadiomicsJ.glamBoundaryCorrection);
        assertEquals(originalRandomisations, RadiomicsJ.glamNumRandomisations);
        assertEquals(originalProminence, RadiomicsJ.glamPeakProminence);
    }

    @Test
    void putsTheSettingsBackEvenWhenTheComputationFails() {
        Boolean original = RadiomicsJ.glamBoundaryCorrection;
        Map<String, String> settings = new HashMap<>();
        settings.put("BOOL_GLAM_boundaryCorrection", original ? "0" : "1");

        assertThrows(IllegalStateException.class, () -> GlamMapSupport.runWithSettings(settings, () -> {
            throw new IllegalStateException("boom");
        }));
        assertEquals(original, RadiomicsJ.glamBoundaryCorrection);
    }

    @Test
    void keepsTheCurrentValueWhenASettingIsMissingOrUnreadable() throws Exception {
        Integer original = RadiomicsJ.glamSavitzkyGolayWindow;
        Map<String, String> settings = new HashMap<>();
        settings.put("INT_GLAM_savitzkyGolayWindow", "not a number");
        GlamMapSupport.runWithSettings(settings, () -> {
            assertEquals(original, RadiomicsJ.glamSavitzkyGolayWindow);
            return null;
        });
    }

    // ── 所要の見積り ────────────────────────────────────────────

    @Test
    void estimatesGrowSteeplyWithTheKernel() {
        long atSeven = GlamMapSupport.estimateMillis(10_000, 7);
        long atEleven = GlamMapSupport.estimateMillis(10_000, 11);
        long atFifteen = GlamMapSupport.estimateMillis(10_000, 15);
        assertTrue(atSeven > 0);
        // 窓内の全ボクセル対を歩くので、径が 1.5 倍で 10 倍前後になる
        assertTrue(atEleven > atSeven * 5, "11 vs 7: " + atEleven + " vs " + atSeven);
        assertTrue(atFifteen > atEleven * 4, "15 vs 11: " + atFifteen + " vs " + atEleven);
    }

    @Test
    void estimatesScaleWithTheNumberOfWindows() {
        assertEquals(2 * GlamMapSupport.estimateMillis(1_000, 7), GlamMapSupport.estimateMillis(2_000, 7));
    }
}

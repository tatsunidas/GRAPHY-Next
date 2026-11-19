/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import ij.ImagePlus;
import ij.ImageStack;
import ij.process.ByteProcessor;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 2D の位置は、**計算に使う格子**のスライスの位置で出す。欠損・不等間隔・チルトの体積は取り直した格子（枚数が元と違う）なので、
 * 元の IPP を引くと null や、ずれた位置になっていた（FINDINGS 27）。
 */
class RectifiedPositionsTest {

    private static ImagePlus mask(int n) {
        ImageStack st = new ImageStack(4, 4);
        for (int i = 0; i < n; i++) {
            st.addSlice(new ByteProcessor(4, 4));
        }
        ImagePlus m = new ImagePlus("m", st);
        m.setProp(RadiomicsMapEngine.PROP_GEOMETRY_ALIGNED, "1");
        return m;
    }

    private static RadiomicsMapEngine.LoadedVolume volume(double[] iop, int gridSlices, Map<Integer, double[]> ipps,
                                                          double[] normalPositions, boolean rectified) {
        ImagePlus m = mask(gridSlices);
        return new RadiomicsMapEngine.LoadedVolume(m, m, 4, 4, gridSlices, 1, true, null, iop, 0.7, 0.7, ipps,
                new String[ipps.size()], "1.2", null, false, ValueCalibration.UNSET, normalPositions, rectified);
    }

    @Test
    void aRectifiedGridUsesItsOwnPositions_notTheOriginalIpps() {
        // 元は 3 枚（z=0, 2, 6 の欠損つき）。取り直した格子は dz=2 の 4 枚（0, 2, 4, 6）
        Map<Integer, double[]> ipps = new HashMap<>();
        ipps.put(0, new double[] {0, 0, 0});
        ipps.put(1, new double[] {0, 0, 2});
        ipps.put(2, new double[] {0, 0, 6});
        RadiomicsMapEngine.LoadedVolume v = volume(new double[] {1, 0, 0, 0, 1, 0}, 4, ipps, new double[] {0, 2, 4, 6}, true);
        assertArrayEquals(new double[] {0, 2, 4, 6}, MaxSectionService.positionsMm(v), 1e-12);
        assertEquals(List.of(RoiFeatureService.FLAG_RECTIFIED_GRID), RoiFeatureService.loadFlagsOf(v).stream()
                .filter(f -> f.equals(RoiFeatureService.FLAG_RECTIFIED_GRID)).toList());
    }

    @Test
    void anOrdinaryVolumeIsNotFlagged() {
        Map<Integer, double[]> ipps = new HashMap<>();
        for (int z = 0; z < 3; z++) {
            ipps.put(z, new double[] {0, 0, 2.0 * z});
        }
        RadiomicsMapEngine.LoadedVolume v = volume(new double[] {1, 0, 0, 0, 1, 0}, 3, ipps, new double[] {0, 2, 4}, false);
        assertFalse(RoiFeatureService.loadFlagsOf(v).contains(RoiFeatureService.FLAG_RECTIFIED_GRID));
    }

    @Test
    void withoutTheGridPositionsItFallsBackToTheIppsOrRefusesWithAReason_neverANullPointer() {
        Map<Integer, double[]> ipps = new HashMap<>();
        ipps.put(0, new double[] {0, 0, 0});
        ipps.put(1, new double[] {0, 0, 2});
        // 位置の記録が無い従来の呼び出し元: 枚数が合えば IPP から
        RadiomicsMapEngine.LoadedVolume ok = volume(new double[] {1, 0, 0, 0, 1, 0}, 2, ipps, null, false);
        assertArrayEquals(new double[] {0, 2}, MaxSectionService.positionsMm(ok), 1e-12);
        // 枚数が合わない（取り直した体積に、元の IPP しかない）: 内部の例外ではなく、理由つきで断る
        RadiomicsMapEngine.LoadedVolume bad = volume(new double[] {1, 0, 0, 0, 1, 0}, 3, ipps, null, true);
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> MaxSectionService.positionsMm(bad));
        assertTrue(e.getMessage().contains("IPP"), e.getMessage());
    }

    @Test
    void positionsFollowTheFixedPatientAxisForSagittalAndFeetFirstSeries() {
        // 矢状断（法線 -x）: 格子の位置 t = IPP·法線 = -x。位置は x
        double[] sagIop = {0, 1, 0, 0, 0, -1};
        Map<Integer, double[]> ipps = new HashMap<>();
        for (int i = 0; i < 3; i++) {
            ipps.put(i, new double[] {-10.0 - 2 * i, 0, 0}); // x = -10, -12, -14（法線 -x の向きに t = 10, 12, 14）
        }
        RadiomicsMapEngine.LoadedVolume v = volume(sagIop, 3, ipps, new double[] {10, 12, 14}, false);
        assertArrayEquals(new double[] {-10, -12, -14}, MaxSectionService.positionsMm(v), 1e-12);
        // 足向きの軸位（法線 -z）: 位置は z
        double[] feet = {1, 0, 0, 0, -1, 0};
        Map<Integer, double[]> ippz = new HashMap<>();
        for (int i = 0; i < 3; i++) {
            ippz.put(i, new double[] {0, 0, 100.0 - 3 * i});
        }
        RadiomicsMapEngine.LoadedVolume vf = volume(feet, 3, ippz, new double[] {-100, -97, -94}, false);
        assertArrayEquals(new double[] {100, 97, 94}, MaxSectionService.positionsMm(vf), 1e-12);
    }

    @Test
    void theGeometryKeyChangesWithThePositionsAndTheOrientation() {
        Map<Integer, double[]> ipps = new HashMap<>();
        ipps.put(0, new double[] {0, 0, 0});
        ipps.put(1, new double[] {0, 0, 2});
        String a = RoiFeatureService.geometryKey(volume(new double[] {1, 0, 0, 0, 1, 0}, 2, ipps, new double[] {0, 2}, false));
        String b = RoiFeatureService.geometryKey(volume(new double[] {1, 0, 0, 0, 1, 0}, 2, ipps, new double[] {5, 7}, false));
        String c = RoiFeatureService.geometryKey(volume(new double[] {0, 1, 0, 0, 0, -1}, 2, ipps, new double[] {0, 2}, false));
        assertNotEquals(a, b, "画素が同じで位置だけ違えば、別の鍵（古い位置を返さない）");
        assertNotEquals(a, c, "向きが違えば別の鍵");
        assertEquals(a, RoiFeatureService.geometryKey(volume(new double[] {1, 0, 0, 0, 1, 0}, 2, ipps, new double[] {0, 2}, false)));
    }
}

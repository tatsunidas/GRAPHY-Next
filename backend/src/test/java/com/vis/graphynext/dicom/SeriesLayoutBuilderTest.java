package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.SeriesLayoutBuilder.FrameMeta;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/** ZCT 導出アルゴリズム（ファイル非依存）の検証。 */
class SeriesLayoutBuilderTest {

    private int instNo = 1;

    private FrameMeta f(double zpos, Map<String, Double> dims) {
        int n = instNo++;
        return new FrameMeta("SOP." + n, n, zpos, dims);
    }

    @Test
    void pureZ_singleVolume() {
        List<FrameMeta> frames = new ArrayList<>();
        for (int z = 0; z < 5; z++) {
            frames.add(f(z * 1.5, Map.of()));
        }
        SeriesLayout l = SeriesLayoutBuilder.build(frames);
        assertEquals(5, l.nZ());
        assertEquals(1, l.nC());
        assertEquals(1, l.nT());
        assertEquals(5, l.cells().size());
    }

    @Test
    void temporal4D() {
        List<FrameMeta> frames = new ArrayList<>();
        for (int z = 0; z < 3; z++) {
            for (int t = 0; t < 2; t++) {
                frames.add(f(z, Map.of("Temporal", (double) t)));
            }
        }
        SeriesLayout l = SeriesLayoutBuilder.build(frames);
        assertEquals(3, l.nZ());
        assertEquals(1, l.nC());
        assertEquals(2, l.nT());
        assertEquals("Temporal", l.tDimension());
        assertNull(l.cDimension());
    }

    @Test
    void echo4D() {
        List<FrameMeta> frames = new ArrayList<>();
        for (int z = 0; z < 4; z++) {
            for (int e = 1; e <= 2; e++) {
                frames.add(f(z, Map.of("Echo", (double) e)));
            }
        }
        SeriesLayout l = SeriesLayoutBuilder.build(frames);
        assertEquals(4, l.nZ());
        assertEquals(2, l.nC());
        assertEquals(1, l.nT());
        assertEquals("Echo", l.cDimension());
    }

    @Test
    void full5D_echoTimesTemporal() {
        List<FrameMeta> frames = new ArrayList<>();
        for (int z = 0; z < 2; z++) {
            for (int e = 1; e <= 2; e++) {
                for (int t = 0; t < 2; t++) {
                    frames.add(f(z, Map.of("Echo", (double) e, "Temporal", (double) t)));
                }
            }
        }
        SeriesLayout l = SeriesLayoutBuilder.build(frames);
        assertEquals(2, l.nZ());
        assertEquals(2, l.nC());
        assertEquals(2, l.nT());
        assertEquals(8, l.cells().size());
        // (c,z,t) は重複なく全て埋まる
        boolean[][][] seen = new boolean[2][2][2];
        for (SeriesLayout.Cell c : l.cells()) {
            seen[c.c()][c.z()][c.t()] = true;
        }
        for (boolean[][] a : seen) {
            for (boolean[] b : a) {
                for (boolean v : b) {
                    assertEquals(true, v);
                }
            }
        }
    }

    @Test
    void genericC_whenTagsUnknown() {
        // 各 Z に 3 枚あるが識別タグ無し → 総当たり C=3
        List<FrameMeta> frames = new ArrayList<>();
        for (int z = 0; z < 2; z++) {
            for (int k = 0; k < 3; k++) {
                frames.add(f(z, Map.of()));
            }
        }
        SeriesLayout l = SeriesLayoutBuilder.build(frames);
        assertEquals(2, l.nZ());
        assertEquals(3, l.nC());
        assertEquals(1, l.nT());
    }

    @Test
    void pureStack_whenGroupsUneven() {
        // Z=0 に 2 枚、Z=1 に 1 枚 → 不均一 → 純スタック(3 枚)
        List<FrameMeta> frames = new ArrayList<>();
        frames.add(f(0, Map.of()));
        frames.add(f(0, Map.of()));
        frames.add(f(1, Map.of()));
        SeriesLayout l = SeriesLayoutBuilder.build(frames);
        assertEquals(3, l.nZ());
        assertEquals(1, l.nC());
        assertEquals(1, l.nT());
    }
}

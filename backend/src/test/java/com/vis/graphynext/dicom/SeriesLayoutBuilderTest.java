/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
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
        // Z=0 に 2 枚、Z=1 に 1 枚 → 不均一かつ判別タグ無し → 純スタック(3 枚)
        List<FrameMeta> frames = new ArrayList<>();
        frames.add(f(0, Map.of()));
        frames.add(f(0, Map.of()));
        frames.add(f(1, Map.of()));
        SeriesLayout l = SeriesLayoutBuilder.build(frames);
        assertEquals(3, l.nZ());
        assertEquals(1, l.nC());
        assertEquals(1, l.nT());
    }

    @Test
    void acquisitionTime_uniform() {
        // CT 2 収集(AcqNo=1,2)が全 Z で重なる均一構成 → 繰り返し＝時間(T=2)。
        // AcquisitionNumber は DICOM 上「一定時間の連続データ収集」＝時間軸なので C ではなく T。
        List<FrameMeta> frames = new ArrayList<>();
        for (int z = 0; z < 4; z++) {
            for (int a = 1; a <= 2; a++) {
                frames.add(f(z, Map.of("Acq", (double) a)));
            }
        }
        SeriesLayout l = SeriesLayoutBuilder.build(frames);
        assertEquals(4, l.nZ());
        assertEquals(1, l.nC());
        assertEquals(2, l.nT());
        assertEquals("Acq", l.tDimension());
        assertNull(l.cDimension());
    }

    @Test
    void acquisitionTime_singlePosition() {
        // 全フレームが同一 Z(nZ=1)で AcquisitionNumber=タイムポイント → 時系列(T)。
        List<FrameMeta> frames = new ArrayList<>();
        for (int a = 1; a <= 5; a++) {
            frames.add(f(0.0, Map.of("Acq", (double) a)));
        }
        SeriesLayout l = SeriesLayoutBuilder.build(frames);
        assertEquals(1, l.nZ());
        assertEquals(1, l.nC());
        assertEquals(5, l.nT());
        assertEquals("Acq", l.tDimension());
        assertNull(l.cDimension());
    }

    @Test
    void acquisitionTime_nonUniformEnds() {
        // CT 2 収集が中央のみ重なり、端は片方のみ（非均一）→ 時間(T=2)。
        // 端の単独スライスも AcqNo で正しい時相に割り当てられる（pureStack に落ちない）。
        List<FrameMeta> frames = new ArrayList<>();
        frames.add(f(0, Map.of("Acq", 1.0)));            // z0: Acq1 のみ
        frames.add(f(1, Map.of("Acq", 1.0)));            // z1: Acq1+Acq2
        frames.add(f(1, Map.of("Acq", 2.0)));
        frames.add(f(2, Map.of("Acq", 1.0)));            // z2: Acq1+Acq2
        frames.add(f(2, Map.of("Acq", 2.0)));
        frames.add(f(3, Map.of("Acq", 2.0)));            // z3: Acq2 のみ
        SeriesLayout l = SeriesLayoutBuilder.build(frames);
        assertEquals(4, l.nZ());
        assertEquals(1, l.nC());
        assertEquals(2, l.nT());
        assertEquals("Acq", l.tDimension());
        assertNull(l.cDimension());
        assertEquals(6, l.cells().size());
        // Acq2 のみの z3 は時相1(t=1)に入り、時相0(Acq1)の z3 は空（gap）。
        boolean t1HasZ3 = l.cells().stream().anyMatch(c -> c.t() == 1 && c.z() == 3);
        boolean t0HasZ3 = l.cells().stream().anyMatch(c -> c.t() == 0 && c.z() == 3);
        assertEquals(true, t1HasZ3);
        assertEquals(false, t0HasZ3);
    }

    @Test
    void complexComponentChannels() {
        // 同一位置・同一時相で magnitude/phase の2成分 → チャンネル(C=2, Complex)。
        List<FrameMeta> frames = new ArrayList<>();
        for (int z = 0; z < 3; z++) {
            frames.add(f(z, Map.of("Complex", 0.0))); // MAGNITUDE
            frames.add(f(z, Map.of("Complex", 1.0))); // PHASE
        }
        SeriesLayout l = SeriesLayoutBuilder.build(frames);
        assertEquals(3, l.nZ());
        assertEquals(2, l.nC());
        assertEquals(1, l.nT());
        assertEquals("Complex", l.cDimension());
        assertNull(l.tDimension());
    }
}

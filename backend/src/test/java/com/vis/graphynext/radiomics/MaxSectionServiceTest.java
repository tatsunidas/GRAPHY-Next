/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.cache.CacheStore;
import com.vis.graphynext.dicom.SeriesLayout;
import com.vis.graphynext.dicom.store.DicomStorageService;
import ij.ImagePlus;
import ij.ImageStack;
import ij.measure.Calibration;
import ij.process.ByteProcessor;
import ij.process.ShortProcessor;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class MaxSectionServiceTest {

    private static final int W = 32;
    private static final int H = 32;
    private static final double SP = 0.7;
    /** 前景の縦×横（画素）。15×15 が最大。 */
    private static final int[][] FG = {{10, 10}, {20, 10}, {15, 15}, {12, 12}};

    private static ImagePlus mask(int[][] fg, String aligned) {
        ImageStack st = new ImageStack(W, H);
        for (int[] f : fg) {
            ByteProcessor ip = new ByteProcessor(W, H);
            for (int y = 0; y < f[0]; y++) for (int x = 0; x < f[1]; x++) ip.set(x, y, 1);
            st.addSlice(ip);
        }
        ImagePlus m = new ImagePlus("m", st);
        m.setProp(RadiomicsMapEngine.PROP_GEOMETRY_ALIGNED, aligned);
        return m;
    }

    /** z 昇順の配列 index = 保存順。IPP の z 座標（mm）を pos で与える。 */
    private static RadiomicsMapEngine.LoadedVolume volume(int[][] fg, double[] pos, String aligned) {
        int n = fg.length;
        ImageStack is = new ImageStack(W, H);
        for (int z = 0; z < n; z++) is.addSlice(new ShortProcessor(W, H));
        ImagePlus img = new ImagePlus("i", is);
        Calibration c = new Calibration();
        c.pixelWidth = SP;
        c.pixelHeight = SP;
        img.setCalibration(c);
        Map<Integer, double[]> ipp = new HashMap<>();
        String[] sops = new String[n];
        for (int z = 0; z < n; z++) {
            ipp.put(z, new double[] {0, 0, pos[z]});
            sops[z] = "1.2.3." + z;
        }
        return new RadiomicsMapEngine.LoadedVolume(img, mask(fg, aligned), W, H, n, 1, true, c,
                new double[] {1, 0, 0, 0, 1, 0}, SP, SP, ipp, sops, null, null, false);
    }

    private static final class FixedEngine extends RadiomicsMapEngine {
        final LoadedVolume vol;

        FixedEngine(LoadedVolume vol) {
            super(null, new MapCheckpointStore(new CacheStore(Path.of("unused"), 0), null), null);
            this.vol = vol;
        }

        @Override
        public LoadedVolume load(String study, String series, int channel, int timePoint, String maskSeries,
                                 int maskChannel, int label, Map<String, String> settings) {
            return vol;
        }
    }

    private static MaxSectionService service(RadiomicsMapEngine.LoadedVolume vol, int n) {
        SeriesLayout layout = mock(SeriesLayout.class);
        List<SeriesLayout.Cell> cells = new java.util.ArrayList<>();
        // レイアウトのセルは z 昇順。frame は非モザイク（-1）
        for (int z = 0; z < n; z++) cells.add(new SeriesLayout.Cell(0, z, 0, "1.2.3." + z));
        when(layout.cells()).thenReturn(cells);
        when(layout.nC()).thenReturn(1);
        when(layout.nT()).thenReturn(1);
        DicomStorageService storage = mock(DicomStorageService.class);
        when(storage.seriesLayout("st", "se")).thenReturn(layout);
        return new MaxSectionService(new FixedEngine(vol), storage, standalone());
    }

    private static RadiomicsMode standalone() {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("standalone");
        return new RadiomicsMode(env);
    }

    @Test
    void webModeIsRefused() {
        MaxSectionService s = new MaxSectionService(null, null, new RadiomicsMode(new MockEnvironment()));
        assertThrows(IllegalStateException.class, () -> s.find(req()));
    }

    private static MaxSectionService.Request req() {
        return new MaxSectionService.Request("st", "se", "mk", 0, 0, 0, 1);
    }

    @Test
    void picksLargestSliceWithAreaAndPositionFromIpp() throws Exception {
        double[] pos = {0, 2, 4, 6};
        MaxSectionService.Result r = service(volume(FG, pos, "1"), 4).find(req());
        assertEquals("1.2.3.2", r.best().sopInstanceUid());
        assertEquals(225, r.best().pixels());
        assertEquals(110.25, r.best().areaMm2(), 1e-9);
        assertEquals(4.0, r.best().positionMm(), 0.001);
        assertEquals(4, r.totalSlices());
        assertEquals(1, r.ties().size());
    }

    @Test
    void sameSliceWhenStoredInDescendingIppOrder() throws Exception {
        // 同じ前景を IPP の降順で保存: 保存順（z）は逆でも、選ばれる位置は同じ（スライス番号に頼らない）
        int[][] rev = {FG[3], FG[2], FG[1], FG[0]};
        double[] pos = {6, 4, 2, 0};
        MaxSectionService.Result r = service(volume(rev, pos, "1"), 4).find(req());
        assertEquals(4.0, r.best().positionMm(), 0.001);
        assertEquals(225, r.best().pixels());
        assertEquals("1.2.3.1", r.best().sopInstanceUid());
    }

    @Test
    void tieGoesToSliceNearerTheRoiCentroidAndBothAreListed() {
        // 同面積（225 画素）が位置 2 と 8 の 2 枚: ROI 重心に近い方を選び、両方を並べる
        long[] px = {50, 225, 100, 120, 225};
        double[] pos = {0, 2, 4, 6, 8};
        String[] sops = {"a", "b", "c", "d", "e"};
        int[] fr = {-1, -1, -1, -1, -1};
        MaxSectionService.Result r = MaxSectionService.analyze(sops, fr, pos, px, SP * SP);
        assertEquals(2, r.ties().size());
        // 重心 = (0*50+2*225+4*100+6*120+8*225)/720 = 4.5 → 同面積の b(2) が e(8) より近い
        assertEquals(2.0, r.ties().get(0).positionMm(), 1e-9);
        assertEquals(8.0, r.ties().get(1).positionMm(), 1e-9);
        assertEquals("b", r.best().sopInstanceUid());
    }

    @Test
    void refusesWhenGeometryFellBackToSliceOrder() {
        MaxSectionService s = service(volume(FG, new double[] {0, 2, 4, 6}, "0"), 4);
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> s.find(req()));
        assertEquals(true, e.getMessage().contains("位置が分からない"));
    }

    @Test
    void emptyRoiIsRejected() {
        assertThrows(IllegalArgumentException.class, () -> MaxSectionService.analyze(
                new String[] {"a"}, new int[] {-1}, new double[] {0}, new long[] {0}, 1.0));
    }
}

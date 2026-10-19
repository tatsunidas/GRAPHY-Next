/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.cache.CacheStore;
import io.github.tatsunidas.radiomics.features.GLAMFeatureType;
import ij.ImagePlus;
import ij.ImageStack;
import ij.measure.Calibration;
import ij.process.ByteProcessor;
import ij.process.FloatProcessor;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 非等方の画像で GLAM マップを 1 回作ったとき、非等方の警告が窓ごとに出ないこと。
 * RadiomicsJ 2.4.0 は窓の数だけ（このファントムで 576 行）出していた。2.4.1 からは呼び出しごとに 1 回で、
 * Next はスライスごとに呼ぶのでスライスの数が上限になる。
 */
class GlamAnisotropyWarningTest {

    private static final int W = 20, H = 20, D = 6;
    private static final String WARNING = "GLAM: the voxels are not isotropic";

    @Test
    void warnsAtMostOncePerSlice(@TempDir Path dir) {
        ImageStack st = new ImageStack(W, H);
        ImageStack ms = new ImageStack(W, H);
        long s = 12345L;
        for (int z = 0; z < D; z++) {
            FloatProcessor ip = new FloatProcessor(W, H);
            ByteProcessor mp = new ByteProcessor(W, H);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
                s = s * 6364136223846793005L + 1442695040888963407L;
                ip.setf(x, y, (int) Math.floorMod(s >> 33, 12) * 100f + z);
                mp.set(x, y, (x >= 4 && x < W - 4 && y >= 5 && y < H - 3 && z >= 1 && z < D - 1) ? 1 : 0);
            }
            st.addSlice(ip);
            ms.addSlice(mp);
        }
        ImagePlus img = new ImagePlus("p", st);
        Calibration c = img.getCalibration();
        c.pixelWidth = 0.7; c.pixelHeight = 0.7; c.pixelDepth = 2.0; c.setUnit("mm");
        String[] sops = new String[D];
        for (int z = 0; z < D; z++) sops[z] = "1.2.3." + z;
        RadiomicsMapEngine.LoadedVolume vol = new RadiomicsMapEngine.LoadedVolume(img, new ImagePlus("m", ms),
                W, H, D, 1, true, c, null, 0.7, 0.7, new HashMap<>(), sops, null, null, false);
        Map<String, String> settings = new HashMap<>();
        settings.put("MASK_LABEL_INT", "1");
        TextureSeriesRequest req = new TextureSeriesRequest("1.2", "1.2.9", "1.2.8", 0,
                "GLAM_" + GLAMFeatureType.values()[0].name(), 5, 1, false, 0, 0, settings, 0, null, null);
        RadiomicsMapEngine eng = new RadiomicsMapEngine(null, new MapCheckpointStore(new CacheStore(dir, 0), null), null);

        PrintStream orig = System.out;
        ByteArrayOutputStream cap = new ByteArrayOutputStream();
        System.setOut(new PrintStream(cap, true));
        try {
            eng.computeFrom(req, TextureProgress.NONE, vol);
        } finally {
            System.setOut(orig);
        }
        long warnings = cap.toString().lines().filter(l -> l.contains(WARNING)).count();
        assertTrue(warnings >= 1, "非等方なので警告は出る（検査が効いていることの確認）");
        assertTrue(warnings <= D, "警告はスライスの数まで: " + warnings + " 行");
    }
}

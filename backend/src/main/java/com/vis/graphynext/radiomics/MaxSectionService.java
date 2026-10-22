/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.dicom.SeriesLayout;
import com.vis.graphynext.dicom.store.DicomStorageService;
import ij.process.ImageProcessor;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * ROI（SEG）の前景が最大のスライス（最大断面）を求める。
 *
 * <p>比べるのは特徴量の計算に使うのと同じマスク（{@link RadiomicsMapEngine#load} が IOP/IPP で整列したもの）。
 * 基準はマスクの画素数（1 シリーズ内では画素の面積が同じなので面積の最大と同じ）。
 * 位置は患者座標（LPS）の mm で、スライスの法線方向 n·IPP。スライス番号には頼らない。
 */
@Service
public class MaxSectionService {

    private final RadiomicsMapEngine engine;
    private final DicomStorageService storage;
    private final RadiomicsMode mode;

    public MaxSectionService(RadiomicsMapEngine engine, DicomStorageService storage, RadiomicsMode mode) {
        this.engine = engine;
        this.storage = storage;
        this.mode = mode;
    }

    public record Request(String studyInstanceUid, String sourceSeriesUid, String maskSeriesUid,
                          int maskChannel, int channel, int timePoint, int label) {}

    /** 1 枚のスライス。frame は非モザイクなら -1。 */
    public record Slice(String sopInstanceUid, int frame, double positionMm, long pixels, double areaMm2) {}

    /**
     * @param best        最大断面（同面積が複数あるときは ROI 重心の法線位置に近い方、なお同じなら位置の小さい方）
     * @param ties        最大と同面積のスライスすべて（best を含む。1 件なら単独）
     * @param totalSlices ターゲットのスライス数
     */
    public record Result(Slice best, List<Slice> ties, int totalSlices, double pixelAreaMm2) {}

    public Result find(Request req) throws IOException {
        mode.require("最大断面");
        if (req.studyInstanceUid() == null || req.studyInstanceUid().isBlank()
                || req.sourceSeriesUid() == null || req.sourceSeriesUid().isBlank()) {
            throw new IllegalArgumentException("studyInstanceUid / sourceSeriesUid は必須です");
        }
        if (req.maskSeriesUid() == null || req.maskSeriesUid().isBlank()) {
            throw new IllegalArgumentException("最大断面には ROI マスクシリーズが必要です。");
        }
        int label = req.label() < 1 ? 1 : req.label();
        // Next のテクスチャ設定は渡さない（リサンプリングを掛けず、元の格子で比べる）
        RadiomicsMapEngine.LoadedVolume vol = engine.load(req.studyInstanceUid(), req.sourceSeriesUid(),
                req.channel(), req.timePoint(), req.maskSeriesUid(), req.maskChannel(), label, new HashMap<>());

        if (!"1".equals(vol.mask().getProp(RadiomicsMapEngine.PROP_GEOMETRY_ALIGNED))) {
            throw new IllegalArgumentException("位置が分からないため最大断面を示せません"
                    + "（ターゲットとマスクの向き・位置が揃わず、スライス順の対応にしか落とせません）。");
        }
        double[] normal = RadiomicsMapEngine.normalOf(vol.imageOrientationPatient());
        int nZ = vol.slices();
        long[] pixels = new long[nZ];
        double[] pos = new double[nZ];
        for (int z = 0; z < nZ; z++) {
            double[] ipp = vol.ippByZ().get(z);
            pos[z] = ipp[0] * normal[0] + ipp[1] * normal[1] + ipp[2] * normal[2];
            pixels[z] = countSlice(vol.mask().getStack().getProcessor(z + 1), label);
        }
        double pixelArea = vol.pixelSpacingRow() * vol.pixelSpacingCol();
        if (!(pixelArea > 0)) {
            throw new IllegalArgumentException("PixelSpacing が不明なため面積を求められません。");
        }

        // SOP とフレーム: LoadedVolume は SOP しか持たないので、レイアウトから同じ (C,T) の z 昇順で引く
        SeriesLayout layout = storage.seriesLayout(req.studyInstanceUid(), req.sourceSeriesUid());
        List<SeriesLayout.Cell> sel = new ArrayList<>();
        int ch = Math.max(0, Math.min(req.channel(), layout.nC() - 1));
        int tp = Math.max(0, Math.min(req.timePoint(), layout.nT() - 1));
        for (SeriesLayout.Cell c : layout.cells()) {
            if (c.c() == ch && c.t() == tp) sel.add(c);
        }
        sel.sort(Comparator.comparingInt(SeriesLayout.Cell::z));
        int[] frames = new int[nZ];
        for (int z = 0; z < nZ; z++) {
            frames[z] = z < sel.size() ? sel.get(z).frame() : -1;
        }
        return analyze(vol.sopPerZ(), frames, pos, pixels, pixelArea);
    }

    /** 画素数・位置から最大断面を決める（I/O なし。単体テスト用に分離）。 */
    static Result analyze(String[] sops, int[] frames, double[] pos, long[] pixels, double pixelArea) {
        int n = pixels.length;
        long max = 0;
        double sumPos = 0;
        double sumW = 0;
        for (int z = 0; z < n; z++) {
            max = Math.max(max, pixels[z]);
            sumPos += pos[z] * pixels[z];
            sumW += pixels[z];
        }
        if (max == 0) {
            throw new IllegalArgumentException("ROI が空です。マスクシリーズ・セグメント・ラベル値を確認してください。");
        }
        double centroid = sumPos / sumW;
        List<Slice> ties = new ArrayList<>();
        for (int z = 0; z < n; z++) {
            if (pixels[z] == max) {
                ties.add(new Slice(sops[z], frames[z], pos[z], pixels[z], pixels[z] * pixelArea));
            }
        }
        ties.sort(Comparator.comparingDouble(Slice::positionMm));
        Slice best = ties.stream()
                .min(Comparator.comparingDouble((Slice s) -> Math.abs(s.positionMm() - centroid))
                        .thenComparingDouble(Slice::positionMm))
                .orElseThrow();
        return new Result(best, ties, n, pixelArea);
    }

    private static long countSlice(ImageProcessor mp, int label) {
        long count = 0;
        for (int y = 0; y < mp.getHeight(); y++) {
            for (int x = 0; x < mp.getWidth(); x++) {
                if ((int) mp.getf(x, y) == label) count++;
            }
        }
        return count;
    }
}

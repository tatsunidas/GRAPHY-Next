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

        double[] pos = positionsMm(vol);
        int nZ = vol.slices();
        long[] pixels = new long[nZ];
        for (int z = 0; z < nZ; z++) {
            pixels[z] = countSlice(vol.mask().getStack().getProcessor(z + 1), label);
        }
        double pixelArea = pixelAreaOf(vol);

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

    /**
     * スライスごとの法線方向の位置（mm、LPS）。**計算に使う格子のスライス**の位置で、取り直した体積（欠損・不等間隔・チルト）は
     * 取り直した格子の位置（元の IPP は枚数が違うので使えない）。向きは、法線をその患者軸の正の向きに揃える（{@link ImagePlane}）。
     * マスクの位置が分からないときは例外（スライス順に落とさない）。
     */
    static double[] positionsMm(RadiomicsMapEngine.LoadedVolume vol) {
        if (!"1".equals(vol.mask().getProp(RadiomicsMapEngine.PROP_GEOMETRY_ALIGNED))) {
            throw new IllegalArgumentException("位置が分からないため最大断面を示せません"
                    + "（ターゲットとマスクの向き・位置が揃わず、スライス順の対応にしか落とせません）。");
        }
        ImagePlane plane = ImagePlane.of(vol.imageOrientationPatient());
        if (plane == null) {
            throw new IllegalArgumentException("ImageOrientationPatient が不正なため、スライスの位置を求められません。");
        }
        double[] pos = new double[vol.slices()];
        double[] t = vol.normalPositionsMm();
        if (t != null && t.length == pos.length) {
            for (int z = 0; z < pos.length; z++) {
                pos[z] = plane.fromNormalPosition(t[z]);
            }
            return pos;
        }
        // 格子の位置が無い（従来の呼び出し元）: 元のスライスの IPP から。枚数が違えば、位置を作らず断る（ずれた位置を出さない）
        for (int z = 0; z < pos.length; z++) {
            double[] ipp = vol.ippByZ() == null ? null : vol.ippByZ().get(z);
            if (ipp == null) {
                throw new IllegalArgumentException("スライス " + z + " の位置（IPP）が分からないため、2D の位置を求められません。");
            }
            pos[z] = plane.positionMm(ipp);
        }
        return pos;
    }

    static double pixelAreaOf(RadiomicsMapEngine.LoadedVolume vol) {
        double a = vol.pixelSpacingRow() * vol.pixelSpacingCol();
        if (!(a > 0)) {
            throw new IllegalArgumentException("PixelSpacing が不明なため面積を求められません。");
        }
        return a;
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
                ties.add(new Slice(sops != null && z < sops.length ? sops[z] : null, frames != null && z < frames.length ? frames[z] : -1,
                        pos[z], pixels[z], pixels[z] * pixelArea));
            }
        }
        ties.sort(Comparator.comparingDouble(Slice::positionMm));
        Slice best = ties.stream()
                .min(Comparator.comparingDouble((Slice s) -> Math.abs(s.positionMm() - centroid))
                        .thenComparingDouble(Slice::positionMm))
                .orElseThrow();
        return new Result(best, ties, n, pixelArea);
    }

    static long countSlice(ImageProcessor mp, int label) {
        long count = 0;
        for (int y = 0; y < mp.getHeight(); y++) {
            for (int x = 0; x < mp.getWidth(); x++) {
                if ((int) mp.getf(x, y) == label) count++;
            }
        }
        return count;
    }
}

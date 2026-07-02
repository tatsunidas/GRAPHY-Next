/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.texture;

import com.vis.graphynext.dicom.SeriesLayout;
import com.vis.graphynext.dicom.store.DicomStorageService;
import ij.ImagePlus;
import ij.ImageStack;
import ij.io.Opener;
import ij.measure.Calibration;
import ij.process.ByteProcessor;
import ij.process.FloatProcessor;
import ij.process.ImageProcessor;
import io.github.tatsunidas.radiomics.main.FeatureVisualizationMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * RadiomicsJ による Texture 可視化マップ計算エンジン。
 *
 * <p>ターゲットシリーズ（＋任意マスク）を {@code ij.ImagePlus} ボリュームに積み、
 * {@link FeatureVisualizationMap} で voxel-wise 特徴マップを計算する。stride は x,y,z 共通で、
 * XY は RadiomicsJ が間引き、Z はここで間引いたのち、低解像度マップを <b>Trilinear 補間</b>で
 * source 次元へ拡大して幾何を共有する（設計 §8-2）。GUI（{@code show()}）は使わずヘッドレス動作。
 */
@Service
public class RadiomicsMapEngine {

    private static final Logger log = LoggerFactory.getLogger(RadiomicsMapEngine.class);

    private final DicomStorageService storage;

    public RadiomicsMapEngine(DicomStorageService storage) {
        this.storage = storage;
    }

    /** マップ計算結果（source 次元の float ボリューム＋幾何）。 */
    public record MapResult(
            int width, int height, int slices,
            float[][] data,                 // [z][width*height] row-major float（32bit 原値）
            String featureName,             // "GLCM_JointEntropy" 等（SeriesDescription/RescaleType 用）
            double[] imageOrientationPatient,
            double pixelSpacingRow, double pixelSpacingCol,
            List<double[]> ippPerZ,         // z ごとの ImagePositionPatient（無ければ null 要素）
            List<String> srcSopPerZ,        // z ごとの元 SOPInstanceUID（SourceImageSequence 用）
            String frameOfReferenceUid) {
    }

    /** ターゲット（＋任意マスク）から 1 特徴のマップを計算する。 */
    public MapResult compute(TextureSeriesRequest req) throws IOException {
        SeriesLayout layout = storage.seriesLayout(req.studyInstanceUid(), req.sourceSeriesUid());
        if (layout == null || layout.cells().isEmpty()) {
            throw new IllegalArgumentException("ターゲットシリーズにフレームがありません: " + req.sourceSeriesUid());
        }
        int nZ = Math.max(1, layout.nZ());
        int ch = clampDim(req.channel(), layout.nC());
        int tp = clampDim(req.timePoint(), layout.nT());

        // z ごとの代表セル（指定 C/T）・SOP・IPP を収集。
        String[] sopPerZ = new String[nZ];
        int[] framePerZ = new int[nZ];
        for (int i = 0; i < nZ; i++) framePerZ[i] = -1;
        for (SeriesLayout.Cell cell : layout.cells()) {
            if (cell.c() == ch && cell.t() == tp && cell.z() >= 0 && cell.z() < nZ && sopPerZ[cell.z()] == null) {
                sopPerZ[cell.z()] = cell.sopInstanceUid();
                framePerZ[cell.z()] = cell.frame();
            }
        }
        Map<Integer, double[]> ippByZ = new HashMap<>();
        if (layout.zSpatial() != null) {
            for (SeriesLayout.ZSpatial zs : layout.zSpatial()) {
                if (zs.imagePositionPatient() != null) ippByZ.put(zs.z(), zs.imagePositionPatient());
            }
        }

        // ターゲットボリュームを積む（Opener で DICOM→ImageProcessor、校正=HU/SUV 直線を引き継ぐ）。
        int w = 0, h = 0;
        Calibration cal = null;
        List<ImageProcessor> procs = new ArrayList<>(nZ);
        for (int z = 0; z < nZ; z++) {
            Loaded loaded = openBySop(sopPerZ[z], framePerZ[z]);
            if (loaded == null) throw new IllegalArgumentException("スライスを読み込めません z=" + z);
            procs.add(loaded.ip());
            if (cal == null && loaded.cal() != null && loaded.cal().calibrated()) cal = loaded.cal();
            w = loaded.ip().getWidth();
            h = loaded.ip().getHeight();
        }
        if (w <= 0 || h <= 0) throw new IllegalStateException("画像サイズを取得できません");
        ImageStack imgStack = new ImageStack(w, h);
        for (ImageProcessor ip : procs) imgStack.addSlice(ip);
        ImagePlus img = new ImagePlus("texture-src", imgStack);
        Calibration finalCal = (cal != null) ? cal.copy() : img.getCalibration();
        if (layout.pixelSpacingCol() > 0 && layout.pixelSpacingRow() > 0) {
            finalCal.pixelWidth = layout.pixelSpacingCol();
            finalCal.pixelHeight = layout.pixelSpacingRow();
            finalCal.setUnit("mm");
        }
        img.setCalibration(finalCal);

        // マスク（任意）。無ければ全面マスク（LABEL で塗り）。ある場合は IOP/IPP で Z 整列。
        int label = parseLabel(req);
        ImagePlus mask = buildMask(req, w, h, nZ, label, layout.imageOrientationPatient(), ippByZ);

        // calculator（族→ラムダ）。
        TextureFeatureCatalog.BuiltFeature built = TextureFeatureCatalog.build(req.feature(), req.settings());

        int filterSize = req.filterSize() > 0 ? oddUp(req.filterSize()) : 7;
        int stride = Math.max(1, req.stride());
        boolean d2 = req.force2D();

        long t0 = System.currentTimeMillis();
        float[][] full = (stride <= 1)
                ? computeFullRes(img, mask, built, filterSize, d2)
                : computeStrided(img, mask, built, filterSize, d2, stride, w, h, nZ);
        log.info("[texture] map '{}' {}x{}x{} stride={} filter={} in {} ms",
                built.displayName(), w, h, nZ, stride, filterSize, System.currentTimeMillis() - t0);

        List<double[]> ippList = new ArrayList<>(nZ);
        List<String> sopList = new ArrayList<>(nZ);
        for (int z = 0; z < nZ; z++) {
            ippList.add(ippByZ.get(z));
            sopList.add(sopPerZ[z]);
        }
        return new MapResult(w, h, nZ, full,
                built.displayName(),
                layout.imageOrientationPatient(),
                layout.pixelSpacingRow(), layout.pixelSpacingCol(),
                ippList, sopList, layout.frameOfReferenceUID());
    }

    /** stride<=1: RadiomicsJ に全スライスを一括計算させる（等倍・補間なし）。 */
    private float[][] computeFullRes(ImagePlus img, ImagePlus mask, TextureFeatureCatalog.BuiltFeature built,
                                     int filterSize, boolean d2) {
        ImagePlus lo = FeatureVisualizationMap.generateFeatureMap(img, mask, -1, built.calculator(), filterSize, d2, 1);
        int s = lo.getNSlices();
        float[][] out = new float[s][];
        ImageStack st = lo.getStack();
        for (int z = 0; z < s; z++) {
            out[z] = (float[]) st.getProcessor(z + 1).convertToFloatProcessor().getPixels();
        }
        return out;
    }

    /**
     * stride&gt;1: XY は RadiomicsJ が間引き、Z はここで間引いて低解像度 3D マップを作り、
     * Trilinear 補間で source 次元（w×h×s）へ拡大する。
     */
    private float[][] computeStrided(ImagePlus img, ImagePlus mask, TextureFeatureCatalog.BuiltFeature built,
                                     int filterSize, boolean d2, int stride, int w, int h, int s) {
        int outW = (int) Math.ceil((double) w / stride);
        int outH = (int) Math.ceil((double) h / stride);
        // 選択 z: 0, stride, 2*stride, ...
        List<Integer> zsel = new ArrayList<>();
        for (int z = 0; z < s; z += stride) zsel.add(z);
        int depth = zsel.size();
        float[][] low = new float[depth][];
        for (int k = 0; k < depth; k++) {
            int z = zsel.get(k);
            ImagePlus one = FeatureVisualizationMap.generateFeatureMap(
                    img, mask, z + 1, built.calculator(), filterSize, d2, stride);
            low[k] = (float[]) one.getStack().getProcessor(1).convertToFloatProcessor().getPixels();
        }
        // Trilinear 拡大: source (sx,sy,sz) → 低解像度座標 (sx/stride, sy/stride, sz/stride)。
        float[][] full = new float[s][w * h];
        for (int sz = 0; sz < s; sz++) {
            double fz = (double) sz / stride;
            float[] dst = full[sz];
            for (int sy = 0; sy < h; sy++) {
                double fy = (double) sy / stride;
                for (int sx = 0; sx < w; sx++) {
                    double fx = (double) sx / stride;
                    dst[sy * w + sx] = trilinear(low, outW, outH, depth, fx, fy, fz);
                }
            }
        }
        return full;
    }

    /** 低解像度グリッド low[depth][outW*outH] を Trilinear 補間サンプルする。 */
    private static float trilinear(float[][] low, int outW, int outH, int depth,
                                   double fx, double fy, double fz) {
        int x0 = clamp((int) Math.floor(fx), 0, outW - 1);
        int y0 = clamp((int) Math.floor(fy), 0, outH - 1);
        int z0 = clamp((int) Math.floor(fz), 0, depth - 1);
        int x1 = Math.min(x0 + 1, outW - 1);
        int y1 = Math.min(y0 + 1, outH - 1);
        int z1 = Math.min(z0 + 1, depth - 1);
        double dx = clamp01(fx - x0), dy = clamp01(fy - y0), dz = clamp01(fz - z0);
        float c000 = low[z0][y0 * outW + x0], c100 = low[z0][y0 * outW + x1];
        float c010 = low[z0][y1 * outW + x0], c110 = low[z0][y1 * outW + x1];
        float c001 = low[z1][y0 * outW + x0], c101 = low[z1][y0 * outW + x1];
        float c011 = low[z1][y1 * outW + x0], c111 = low[z1][y1 * outW + x1];
        double c00 = c000 * (1 - dx) + c100 * dx;
        double c10 = c010 * (1 - dx) + c110 * dx;
        double c01 = c001 * (1 - dx) + c101 * dx;
        double c11 = c011 * (1 - dx) + c111 * dx;
        double c0 = c00 * (1 - dy) + c10 * dy;
        double c1 = c01 * (1 - dy) + c11 * dy;
        return (float) (c0 * (1 - dz) + c1 * dz);
    }

    /**
     * マスク ImagePlus を作る。マスクシリーズがあれば <b>IOP/IPP ベースで Z 整列</b>して積む
     * （Fusion と同方針: 各ターゲットスライスに対し、法線投影距離が最も近いマスクスライスを採用）。
     * マスク画素は <b>値 ≥ 0.5 を LABEL</b> として二値化する。IOP/IPP 不明・OutOfRange の場合は
     * <b>スライスオーダー（index）</b>にフォールバックする。分岐は必ずログ出力する。マスク未指定は全面。
     */
    private ImagePlus buildMask(TextureSeriesRequest req, int w, int h, int nZ, int label,
                               double[] targetIop, Map<Integer, double[]> targetIppByZ) throws IOException {
        if (req.maskSeriesUid() == null || req.maskSeriesUid().isBlank()) {
            log.info("[texture] mask: none specified -> full-face mask (label={})", label);
            return fullFaceMask(w, h, nZ, label);
        }
        SeriesLayout ml = storage.seriesLayout(req.studyInstanceUid(), req.maskSeriesUid());
        if (ml == null || ml.cells().isEmpty()) {
            log.warn("[texture] mask: series '{}' empty -> full-face mask", req.maskSeriesUid());
            return fullFaceMask(w, h, nZ, label);
        }
        int mZ = Math.max(1, ml.nZ());

        // マスクの z ごと SOP/frame/IPP。
        String[] sop = new String[mZ];
        int[] frame = new int[mZ];
        for (int i = 0; i < mZ; i++) frame[i] = -1;
        for (SeriesLayout.Cell cell : ml.cells()) {
            if (cell.c() == 0 && cell.t() == 0 && cell.z() >= 0 && cell.z() < mZ && sop[cell.z()] == null) {
                sop[cell.z()] = cell.sopInstanceUid();
                frame[cell.z()] = cell.frame();
            }
        }
        double[][] maskIpp = new double[mZ][];
        if (ml.zSpatial() != null) {
            for (SeriesLayout.ZSpatial zs : ml.zSpatial()) {
                if (zs.z() >= 0 && zs.z() < mZ) maskIpp[zs.z()] = zs.imagePositionPatient();
            }
        }

        // マスクスライスを事前ロード（ByteProcessor 化, ≥0.5→label で二値化）。
        ByteProcessor[] maskSlices = new ByteProcessor[mZ];
        for (int z = 0; z < mZ; z++) {
            Loaded l = openBySop(sop[z], frame[z]);
            maskSlices[z] = (l != null) ? binarize(l.ip(), w, h, label) : null;
        }

        // 幾何整列の可否: ターゲット法線＋両者 IPP が揃うか。
        double[] normal = normalOf(targetIop);
        boolean geomOk = normal != null && hasAllIpp(targetIppByZ, nZ) && anyIpp(maskIpp);
        int[] mapZ = new int[nZ]; // ターゲット z → 採用するマスク z（-1=空）
        if (geomOk) {
            // マスク各 z の法線投影位置。
            double[] mProj = new double[mZ];
            boolean[] mHas = new boolean[mZ];
            for (int z = 0; z < mZ; z++) {
                if (maskIpp[z] != null && maskIpp[z].length == 3) { mProj[z] = dot(maskIpp[z], normal); mHas[z] = true; }
            }
            double tol = targetSliceSpacing(targetIppByZ, normal, nZ);
            int outOfRange = 0;
            for (int z = 0; z < nZ; z++) {
                double tPos = dot(targetIppByZ.get(z), normal);
                int best = -1;
                double bestD = Double.MAX_VALUE;
                for (int mz = 0; mz < mZ; mz++) {
                    if (!mHas[mz] || maskSlices[mz] == null) continue;
                    double d = Math.abs(tPos - mProj[mz]);
                    if (d < bestD) { bestD = d; best = mz; }
                }
                if (best >= 0 && bestD <= tol) {
                    mapZ[z] = best;
                } else {
                    // OutOfRange → スライスオーダー（index）にフォールバック。
                    mapZ[z] = (z < mZ && maskSlices[z] != null) ? z : -1;
                    outOfRange++;
                }
            }
            log.info("[texture] mask: IOP/IPP-aligned (srcZ={}, maskZ={}, tol={}mm, outOfRange={} -> slice-order)",
                    nZ, mZ, String.format("%.3f", tol), outOfRange);
        } else {
            for (int z = 0; z < nZ; z++) mapZ[z] = (z < mZ && maskSlices[z] != null) ? z : -1;
            log.info("[texture] mask: geometry unknown (targetIOP={}, targetIPP={}, maskIPP={}) -> slice-order mapping (srcZ={}, maskZ={})",
                    normal != null, hasAllIpp(targetIppByZ, nZ), anyIpp(maskIpp), nZ, mZ);
        }

        ImageStack ms = new ImageStack(w, h);
        for (int z = 0; z < nZ; z++) {
            int mz = mapZ[z];
            ms.addSlice((mz >= 0 && maskSlices[mz] != null) ? maskSlices[mz] : emptyMask(w, h));
        }
        return new ImagePlus("texture-mask", ms);
    }

    /** ImageProcessor を w×h に（必要なら nearest 補間）合わせ、値 ≥ 0.5 を label に二値化した ByteProcessor。 */
    private static ByteProcessor binarize(ImageProcessor ip, int w, int h, int label) {
        ImageProcessor src = ip;
        if (ip.getWidth() != w || ip.getHeight() != h) {
            src = ip.duplicate();
            src.setInterpolationMethod(ImageProcessor.NONE);
            src = src.resize(w, h); // nearest（ラベルマスクのため）
        }
        int v = Math.max(1, Math.min(255, label));
        ByteProcessor bp = new ByteProcessor(w, h);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                bp.set(x, y, src.getf(x, y) >= 0.5f ? v : 0);
            }
        }
        return bp;
    }

    private static ByteProcessor emptyMask(int w, int h) {
        return new ByteProcessor(w, h);
    }

    /** IOP(6) → 面法線（row×col）。無効なら null。 */
    private static double[] normalOf(double[] iop) {
        if (iop == null || iop.length != 6) return null;
        double[] r = {iop[0], iop[1], iop[2]};
        double[] c = {iop[3], iop[4], iop[5]};
        double[] n = {r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]};
        double len = Math.sqrt(dot(n, n));
        if (len < 1e-9) return null;
        return new double[]{n[0] / len, n[1] / len, n[2] / len};
    }

    private static double dot(double[] a, double[] b) {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }

    private static boolean hasAllIpp(Map<Integer, double[]> ippByZ, int nZ) {
        if (ippByZ == null) return false;
        for (int z = 0; z < nZ; z++) {
            double[] p = ippByZ.get(z);
            if (p == null || p.length != 3) return false;
        }
        return true;
    }

    private static boolean anyIpp(double[][] ipp) {
        if (ipp == null) return false;
        for (double[] p : ipp) if (p != null && p.length == 3) return true;
        return false;
    }

    /** ターゲット隣接スライスの法線投影距離（許容差の基準）。 */
    private static double targetSliceSpacing(Map<Integer, double[]> ippByZ, double[] normal, int nZ) {
        if (nZ >= 2) {
            double[] a = ippByZ.get(0), b = ippByZ.get(1);
            if (a != null && b != null) {
                double d = Math.abs(dot(a, normal) - dot(b, normal));
                if (d > 1e-4) return d;
            }
        }
        return 1.0;
    }

    /** 全面マスク（各スライス label で塗りつぶした ByteProcessor）。 */
    private static ImagePlus fullFaceMask(int w, int h, int nZ, int label) {
        int v = Math.max(1, Math.min(255, label));
        ImageStack st = new ImageStack(w, h);
        for (int z = 0; z < nZ; z++) {
            ByteProcessor bp = new ByteProcessor(w, h);
            bp.setValue(v);
            bp.fill();
            st.addSlice(bp);
        }
        return new ImagePlus("texture-fullmask", st);
    }

    private static int parseLabel(TextureSeriesRequest req) {
        if (req.settings() != null) {
            String v = req.settings().get("MASK_LABEL_INT");
            if (v != null && !v.isBlank()) {
                try {
                    return (int) Math.round(Double.parseDouble(v.trim()));
                } catch (NumberFormatException ignore) {
                    // fall through
                }
            }
        }
        return 1;
    }

    /** 読み込んだ 1 枚。 */
    private record Loaded(ImageProcessor ip, Calibration cal) {}

    /** SOP（＋モザイクフレーム）から ImageProcessor と Calibration を得る。 */
    private Loaded openBySop(String sop, int frame) throws IOException {
        if (sop == null) return null;
        if (frame >= 0) {
            byte[] dicom = storage.frameDicom(sop, frame);
            if (dicom == null) return null;
            Path tmp = Files.createTempFile("graphy-tex-", ".dcm");
            try {
                Files.write(tmp, dicom);
                return open(tmp);
            } finally {
                Files.deleteIfExists(tmp);
            }
        }
        Path path = storage.resolveInstanceFile(sop);
        return path != null ? open(path) : null;
    }

    private Loaded open(Path path) {
        ImagePlus imp = new Opener().openImage(path.toString());
        if (imp == null) return null;
        Calibration cal = imp.getCalibration();
        ImageProcessor ip = (imp.getStackSize() > 1) ? imp.getStack().getProcessor(1) : imp.getProcessor();
        return new Loaded(ip, cal);
    }

    private static int oddUp(int n) {
        return (n % 2 == 0) ? n + 1 : n;
    }

    /** C/T インデックスを [0, dim) にクランプ（dim<=0 は 0）。 */
    private static int clampDim(int v, int dim) {
        int d = Math.max(1, dim);
        if (v < 0) return 0;
        return v >= d ? d - 1 : v;
    }

    private static int clamp(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    private static double clamp01(double v) {
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    }
}

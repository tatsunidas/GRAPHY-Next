/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.ParametricMapFrameExpander;
import com.vis.graphynext.dicom.SeriesLayout;
import com.vis.graphynext.dicom.store.DicomStorageService;
import ij.ImagePlus;
import ij.ImageStack;
import ij.measure.Calibration;
import ij.process.ByteProcessor;
import ij.process.FloatProcessor;
import ij.process.ImageProcessor;
import io.github.tatsunidas.radiomics.main.FeatureVisualizationMap;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

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

    /** マスクを IOP/IPP で整列できたら "1"、スライス順の対応に落ちたら "0"（マスクの ImagePlus の属性）。 */
    static final String PROP_GEOMETRY_ALIGNED = "geometry-aligned";

    private static final Logger log = LoggerFactory.getLogger(RadiomicsMapEngine.class);

    private final DicomStorageService storage;
    private final MapCheckpointStore checkpoints;
    private final PixelCodec codec;

    public RadiomicsMapEngine(DicomStorageService storage, MapCheckpointStore checkpoints, PixelCodec codec) {
        this.storage = storage;
        this.checkpoints = checkpoints;
        this.codec = codec;
    }

    /**
     * 非可逆になりうる転送構文。JPEG 2000（.91）・HTJ2K（.203）・JPEG XL（.112）は可逆の符号も入れられるが、
     * 転送構文からは区別できないので非可逆として扱う（警告を出しすぎる側に倒す）。
     */
    static final Set<String> LOSSY_TRANSFER_SYNTAXES = Set.of(
            UID.JPEGBaseline8Bit, UID.JPEGExtended12Bit, UID.JPEGLSNearLossless,
            UID.JPEG2000, UID.HTJ2K, UID.JPEGXL);

    /**
     * 計算結果と、その途中結果のキー。派生シリーズの取り込みが済んだら
     * {@link #discardCheckpoints} で途中結果を消す（失敗・キャンセルでは残して、再投入で続きから）。
     */
    public record Computed(MapResult map, String checkpointKey, int checkpointSlices, int restoredSlices) {
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
            String frameOfReferenceUid,
            boolean lossyCompressed) {      // 元画像が非可逆圧縮（特徴量は圧縮の影響を受ける）
    }

    /** ターゲット（＋任意マスク）から 1 特徴のマップを計算する（進み具合は見ない）。 */
    public MapResult compute(TextureSeriesRequest req) throws IOException {
        return compute(req, TextureProgress.NONE);
    }

    /**
     * 読み込んだボリュームとマスク、そして幾何。
     *
     * <p>マップ生成（{@link #compute}）と GLAM 解析（{@link GlamAnalysisService}）は、
     * <b>同じ材料</b>から出発する — 同じシリーズを同じ (C,T) で積み、同じ規則でマスクを Z 整列し、
     * 同じ校正を載せる。違うのはそこから先だけなので、ここまでを 1 か所にまとめる。
     *
     * <p>{@code width}/{@code height}/{@code slices} と {@code calibration} は<b>計算に使う格子</b>
     * のもの。リサンプリングが有効なら元シリーズの格子とは異なり、そのときだけ
     * {@code resampling} に元の格子と逆変換が入る（{@link TextureResampling}）。
     * 一方 {@code ippByZ}/{@code sopPerZ} は<b>常に元シリーズの z</b> で並ぶ。
     */
    public record LoadedVolume(
            ImagePlus image,
            ImagePlus mask,
            int width, int height, int slices,
            int label,
            boolean hasMask,
            Calibration calibration,
            double[] imageOrientationPatient,
            double pixelSpacingRow, double pixelSpacingCol,
            Map<Integer, double[]> ippByZ,
            String[] sopPerZ,
            String frameOfReferenceUid,
            TextureResampling.Grid resampling,
            boolean lossyCompressed) {
    }

    /** ターゲット（＋任意マスク）から 1 特徴のマップを計算する。 */
    public MapResult compute(TextureSeriesRequest req, TextureProgress progress) throws IOException {
        return computeResumable(req, progress).map();
    }

    /** {@link #compute} と同じ計算。スライスごとの途中結果を使い（あれば続きから）、キーも返す。 */
    public Computed computeResumable(TextureSeriesRequest req, TextureProgress progress) throws IOException {
        LoadedVolume vol = load(req.studyInstanceUid(), req.sourceSeriesUid(), req.channel(), req.timePoint(),
                req.maskSeriesUid(), req.maskChannel(), parseLabel(req), req.settings());
        return computeFrom(req, progress, vol);
    }

    /** 取り込みが済んだ計算の途中結果を消す。 */
    public void discardCheckpoints(Computed c) {
        checkpoints.clear(c.checkpointKey(), c.checkpointSlices());
    }

    /**
     * シリーズを {@code ij.ImagePlus} のボリュームに積み、マスクを Z 整列し、校正を載せ、
     * 設定で要求されていればリサンプリングする。
     */
    public LoadedVolume load(String studyInstanceUid, String sourceSeriesUid, int channel, int timePoint,
                             String maskSeriesUid, int maskChannel, int label,
                             Map<String, String> settings) throws IOException {
        SeriesLayout layout = storage.seriesLayout(studyInstanceUid, sourceSeriesUid);
        if (layout == null || layout.cells().isEmpty()) {
            throw new IllegalArgumentException("ターゲットシリーズにフレームがありません: " + sourceSeriesUid);
        }
        int ch = clampDim(channel, layout.nC());
        int tp = clampDim(timePoint, layout.nT());

        // 指定 (C,T) に一致するセルを z 昇順で収集し、連続ボリュームとして扱う。
        // （T/C が空間位置と一致しない＝各グローバル z にそのセルが無いシリーズでも成立する。）
        Map<Integer, double[]> ippByZGlobal = new HashMap<>();
        if (layout.zSpatial() != null) {
            for (SeriesLayout.ZSpatial zs : layout.zSpatial()) {
                if (zs.imagePositionPatient() != null) ippByZGlobal.put(zs.z(), zs.imagePositionPatient());
            }
        }
        List<SeriesLayout.Cell> sel = new ArrayList<>();
        for (SeriesLayout.Cell cell : layout.cells()) {
            if (cell.c() == ch && cell.t() == tp) sel.add(cell);
        }
        sel.sort(java.util.Comparator.comparingInt(SeriesLayout.Cell::z));
        if (sel.isEmpty()) {
            throw new IllegalArgumentException("選択した C/T にフレームがありません (c=" + ch + ", t=" + tp
                    + ", nC=" + layout.nC() + ", nT=" + layout.nT() + ")");
        }
        int nZ = sel.size();
        String[] sopPerZ = new String[nZ];
        int[] framePerZ = new int[nZ];
        Map<Integer, double[]> ippByZ = new HashMap<>(); // k(連続) → IPP
        for (int k = 0; k < nZ; k++) {
            SeriesLayout.Cell c = sel.get(k);
            sopPerZ[k] = c.sopInstanceUid();
            framePerZ[k] = c.frame();
            double[] ipp = ippByZGlobal.get(c.z());
            if (ipp != null) ippByZ.put(k, ipp);
        }

        // ターゲットボリュームを積む（dcm4che で画素をデコード。圧縮なら PixelCodec で伸長）。
        int w = 0, h = 0;
        boolean lossy = false;
        Calibration cal = null;
        List<ImageProcessor> procs = new ArrayList<>(nZ);
        for (int z = 0; z < nZ; z++) {
            Loaded loaded = openBySop(sopPerZ[z], framePerZ[z]);
            if (loaded == null) {
                throw new IllegalArgumentException("スライスをデコードできません z=" + z + " sop=" + sopPerZ[z]
                        + "（backend ログを確認してください）");
            }
            lossy |= loaded.lossy();
            long nan = countNaN(loaded.ip());
            if (nan > 0) {
                // 窓の中の NaN を離散化がどう扱うか（RadiomicsJ）を確かめられていないので、黙って計算しない
                throw new IllegalArgumentException("値の無い画素（NaN）を含むシリーズはテクスチャを計算できません"
                        + "（z=" + z + " に " + nan + " 画素）。Parametric Map の NaN は背景などの「値なし」です。");
            }
            procs.add(loaded.ip());
            if (cal == null && loaded.cal() != null && loaded.cal().calibrated()) cal = loaded.cal();
            w = loaded.ip().getWidth();
            h = loaded.ip().getHeight();
        }
        if (w <= 0 || h <= 0) throw new IllegalStateException("画像サイズを取得できません");
        log.info("[texture] target loaded: c={} t={} slices={} ({}x{})", ch, tp, nZ, w, h);
        ImageStack imgStack = new ImageStack(w, h);
        for (ImageProcessor ip : procs) imgStack.addSlice(ip);
        ImagePlus img = new ImagePlus("texture-src", imgStack);
        Calibration finalCal = (cal != null) ? cal.copy() : img.getCalibration();
        if (layout.pixelSpacingCol() > 0 && layout.pixelSpacingRow() > 0) {
            finalCal.pixelWidth = layout.pixelSpacingCol();
            finalCal.pixelHeight = layout.pixelSpacingRow();
            finalCal.setUnit("mm");
        }
        // スライス間隔。距離をボクセル格子で測る族（GLAM）は、これが無いと Z だけ 1mm 扱いになる。
        double spacingZ = sliceSpacing(ippByZ, layout.imageOrientationPatient(), nZ);
        if (spacingZ > 0) {
            finalCal.pixelDepth = spacingZ;
        }
        img.setCalibration(finalCal);

        // マスク（任意）。無ければ全面マスク（LABEL で塗り）。ある場合は IOP/IPP で Z 整列。
        boolean hasMask = maskSeriesUid != null && !maskSeriesUid.isBlank();
        ImagePlus mask = buildMask(studyInstanceUid, maskSeriesUid, maskChannel, w, h, nZ, label,
                layout.imageOrientationPatient(), ippByZ);

        // リサンプリング（環境設定 ▸ テクスチャ）。ここから先は計算格子で進み、
        // マップは最後に元の格子へ戻す（幾何は元シリーズと一致させる）。
        TextureResampling.Grid grid = null;
        double[] target = TextureResampling.targetSpacing(settings);
        double[] source = {finalCal.pixelWidth, finalCal.pixelHeight, finalCal.pixelDepth};
        if (target != null && source[0] > 0 && source[1] > 0 && source[2] > 0
                && !TextureResampling.alreadyMatches(source, target)) {
            int[] planned = TextureResampling.plan(w, h, nZ, source, target);
            ImagePlus[] resampled = TextureResampling.resample(img, mask, label, target);
            img = resampled[0];
            mask = resampled[1];
            grid = TextureResampling.Grid.of(w, h, nZ, img.getWidth(), img.getHeight(), img.getNSlices(),
                    source, target);
            finalCal = img.getCalibration();
            log.info("[texture] resampled: {}x{}x{} ({}, {}, {} mm) -> {}x{}x{} ({}, {}, {} mm)",
                    w, h, nZ, source[0], source[1], source[2],
                    img.getWidth(), img.getHeight(), img.getNSlices(), target[0], target[1], target[2]);
            if (img.getWidth() != planned[0] || img.getHeight() != planned[1] || img.getNSlices() != planned[2]) {
                // 見積りと実際がずれたら、ここで気づけるようにしておく（増加率のガードが空振りする）。
                log.warn("[texture] resample grid differs from the estimate ({}x{}x{})",
                        planned[0], planned[1], planned[2]);
            }
            w = img.getWidth();
            h = img.getHeight();
            nZ = img.getNSlices();
            if (hasMask && windowCount(mask, label, 1) == 0) {
                // 粗い格子へ落とすと薄い ROI は部分体積しきい値を通らずに消える。ここで気づかないと
                // 「全面ゼロのマップが黙って出来上がる」側に落ちる（package-info の注意書き）。
                throw new IllegalArgumentException(String.format(
                        "リサンプリング (%s mm) で ROI が消えました。元の ROI が目標間隔に対して薄すぎます。"
                                + "目標間隔を細かくするか、リサンプリングを無効にしてください。",
                        String.join(", ", String.valueOf(target[0]), String.valueOf(target[1]),
                                String.valueOf(target[2]))));
            }
        } else if (target != null) {
            log.info("[texture] resampling requested but the volume is already ({}, {}, {} mm) -> skipped",
                    source[0], source[1], source[2]);
        }

        return new LoadedVolume(img, mask, w, h, nZ, label, hasMask, finalCal,
                layout.imageOrientationPatient(), layout.pixelSpacingRow(), layout.pixelSpacingCol(),
                ippByZ, sopPerZ, layout.frameOfReferenceUID(), grid, lossy);
    }

    /** {@link #load} で揃えた材料からマップを計算する（compute の後半）。 */
    Computed computeFrom(TextureSeriesRequest req, TextureProgress progress, LoadedVolume vol) {
        ImagePlus img = vol.image();
        ImagePlus mask = vol.mask();
        int w = vol.width();
        int h = vol.height();
        int nZ = vol.slices();
        int label = vol.label();
        boolean hasMask = vol.hasMask();
        Calibration finalCal = vol.calibration();
        Map<Integer, double[]> ippByZ = vol.ippByZ();
        String[] sopPerZ = vol.sopPerZ();
        int filterSize = req.filterSize() > 0 ? oddUp(req.filterSize()) : 7;
        int stride = Math.max(1, req.stride());
        boolean d2 = req.force2D();
        int margin = req.margin() != null ? Math.max(0, req.margin()) : FeatureVisualizationMap.DEFAULT_MARGIN;

        boolean glam = GlamMapSupport.isGlam(req.feature());
        if (glam) {
            // 3D 専用・カーネル下限・マスク必須。ここで弾かないと RadiomicsJ の例外がボクセルごとに
            // 握り潰され、全面ゼロのマップが黙って出来上がる。
            GlamMapSupport.validate(req, nZ, hasMask, isotropyWarning(finalCal));
            long windows = windowCount(mask, label, stride);
            log.info("[texture][GLAM] {} windows, estimated {} s (kernel={}, maxRadius={})",
                    windows, GlamMapSupport.estimateMillis(windows, filterSize) / 1000,
                    filterSize, GlamMapSupport.maxRadiusFor(filterSize, req.settings()));
            if (GlamMapSupport.dependsOnBoundaryCorrection(req.feature())) {
                log.warn("[texture][GLAM] '{}' は境界補正が入ると 1 に張り付きます。"
                        + "BOOL_GLAM_boundaryCorrection=0 での実行を検討してください。", req.feature());
            }
        }

        // calculator（族→ラムダ）。GLAM は窓の大きさで maxRadius が決まるためカーネル径を渡す。
        TextureFeatureCatalog.BuiltFeature built =
                TextureFeatureCatalog.build(req.feature(), req.settings(), filterSize);

        final int mapW = w;
        final int mapH = h;
        long t0 = System.currentTimeMillis();
        TextureProgress sink = (progress != null) ? progress : TextureProgress.NONE;
        String ckptKey = checkpoints.key(req, vol, filterSize, stride, d2, margin);
        int[] restoredCount = new int[1];
        float[][] full = runMap(glam, req, () -> computePerSlice(img, mask, built, filterSize, d2, stride, margin,
                mapW, mapH, nZ, sink, ckptKey, restoredCount));
        log.info("[texture] map '{}' {}x{}x{} stride={} filter={} margin={} in {} ms",
                built.displayName(), w, h, nZ, stride, filterSize, margin, System.currentTimeMillis() - t0);

        // リサンプリングして計算した場合は、元シリーズの格子へ戻してから DICOM 化する
        // （派生シリーズの幾何を元と一致させ、Fusion で重ねられる状態を保つ）。
        int outW = w;
        int outH = h;
        int outZ = nZ;
        if (vol.resampling() != null) {
            TextureResampling.Grid grid = vol.resampling();
            full = TextureResampling.toSourceGrid(full, w, h, nZ, grid);
            outW = grid.sourceWidth();
            outH = grid.sourceHeight();
            outZ = grid.sourceSlices();
            log.info("[texture] map mapped back to the source grid {}x{}x{}", outW, outH, outZ);
        }

        List<double[]> ippList = new ArrayList<>(outZ);
        List<String> sopList = new ArrayList<>(outZ);
        for (int z = 0; z < outZ; z++) {
            ippList.add(ippByZ.get(z));
            sopList.add(sopPerZ[z]);
        }
        return new Computed(new MapResult(outW, outH, outZ, full,
                built.displayName(),
                vol.imageOrientationPatient(),
                vol.pixelSpacingRow(), vol.pixelSpacingCol(),
                ippList, sopList, vol.frameOfReferenceUid(), vol.lossyCompressed()), ckptKey, nZ, restoredCount[0]);
    }

    /**
     * GLAM なら {@code RadiomicsJ.glam*} を設定で上書きしてから走らせ、必ず元へ戻す
     * （プロセス広域の static なので直列化される）。それ以外の族はそのまま走らせる。
     */
    private float[][] runMap(boolean glam, TextureSeriesRequest req, java.util.function.Supplier<float[][]> body) {
        if (!glam) {
            return body.get();
        }
        try {
            return GlamMapSupport.runWithSettings(req.settings(), body::get);
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("GLAM マップの計算に失敗しました: " + e.getMessage(), e);
        }
    }

    /** 非等方ボクセルの説明（等方なら null）。GLAM は距離をボクセル格子で測るため効いてくる。 */
    private static String isotropyWarning(Calibration cal) {
        double sx = cal.pixelWidth, sy = cal.pixelHeight, sz = cal.pixelDepth;
        double tolerance = 1e-3 * Math.max(sx, Math.max(sy, sz));
        if (Math.abs(sx - sy) <= tolerance && Math.abs(sx - sz) <= tolerance) {
            return null;
        }
        return String.format("ボクセルが等方ではありません (%.4f, %.4f, %.4f mm)。"
                + "GLAM は距離をボクセル格子で測るため、等方へリサンプリングした画像を使ってください。", sx, sy, sz);
    }

    /** 隣接スライスの法線投影距離＝スライス間隔。求まらなければ 0。 */
    private static double sliceSpacing(Map<Integer, double[]> ippByZ, double[] iop, int nZ) {
        double[] normal = normalOf(iop);
        if (normal == null || nZ < 2) return 0;
        double[] a = ippByZ.get(0), b = ippByZ.get(1);
        if (a == null || b == null || a.length != 3 || b.length != 3) return 0;
        double d = Math.abs(dot(a, normal) - dot(b, normal));
        return d > 1e-4 ? d : 0;
    }

    /** stride を踏まえて実際に特徴計算が走る窓の数（＝マスク内のサンプル点）。 */
    private static long windowCount(ImagePlus mask, int label, int stride) {
        int v = Math.max(1, Math.min(255, label));
        ImageStack st = mask.getStack();
        long count = 0;
        for (int z = 0; z < mask.getNSlices(); z++) {
            ImageProcessor ip = st.getProcessor(z + 1);
            for (int y = 0; y < ip.getHeight(); y += stride) {
                for (int x = 0; x < ip.getWidth(); x += stride) {
                    if (ip.getf(x, y) >= v) count++;
                }
            }
        }
        return count;
    }

    /**
     * 1 スライスずつ計算する（RadiomicsJ の {@code slice} 指定。<b>全スライス一括と全画素一致する</b>ことを
     * 族 6＋GLAM × 2D/3D × stride × margin × マスクで確認済み: {@code fw/cache-store.md}）。
     * 1 枚終わるごとに途中結果を保存し、同じ入力の再投入では保存済みの枚をそのまま使う。
     *
     * <p>stride&gt;1 は XY のみ RadiomicsJ が間引き（<b>Z は常に全スライス</b>）、得られた各スライス
     * （outW×outH）を <b>Bilinear 補間で source 次元（w×h）へ拡大</b>する。保存するのは補間<b>前</b>の
     * 計算結果。キャンセルは 1 枚終わって保存した<b>後</b>の {@code progress} から投げられる。
     *
     * @param key 途中結果のキー。null なら保存も復元もしない
     */
    private float[][] computePerSlice(ImagePlus img, ImagePlus mask, TextureFeatureCatalog.BuiltFeature built,
                                      int filterSize, boolean d2, int stride, int margin, int w, int h, int s,
                                      TextureProgress progress, String key, int[] restoredOut) {
        int outW = (int) Math.ceil((double) w / stride);
        int outH = (int) Math.ceil((double) h / stride);
        float[][] full = new float[s][];
        int restored = 0;
        progress.update(0, s);
        for (int z = 0; z < s; z++) {
            float[] low = key == null ? null : checkpoints.load(key, z, outW * outH).orElse(null);
            if (low != null) {
                restored++;
            } else {
                int slice = z + 1;
                // 抽出がスライスの切れ目で割り込めるよう、1 枚ずつ取る（RadiomicsLock）。
                ImagePlus one = RadiomicsLock.get(() -> FeatureVisualizationMap.generateFeatureMap(img, mask, slice,
                        built.calculator(), filterSize, d2, stride, margin, (done, total) -> { }));
                low = (float[]) one.getStack().getProcessor(1).convertToFloatProcessor().getPixels();
                if (key != null && low.length == outW * outH) {
                    checkpoints.save(key, z, low);
                }
            }
            full[z] = (stride <= 1) ? low : expand(low, outW, outH, w, h, stride);
            progress.update(z + 1, s);
        }
        restoredOut[0] = restored;
        if (restored > 0) {
            log.info("[texture] {} of {} slices restored from checkpoints", restored, s);
        }
        return full;
    }

    private static float[] expand(float[] low, int outW, int outH, int w, int h, int stride) {
        float[] dst = new float[w * h];
        for (int sy = 0; sy < h; sy++) {
            double fy = (double) sy / stride;
            for (int sx = 0; sx < w; sx++) {
                double fx = (double) sx / stride;
                dst[sy * w + sx] = bilinear(low, outW, outH, fx, fy);
            }
        }
        return dst;
    }

    /** 低解像度スライス low[outW*outH] を Bilinear 補間サンプルする（XY のみ）。 */
    private static float bilinear(float[] low, int outW, int outH, double fx, double fy) {
        int x0 = clamp((int) Math.floor(fx), 0, outW - 1);
        int y0 = clamp((int) Math.floor(fy), 0, outH - 1);
        int x1 = Math.min(x0 + 1, outW - 1);
        int y1 = Math.min(y0 + 1, outH - 1);
        double dx = clamp01(fx - x0), dy = clamp01(fy - y0);
        float c00 = low[y0 * outW + x0], c10 = low[y0 * outW + x1];
        float c01 = low[y1 * outW + x0], c11 = low[y1 * outW + x1];
        double c0 = c00 * (1 - dx) + c10 * dx;
        double c1 = c01 * (1 - dx) + c11 * dx;
        return (float) (c0 * (1 - dy) + c1 * dy);
    }

    /**
     * マスク ImagePlus を作る。マスクシリーズがあれば <b>IOP/IPP ベースで Z 整列</b>して積む
     * （Fusion と同方針: 各ターゲットスライスに対し、法線投影距離が最も近いマスクスライスを採用）。
     * マスク画素は <b>値 ≥ 0.5 を LABEL</b> として二値化する。IOP/IPP 不明・OutOfRange の場合は
     * <b>スライスオーダー（index）</b>にフォールバックする。分岐は必ずログ出力する。マスク未指定は全面。
     */
    private ImagePlus buildMask(String studyInstanceUid, String maskSeriesUid, int maskChannel,
                               int w, int h, int nZ, int label,
                               double[] targetIop, Map<Integer, double[]> targetIppByZ) throws IOException {
        if (maskSeriesUid == null || maskSeriesUid.isBlank()) {
            log.info("[texture] mask: none specified -> full-face mask (label={})", label);
            return fullFaceMask(w, h, nZ, label);
        }
        SeriesLayout ml = storage.seriesLayout(studyInstanceUid, maskSeriesUid);
        if (ml == null || ml.cells().isEmpty()) {
            log.warn("[texture] mask: series '{}' empty -> full-face mask", maskSeriesUid);
            return fullFaceMask(w, h, nZ, label);
        }
        int mCh = clampDim(maskChannel, ml.nC()); // SEG マルチセグメント=マルチ C の選択。

        // マスクの選択チャンネルのセルを z 昇順で収集（ターゲット同様、連続スタックとして扱う）。
        Map<Integer, double[]> maskIppGlobal = new HashMap<>();
        if (ml.zSpatial() != null) {
            for (SeriesLayout.ZSpatial zs : ml.zSpatial()) {
                if (zs.imagePositionPatient() != null) maskIppGlobal.put(zs.z(), zs.imagePositionPatient());
            }
        }
        List<SeriesLayout.Cell> mSel = new ArrayList<>();
        for (SeriesLayout.Cell cell : ml.cells()) {
            if (cell.c() == mCh && cell.t() == 0) mSel.add(cell);
        }
        mSel.sort(java.util.Comparator.comparingInt(SeriesLayout.Cell::z));
        if (mSel.isEmpty()) {
            log.warn("[texture] mask channel c={} (nC={}) has no frames -> full-face mask", mCh, ml.nC());
            return fullFaceMask(w, h, nZ, label);
        }
        int mZ = mSel.size();
        if (ml.nC() > 1) {
            log.info("[texture] mask channel selected: c={} of nC={} ({} slices, series={})", mCh, ml.nC(), mZ, maskSeriesUid);
        }
        double[][] maskIpp = new double[mZ][];
        ByteProcessor[] maskSlices = new ByteProcessor[mZ];
        for (int k = 0; k < mZ; k++) {
            SeriesLayout.Cell c = mSel.get(k);
            maskIpp[k] = maskIppGlobal.get(c.z());
            Loaded l = openBySop(c.sopInstanceUid(), c.frame());
            maskSlices[k] = (l != null) ? binarize(l.ip(), w, h, label) : null;
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
            // 許容差はスライス間隔の半分（最近傍マッチ）。これにより、マスク端の外側にある
            // ターゲットスライス（≒1 スライス間隔だけ離れる）が端のマスクを拾わず空になる。
            double tol = 0.5 * targetSliceSpacing(targetIppByZ, normal, nZ);
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
                    // 幾何整列あり かつ マスク範囲外（OutOfRange）: そこにマスクは無い → 空スライス。
                    // （index フォールバックすると無関係なマスクを載せてしまうため採用しない。）
                    mapZ[z] = -1;
                    outOfRange++;
                }
            }
            log.info("[texture] mask: IOP/IPP-aligned (srcZ={}, maskZ={}, tol={}mm, outOfRange={} -> empty)",
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
        ImagePlus out = new ImagePlus("texture-mask", ms);
        out.setProp(PROP_GEOMETRY_ALIGNED, geomOk ? "1" : "0");
        return out;
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
    static double[] normalOf(double[] iop) {
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

    /** 読み込んだ 1 枚。{@code lossy} は非可逆圧縮の画像（転送構文か LossyImageCompression=01）。 */
    record Loaded(ImageProcessor ip, Calibration cal, boolean lossy) {}

    /**
     * SOP（＋モザイクフレーム）から ImageProcessor を得る。ImageJ の Opener はヘッドレス backend では
     * DICOM を開けないことがあるため、<b>dcm4che でデータセットを読んで画素を直接デコード</b>する。
     * Rescale を適用してモダリティ値（HU/SUV 等）の FloatProcessor を返す。
     */
    private Loaded openBySop(String sop, int frame) throws IOException {
        if (sop == null) return null;
        if (frame >= 0) {
            byte[] dicom = storage.frameDicom(sop, frame);
            if (dicom == null) {
                Path path = storage.resolveInstanceFile(sop);
                String ts = path == null ? null : transferSyntaxOf(path);
                if (ts != null && !PixelCodec.isUncompressed(ts)) {
                    // フレームの切り出しはビューアと共通で、圧縮のままでは切り出せない
                    throw new IllegalArgumentException("圧縮されたマルチフレーム画像には未対応です（転送構文 "
                            + UID.nameOf(ts) + "）。sop=" + sop);
                }
                return null;
            }
            Attributes ds;
            try (DicomInputStream in = new DicomInputStream(new ByteArrayInputStream(dicom))) {
                in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
                ds = in.readDataset();
            }
            return processorFrom(ds, sop, ds.getBytes(Tag.PixelData), isLossy(ds, null));
        }
        Path path = storage.resolveInstanceFile(sop);
        if (path == null) return null;
        return readSlice(path, sop, codec);
    }

    /**
     * 1 枚 1 ファイルの画像を読む。圧縮（カプセル化）なら {@link PixelCodec} で伸長してから、
     * 非圧縮と同じ変換（BitsStored・符号・Rescale）に通す。
     */
    static Loaded readSlice(Path path, String sop, PixelCodec codec) throws IOException {
        Attributes ds;
        String ts;
        try (DicomInputStream in = new DicomInputStream(path.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
            ds = in.readDataset();
            ts = in.getTransferSyntax();
        }
        if (PixelCodec.isUncompressed(ts)) {
            return processorFrom(ds, sop, ds.getBytes(Tag.PixelData), isLossy(ds, ts));
        }
        requireGrayscale(ds, sop);
        if (!codec.available()) {
            throw new IllegalArgumentException("圧縮画像の伸長に必要な部品がありません（" + codec.unavailableReason()
                    + "）。転送構文 " + UID.nameOf(ts));
        }
        // 伸長は PixelData が元ファイルへの参照（BulkData）であることを要求する（PixelCodec.decompress）
        Attributes ref;
        try (DicomInputStream in = new DicomInputStream(path.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
            ref = in.readDataset();
        }
        byte[] px = codec.decompress(ref, ts);
        if (px == null) {
            throw new IllegalArgumentException("圧縮画像を伸長できませんでした（転送構文 " + UID.nameOf(ts)
                    + "）。sop=" + sop + "。backend ログを確認してください");
        }
        return processorFrom(ref, sop, px, isLossy(ds, ts));
    }

    static boolean isLossy(Attributes ds, String ts) {
        return (ts != null && LOSSY_TRANSFER_SYNTAXES.contains(ts))
                || "01".equals(ds.getString(Tag.LossyImageCompression));
    }

    private static String transferSyntaxOf(Path path) {
        try (DicomInputStream in = new DicomInputStream(path.toFile())) {
            in.readFileMetaInformation(); // 読む前の getTransferSyntax() は推定値（Explicit VR LE）
            return in.getTransferSyntax();
        } catch (IOException e) {
            return null;
        }
    }

    private static void requireGrayscale(Attributes ds, String sop) {
        int spp = ds.getInt(Tag.SamplesPerPixel, 1);
        if (spp != 1) {
            throw new IllegalArgumentException("カラー画像（SamplesPerPixel=" + spp
                    + "）はテクスチャ解析の対象外です。sop=" + sop);
        }
    }

    /** dcm4che データセットと（伸長済みの）画素 → モダリティ値(Rescale 適用)の FloatProcessor。 */
    static Loaded processorFrom(Attributes ds, String sop, byte[] px, boolean lossy) {
        int rows = ds.getInt(Tag.Rows, 0);
        int cols = ds.getInt(Tag.Columns, 0);
        if (rows <= 0 || cols <= 0) {
            log.warn("[texture] no Rows/Columns for {}", sop);
            return null;
        }
        requireGrayscale(ds, sop);
        if (ParametricMapFrameExpander.hasFloatPixels(ds)) {
            // Parametric Map から切り出した float のフレーム（値は実際の量）。NaN は呼び出し側で断る
            float[] v = ParametricMapFrameExpander.frameValues(ds, 0);
            return v == null ? null : new Loaded(new FloatProcessor(cols, rows, v, null), null, lossy);
        }
        int ba = ds.getInt(Tag.BitsAllocated, 16);
        int bs = ds.getInt(Tag.BitsStored, ba);
        int pr = ds.getInt(Tag.PixelRepresentation, 0);
        double slope = ds.getDouble(Tag.RescaleSlope, 1.0);
        double intercept = ds.getDouble(Tag.RescaleIntercept, 0.0);
        if (px == null) {
            log.warn("[texture] PixelData missing for {}", sop);
            return null;
        }
        int n = rows * cols;
        float[] f = new float[n];
        if (ba == 16) {
            if (px.length < n * 2) {
                log.warn("[texture] PixelData too short ({}<{}) for {}", px.length, n * 2, sop);
                return null;
            }
            int mask = (bs >= 16) ? 0xFFFF : ((1 << bs) - 1);
            int signBit = 1 << (bs - 1);
            int span = 1 << bs;
            for (int i = 0; i < n; i++) {
                int v = ((px[2 * i] & 0xFF) | ((px[2 * i + 1] & 0xFF) << 8)) & mask;
                if (pr == 1 && (v & signBit) != 0) v -= span; // 符号付き 2 の補数（BitsStored 準拠）
                f[i] = (float) (v * slope + intercept);
            }
        } else if (ba == 8) {
            if (px.length < n) {
                log.warn("[texture] PixelData too short ({}<{}) for {}", px.length, n, sop);
                return null;
            }
            for (int i = 0; i < n; i++) {
                f[i] = (float) ((px[i] & 0xFF) * slope + intercept);
            }
        } else {
            log.warn("[texture] unsupported BitsAllocated={} for {}", ba, sop);
            return null;
        }
        // 値は既にモダリティ値（HU/SUV 等）。Calibration は identity 扱い（radiomicsj は画素値で離散化）。
        FloatProcessor fp = new FloatProcessor(cols, rows, f, null);
        return new Loaded(fp, null, lossy);
    }

    private static long countNaN(ImageProcessor ip) {
        if (!(ip instanceof FloatProcessor fp)) return 0;
        long n = 0;
        for (float v : (float[]) fp.getPixels()) {
            if (Float.isNaN(v)) n++;
        }
        return n;
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

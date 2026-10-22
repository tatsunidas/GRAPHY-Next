/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.dicom.store.DicomStorageService;
import ij.ImagePlus;
import ij.ImageStack;
import io.github.tatsunidas.radiomics.main.ImageFiltering;
import io.github.tatsunidas.radiomics.main.RadiomicsJ;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.util.UIDUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;

/**
 * フィルタ画像（LoG）を、元と同じ格子の派生シリーズ（Secondary Capture・16bit＋Rescale）として保存する。
 *
 * <p>値は表示用に 16bit へ量子化される。ROI の数値の正本は特徴量表で、派生シリーズの上で ROI 統計を取ると
 * 量子化の分だけ違う。書き出しはテクスチャマップと共通（{@link TextureSeriesService#buildInstance}）。
 */
@Service
public class FilteredSeriesService {

    private static final Logger log = LoggerFactory.getLogger(FilteredSeriesService.class);

    private final DicomStorageService storage;
    private final RadiomicsMapEngine engine;
    private final RadiomicsMode mode;

    public FilteredSeriesService(DicomStorageService storage, RadiomicsMapEngine engine, RadiomicsMode mode) {
        this.storage = storage;
        this.engine = engine;
        this.mode = mode;
    }

    /** 作った 1 本。{@code scaleMm} は換算後の半径 r、{@code sigmaMm} は LoG の σ。 */
    public record Created(double scaleMm, double sigmaMm, String seriesInstanceUid, List<String> sopInstanceUids) {}

    public record Result(List<Created> series, boolean lossyCompressed) {}

    /** 進み具合の受け口（終えた数 / 全数と、今のスケールの r）。 */
    @FunctionalInterface
    public interface Progress {
        void scale(int done, int total, double scaleMm);
    }

    public Result create(FilteredSeriesRequest req) throws IOException {
        return create(req, (d, t, r) -> { }, () -> false, c -> { });
    }

    /** 投入の前に通す検査（web モード・必須項目・スケールの有無）。通らなければ例外。 */
    void check(FilteredSeriesRequest req) {
        mode.require("フィルタ画像");
        if (req.studyInstanceUid() == null || req.studyInstanceUid().isBlank()
                || req.sourceSeriesUid() == null || req.sourceSeriesUid().isBlank()) {
            throw new IllegalArgumentException("studyInstanceUid / sourceSeriesUid は必須です");
        }
        if (req.scales() == null || req.scales().isEmpty()) {
            throw new IllegalArgumentException("スケールを 1 つ以上指定してください。");
        }
    }

    /**
     * 取り消しは「今のスケールを書き終えて、残りは始めない」。作り終えた分は保管庫に残り、{@code onCreated} で
     * 1 本ごとに知らせる（取り消しや失敗のときも、何ができたかを呼び手が持てるように）。
     */
    public Result create(FilteredSeriesRequest req, Progress progress, BooleanSupplier cancelled,
                         java.util.function.Consumer<Created> onCreated) throws IOException {
        check(req);
        FilterScale.Conversion conversion = FilterScale.parse(req.scaleConversion());
        FilterScale.Notation notation = FilterScale.parseNotation(req.scaleNotation());
        boolean volumeFilter = parseDimension(req.dimension());
        int d = volumeFilter ? 3 : 2;
        double truncate = req.truncate() == null ? 4.0 : req.truncate();
        if (!(truncate >= 1.0 && truncate <= 10.0)) {
            throw new IllegalArgumentException("切り捨て（σ の倍数）は 1〜10 で指定してください: " + req.truncate());
        }
        ImageFiltering.Padding padding = parsePadding(req.padding());
        List<Double> values = distinct(req.scales());
        for (double v : values) {
            double r = notation == FilterScale.Notation.WIDTH_PX ? FilterScale.radiusMmFromWidthPx(v, 1.0) : v;
            if (r == 0) {
                throw new IllegalArgumentException("0 はフィルタなしです。フィルタ画像は 0 より大きいスケールで作ります。");
            }
            FilterScale.sigmaMm(r, d, conversion, req.scaleCoefficient());
        }

        List<Path> srcFiles = storage.resolveFiles(req.studyInstanceUid(), List.of(req.sourceSeriesUid()));
        if (srcFiles.isEmpty()) {
            throw new IllegalArgumentException("ターゲットシリーズが見つかりません: " + req.sourceSeriesUid());
        }
        Attributes tmpl = TextureSeriesService.readHeader(srcFiles.get(0));

        // 元の格子のまま読む（マスク無し・リサンプリング無し）。
        RadiomicsMapEngine.LoadedVolume vol = engine.load(req.studyInstanceUid(), req.sourceSeriesUid(),
                req.channel(), req.timePoint(), null, 0, 1, new HashMap<>());
        var cal = vol.calibration();
        LogGrid.require(cal, volumeFilter);
        if (notation == FilterScale.Notation.WIDTH_PX
                && Math.abs(cal.pixelWidth - cal.pixelHeight) > 1e-3 * Math.max(cal.pixelWidth, cal.pixelHeight)) {
            throw new IllegalArgumentException(String.format(
                    "画素幅は縦横の間隔が同じ画像だけで使えます（この画像は %.3f × %.3f mm）。半径（mm）で指定してください。",
                    cal.pixelWidth, cal.pixelHeight));
        }

        List<Created> created = new ArrayList<>();
        List<Double> doneR = new ArrayList<>();
        for (double v : values) {
            if (cancelled.getAsBoolean()) {
                throw new CancellationException("スケールの境界で取り消しました");
            }
            double r = notation == FilterScale.Notation.WIDTH_PX ? FilterScale.radiusMmFromWidthPx(v, cal.pixelWidth) : v;
            if (doneR.contains(r)) {
                continue;
            }
            doneR.add(r);
            progress.scale(created.size(), values.size(), r);
            double sigma = FilterScale.sigmaMm(r, d, conversion, req.scaleCoefficient());
            Created one = writeOne(req, vol, tmpl, r, sigma, truncate, padding, volumeFilter, conversion);
            created.add(one);
            onCreated.accept(one);
        }
        progress.scale(created.size(), values.size(), doneR.get(doneR.size() - 1));
        return new Result(created, vol.lossyCompressed());
    }

    private Created writeOne(FilteredSeriesRequest req, RadiomicsMapEngine.LoadedVolume vol, Attributes tmpl,
                             double r, double sigma, double truncate, ImageFiltering.Padding padding,
                             boolean volumeFilter, FilterScale.Conversion conversion) throws IOException {
        ImagePlus filtered;
        try {
            filtered = RadiomicsLock.call(() -> ImageFiltering.laplacianOfGaussian(
                    vol.image(), sigma, truncate, padding, !volumeFilter));
        } catch (IllegalArgumentException | IllegalStateException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("LoG フィルタの計算に失敗しました: " + e.getMessage(), e);
        }
        ImageStack st = filtered.getStack();
        int w = vol.width(), h = vol.height(), n = vol.slices();
        float[][] data = new float[n][];
        for (int z = 0; z < n; z++) {
            data[z] = (float[]) st.getProcessor(z + 1).convertToFloat().getPixels();
        }

        double[] mm = TextureSeriesService.minMax(data);
        double min = mm[0], max = mm[1];
        if (Double.isNaN(min) || Double.isNaN(max) || Double.isInfinite(min) || Double.isInfinite(max)) {
            min = 0.0;
            max = 1.0;
        }
        if (min == max) {
            max = min + 1.0;
        }
        double slope = (max - min) / 65535.0;
        double intercept = min;
        // 0 が中間の灰色になる窓（符号が見える）。幅は最大絶対値の 2 倍。
        double maxAbs = Math.max(1e-6, Math.max(Math.abs(min), Math.abs(max)));

        List<double[]> ipps = new ArrayList<>(n);
        List<String> srcSops = new ArrayList<>(n);
        for (int z = 0; z < n; z++) {
            ipps.add(vol.ippByZ().get(z));
            srcSops.add(vol.sopPerZ() != null && z < vol.sopPerZ().length ? vol.sopPerZ()[z] : null);
        }
        String rescaleType = "LoG_r" + FilterScale.settingValue(r);
        RadiomicsMapEngine.MapResult map = new RadiomicsMapEngine.MapResult(w, h, n, data, rescaleType,
                vol.imageOrientationPatient(), vol.pixelSpacingRow(), vol.pixelSpacingCol(), ipps, srcSops,
                vol.frameOfReferenceUid(), vol.lossyCompressed());

        String newSeriesUid = UIDUtils.createUID();
        int seriesNumber = tmpl.getInt(Tag.SeriesNumber, 0) + 3000;
        String seriesDesc = "LoG r" + FilterScale.settingValue(r) + " " + tmpl.getString(Tag.SeriesDescription, "");
        double sliceThickness = tmpl.getDouble(Tag.SliceThickness, 0.0);
        double spacingBetween = tmpl.getDouble(Tag.SpacingBetweenSlices,
                TextureSeriesService.spacingFromIpp(ipps, sliceThickness));
        String derivation = derivationDescription(r, sigma, conversion, req.scaleCoefficient(), volumeFilter,
                truncate, padding, vol.lossyCompressed());

        List<String> sops = new ArrayList<>(n);
        for (int z = 0; z < n; z++) {
            byte[] px = TextureSeriesService.to16bit(data[z], slope, intercept);
            Attributes a = TextureSeriesService.buildInstance(tmpl, req.studyInstanceUid(), map, newSeriesUid,
                    seriesNumber, seriesDesc, "LOG", rescaleType, derivation, slope, intercept, 0.0, 2 * maxAbs,
                    sliceThickness, spacingBetween, z, px);
            sops.add(a.getString(Tag.SOPInstanceUID));
            TextureSeriesService.ingest(storage, a);
        }
        log.info("filtered series created: {} ({} instances) LoG r={} sigma={} from {}",
                newSeriesUid, sops.size(), r, sigma, req.sourceSeriesUid());
        return new Created(r, sigma, newSeriesUid, sops);
    }

    /** DerivationDescription は key=value を {@code "; "} でつなぐ（後から値の意味を辿れるように）。 */
    static String derivationDescription(double r, double sigma, FilterScale.Conversion conversion, Double k,
                                        boolean volumeFilter, double truncate, ImageFiltering.Padding padding,
                                        boolean lossy) {
        StringBuilder sb = new StringBuilder("filter=LoG; r_mm=").append(FilterScale.settingValue(r))
                .append("; sigma_mm=").append(FilterScale.settingValue(sigma))
                .append("; scale_to_sigma=").append(conversion == FilterScale.Conversion.COEFFICIENT && k != null
                        ? "COEFFICIENT:" + k : conversion.name())
                .append("; dim=").append(volumeFilter ? "3D" : "2D")
                .append("; truncate_sigma=").append(truncate)
                .append("; boundary=").append(padding.name())
                .append("; radiomicsj=").append(RadiomicsJ.version);
        if (lossy) {
            sb.append("; source: lossy compressed");
        }
        return sb.toString();
    }

    private static boolean parseDimension(String s) {
        if (s == null || s.isBlank() || s.trim().equalsIgnoreCase("2D")) {
            return false;
        }
        if (s.trim().equalsIgnoreCase("3D")) {
            return true;
        }
        throw new IllegalArgumentException("dimension は 2D か 3D です: " + s);
    }

    private static ImageFiltering.Padding parsePadding(String s) {
        if (s == null || s.isBlank()) {
            return ImageFiltering.Padding.MIRROR;
        }
        try {
            return ImageFiltering.Padding.valueOf(s.trim());
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("padding は " + Arrays.toString(ImageFiltering.Padding.values())
                    + " のいずれかです: " + s);
        }
    }

    private static List<Double> distinct(List<Double> in) {
        List<Double> out = new ArrayList<>();
        for (Double v : in) {
            if (v == null) {
                throw new IllegalArgumentException("スケールに空の値があります。");
            }
            if (!out.contains(v)) {
                out.add(v);
            }
        }
        return out;
    }
}

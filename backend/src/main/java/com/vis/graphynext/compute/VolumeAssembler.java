/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.vis.graphynext.anonymize.AnonymizeService;
import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.ParametricMapFrameExpander;
import com.vis.graphynext.dicom.SegFrameExpander;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 匿名化済みのインスタンスを受け取り、1 本のボリュームの npz にする。
 *
 * <p>🔴 <b>入力は匿名化の出力（{@link AnonymizeService#anonymizeSeries} の Sink）だけ。</b>
 * 元ファイルから画素を読み直さない——読み直すと焼き込みを塗る前の画素が出てしまう。
 * dicom-zip と npz は同じ匿名化の経路を通るので、中身（塗った画素）は必ず一致する。
 *
 * <h3>npz の中身（{@code numpy.load} で読む）</h3>
 * <ul>
 *   <li>{@code volume}: float32 {@code [z, y, x]}。Rescale（slope/intercept）を適用済み（CT なら HU）</li>
 *   <li>{@code spacing}: float64 {@code [dz, dy, dx]}（mm）。分からなければ NaN</li>
 *   <li>{@code origin}: float64 {@code [x, y, z]}（患者座標 LPS・mm。先頭スライスの左上画素の中心）。分からなければ NaN</li>
 *   <li>{@code direction}: float64 {@code [3, 3]}。行 0/1/2 が volume の x/y/z 軸の向き（LPS の単位ベクトル）</li>
 *   <li>{@code meta.json}: モダリティ・光度解釈・匿名化後の UID・並べ方・値の単位・表示の窓
 *       （{@code windowCenter}/{@code windowWidth}: 配列。先頭インスタンスの値で、volume と同じ Rescale 適用後の空間。
 *       {@code voiLutFunction}: 無ければ欄ごと省く＝LINEAR。窓が無い DICOM では 3 欄とも省く。VOI LUT Sequence は出さない）（{@code numpy.load} では bytes で読める）</li>
 * </ul>
 *
 * <p>Parametric Map（NIfTI の float の取り込み・fw/nifti-import.md §3.1）は Float Pixel Data を RWVM で実際の量にして
 * そのまま入れる（NaN も NaN のまま）。幾何は Functional Groups（共有の向き・画素間隔、フレームごとの位置）から取る。
 * <ul>
 * </ul>
 */
final class VolumeAssembler implements AnonymizeService.Sink {

    /** 元の画素の合計の上限。これを超えるシリーズは dicom-zip で送ってもらう。 */
    static final long MAX_RAW_BYTES = 1L << 30;

    /** 整数の画像は {@code raw}、Parametric Map は実際の量の {@code values}（どちらか一方）。 */
    record Slice(byte[] raw, float[] values, int frame, double[] ipp, int instanceNumber, double slope,
            double intercept, Integer temporalPosition, Double acquisitionSeconds, Double frameReferenceTimeMs,
            Double triggerTimeMs) {
        Slice(byte[] raw, float[] values, int frame, double[] ipp, int instanceNumber, double slope, double intercept) {
            this(raw, values, frame, ipp, instanceNumber, slope, intercept, null, null, null, null);
        }
    }

    private final PixelCodec codec;
    private final List<Slice> slices = new ArrayList<>();
    private long rawBytes;
    private int rows = -1;
    private int cols = -1;
    private int bitsAllocated;
    private int bitsStored;
    private boolean signed;
    private double[] iop;
    private double[] pixelSpacing;
    private String modality;
    private String photometric;
    private String seriesUid;
    private String studyUid;
    private int multiFrameInstances;
    /** Parametric Map（float の値）か。1 本のボリュームに整数の画像と混ぜない。 */
    private Boolean floatValues;
    private String valueUnit;
    /** 先頭インスタンスの窓（Rescale 適用後の値の空間）。無ければ null。 */
    private double[] windowCenter;
    private double[] windowWidth;
    private String voiLutFunction;
    /** ImageType に MOSAIC を含む（Siemens のモザイク: 1 枚に多数のスライスがタイル状に入る。NIfTI では断る）。 */
    private boolean mosaic;
    /** 1 枚だけのシリーズで NIfTI の段差に使う値（SpacingBetweenSlices → SliceThickness）と出どころ。無ければ NaN。 */
    private double sliceStepMm = Double.NaN;
    private String sliceStepSource;

    VolumeAssembler(PixelCodec codec) {
        this.codec = codec;
    }

    /** 最初に npz にできなかった理由（匿名化は失敗をインスタンスごとに記録して続けるので、ここで覚える）。 */
    private String failure;

    String failure() {
        return failure;
    }

    @Override
    public void accept(Attributes ds, String tsuid) throws IOException {
        if (failure != null) {
            throw new UnsupportedLayout(failure); // 残りは伸長もしない
        }
        try {
            add(ds, tsuid);
        } catch (UnsupportedLayout e) {
            failure = e.getMessage();
            throw e;
        }
    }

    private void add(Attributes ds, String tsuid) throws IOException {
        if (org.dcm4che3.data.UID.ExplicitVRBigEndian.equals(tsuid)) {
            throw new UnsupportedLayout("npz-big-endian");
        }
        if (ParametricMapFrameExpander.handles(ds)) {
            addParametricMap(ds);
            return;
        }
        if (Boolean.TRUE.equals(floatValues)) {
            throw new UnsupportedLayout("npz-mixed-geometry");
        }
        floatValues = false;
        int r = ds.getInt(Tag.Rows, 0);
        int c = ds.getInt(Tag.Columns, 0);
        int spp = ds.getInt(Tag.SamplesPerPixel, 1);
        String pi = ds.getString(Tag.PhotometricInterpretation, "");
        int ba = ds.getInt(Tag.BitsAllocated, 0);
        if (spp != 1 || !pi.startsWith("MONOCHROME")) {
            throw new UnsupportedLayout("npz-not-grayscale");
        }
        if (ba != 8 && ba != 16 && ba != 32) {
            throw new UnsupportedLayout("npz-bits-" + ba);
        }
        if (rows < 0) {
            rows = r;
            cols = c;
            bitsAllocated = ba;
            bitsStored = ds.getInt(Tag.BitsStored, ba);
            signed = ds.getInt(Tag.PixelRepresentation, 0) == 1;
            iop = ds.getDoubles(Tag.ImageOrientationPatient);
            pixelSpacing = ds.getDoubles(Tag.PixelSpacing);
            modality = ds.getString(Tag.Modality);
            photometric = pi;
            seriesUid = ds.getString(Tag.SeriesInstanceUID);
            studyUid = ds.getString(Tag.StudyInstanceUID);
            valueUnit = ds.getString(Tag.RescaleType, "");
            readVoi(ds);
            if (ds.getDouble(Tag.SpacingBetweenSlices, 0) > 0) {
                sliceStepMm = ds.getDouble(Tag.SpacingBetweenSlices, 0);
                sliceStepSource = "SpacingBetweenSlices";
            } else if (ds.getDouble(Tag.SliceThickness, 0) > 0) {
                sliceStepMm = ds.getDouble(Tag.SliceThickness, 0);
                sliceStepSource = "SliceThickness";
            }
        } else if (r != rows || c != cols || ba != bitsAllocated) {
            throw new UnsupportedLayout("npz-mixed-geometry");
        }
        int frames = ds.getInt(Tag.NumberOfFrames, 1);
        if (frames > 1) {
            multiFrameInstances++;
        }
        String[] imageType = ds.getStrings(Tag.ImageType);
        if (imageType != null && java.util.Arrays.stream(imageType).anyMatch("MOSAIC"::equals)) {
            mosaic = true;
        }
        Integer temporal = firstInt(ds, Tag.TemporalPositionIdentifier, Tag.TemporalPositionIndex);
        Double acqSeconds = acquisitionSeconds(ds);
        // 動態 PET のフレーム時刻（ms）と心位相の TriggerTime（ms）。時相の鍵と時間間隔に使う
        Double frameRefMs = finiteOrNull(ds, Tag.FrameReferenceTime);
        Double triggerMs = finiteOrNull(ds, Tag.TriggerTime);
        byte[] all = PixelCodec.isUncompressed(tsuid) ? ds.getBytes(Tag.PixelData) : codec.decompress(ds, tsuid);
        int frameBytes = rows * cols * (ba / 8);
        if (all == null || all.length < (long) frameBytes * frames) {
            throw new UnsupportedLayout("npz-pixels-unreadable");
        }
        rawBytes += (long) frameBytes * frames;
        if (rawBytes > MAX_RAW_BYTES) {
            throw new UnsupportedLayout("npz-too-large");
        }
        double slope = ds.getDouble(Tag.RescaleSlope, 1.0);
        double intercept = ds.getDouble(Tag.RescaleIntercept, 0.0);
        double[] ipp = ds.getDoubles(Tag.ImagePositionPatient);
        int in = ds.getInt(Tag.InstanceNumber, 0);
        for (int f = 0; f < frames; f++) {
            byte[] one = frames == 1 && all.length == frameBytes ? all
                    : java.util.Arrays.copyOfRange(all, f * frameBytes, (f + 1) * frameBytes);
            slices.add(new Slice(one, null, f, frames == 1 ? ipp : null, in, slope, intercept, temporal, acqSeconds, frameRefMs, triggerMs));
        }
    }

    /**
     * 窓（WindowCenter/Width、多値は全部）と VOILUTFunction。Enhanced は共有の FrameVOILUTSequence の先頭項目。
     * 中心と幅の数が違う・片方が無いときは窓を持たない（片方だけでは窓にならない）。
     * 説明文（WindowCenterWidthExplanation）は自由文なので読まない。
     */
    private void readVoi(Attributes ds) {
        Attributes src = ds;
        if (!ds.containsValue(Tag.WindowCenter)) {
            Attributes shared = ds.getNestedDataset(Tag.SharedFunctionalGroupsSequence);
            Attributes voi = shared == null ? null : shared.getNestedDataset(Tag.FrameVOILUTSequence);
            if (voi != null) {
                src = voi;
            }
        }
        double[] wc = src.containsValue(Tag.WindowCenter) ? src.getDoubles(Tag.WindowCenter) : null;
        double[] ww = src.containsValue(Tag.WindowWidth) ? src.getDoubles(Tag.WindowWidth) : null;
        if (wc != null && ww != null && wc.length > 0 && wc.length == ww.length) {
            windowCenter = wc;
            windowWidth = ww;
            voiLutFunction = src.getString(Tag.VOILUTFunction);
        }
    }

    /** Parametric Map: フレームごとに実際の量（float）と位置（フレームごとの PlanePosition）を積む。 */
    private void addParametricMap(Attributes ds) throws IOException {
        if (Boolean.FALSE.equals(floatValues)) {
            throw new UnsupportedLayout("npz-mixed-geometry");
        }
        int r = ds.getInt(Tag.Rows, 0);
        int c = ds.getInt(Tag.Columns, 0);
        if (rows < 0) {
            floatValues = true;
            rows = r;
            cols = c;
            bitsAllocated = 32;
            bitsStored = 32;
            signed = true;
            iop = com.vis.graphynext.dicom.ConfocalGeometry.orientation(ds);
            pixelSpacing = SegFrameExpander.sharedPixelSpacing(ds);
            modality = ds.getString(Tag.Modality);
            photometric = ds.getString(Tag.PhotometricInterpretation, "MONOCHROME2");
            seriesUid = ds.getString(Tag.SeriesInstanceUID);
            studyUid = ds.getString(Tag.StudyInstanceUID);
            valueUnit = ParametricMapFrameExpander.unitOfFrame(ds, 0);
        } else if (r != rows || c != cols) {
            throw new UnsupportedLayout("npz-mixed-geometry");
        }
        int frames = Math.max(1, ds.getInt(Tag.NumberOfFrames, 1));
        rawBytes += (long) rows * cols * 4 * frames;
        if (rawBytes > MAX_RAW_BYTES) {
            throw new UnsupportedLayout("npz-too-large");
        }
        int in = ds.getInt(Tag.InstanceNumber, 0);
        for (int f = 0; f < frames; f++) {
            float[] v = ParametricMapFrameExpander.frameValues(ds, f);
            if (v == null) {
                throw new UnsupportedLayout("npz-pixels-unreadable");
            }
            slices.add(new Slice(null, v, f, com.vis.graphynext.dicom.ConfocalGeometry.framePosition(ds, f), in, 1.0, 0.0));
        }
    }

    int sliceCount() {
        return slices.size();
    }

    /** 並べ替えと幾何の組み立ての結果（npz・NIfTI で共有。画素はまだ書かない）。 */
    record Assembled(List<Slice> sorted, String order, boolean spatial, double dz, double[] origin, double dy,
            double dx, double[] direction, double[] normal, int phases, double dtSeconds, String timeKey) {
        /** 3D（時相 1）。{@code sorted} は z の昇順。4D のときは時相ごとに z の昇順を並べた t の昇順（t が最も遅い）。 */
        Assembled(List<Slice> sorted, String order, boolean spatial, double dz, double[] origin, double dy, double dx,
                double[] direction, double[] normal) {
            this(sorted, order, spatial, dz, origin, dy, dx, direction, normal, 1, Double.NaN, null);
        }
    }

    /**
     * 並べ替え・間隔の検査・origin/direction の計算。npz・NIfTI の両方がこの結果を使う。
     *
     * @throws UnsupportedLayout 空・混在・重複位置・不等間隔など、1 本の格子にできない形
     */
    Assembled assemble() throws IOException {
        if (slices.isEmpty()) {
            throw new UnsupportedLayout("npz-empty");
        }
        if (multiFrameInstances > 0 && slices.size() != slices.stream().filter(s -> s.ipp() == null).count()) {
            throw new UnsupportedLayout("npz-mixed-frames");
        }
        if (multiFrameInstances > 1) {
            throw new UnsupportedLayout("npz-multiple-multiframe"); // 複数の多フレームは並べ方が決まらない
        }
        double[] normal = normal();
        boolean spatial = normal != null && slices.stream().allMatch(s -> s.ipp() != null && s.ipp().length == 3);
        List<Slice> sorted = new ArrayList<>(slices);
        String order;
        if (spatial) {
            sorted.sort(Comparator.comparingDouble(s -> dot(s.ipp(), normal)));
            order = "position";
        } else if (multiFrameInstances == 1) {
            order = "frame";
        } else {
            sorted.sort(Comparator.comparingInt(Slice::instanceNumber));
            order = "instance-number";
        }

        double dz = Double.NaN;
        double[] origin = {Double.NaN, Double.NaN, Double.NaN};
        if (spatial) {
            origin = sorted.get(0).ipp().clone();
            if (sorted.size() > 1) {
                double[] d = new double[sorted.size() - 1];
                for (int i = 1; i < sorted.size(); i++) {
                    d[i - 1] = dot(sorted.get(i).ipp(), normal) - dot(sorted.get(i - 1).ipp(), normal);
                }
                double[] sortedGaps = d.clone();
                java.util.Arrays.sort(sortedGaps);
                dz = sortedGaps[sortedGaps.length / 2];
                // 🔴 npz は「k 枚目は origin + k·dz」という格子なので、間隔が揃っていないと幾何が嘘になる。
                // 同じ位置に 2 枚（撮影が 2 回ぶん混ざったシリーズ。どちらを残すかは決められない）や
                // 欠けたスライスは断る（dicom-zip なら送れる）。実例: ct-basic の C-A-P（66 枚・28 か所で重複）
                double tol = Math.max(0.01, 0.01 * Math.abs(dz));
                for (double g : d) {
                    if (g < tol) {
                        throw new UnsupportedLayout("npz-duplicate-positions");
                    }
                    if (Math.abs(g - dz) > tol) {
                        throw new UnsupportedLayout("npz-uneven-spacing");
                    }
                }
            }
        }
        double dy = pixelSpacing != null && pixelSpacing.length == 2 ? pixelSpacing[0] : Double.NaN;
        double dx = pixelSpacing != null && pixelSpacing.length == 2 ? pixelSpacing[1] : Double.NaN;
        double[] direction = new double[9];
        java.util.Arrays.fill(direction, Double.NaN);
        if (normal != null) {
            System.arraycopy(iop, 0, direction, 0, 3);  // x 軸（列が増える向き）
            System.arraycopy(iop, 3, direction, 3, 3);  // y 軸（行が増える向き）
            System.arraycopy(normal, 0, direction, 6, 3);
        }
        return new Assembled(sorted, order, spatial, dz, origin, dy, dx, direction, normal);
    }

    private static Integer firstInt(Attributes ds, int... tags) {
        for (int t : tags) {
            if (ds.containsValue(t)) {
                return ds.getInt(t, 0);
            }
        }
        return null;
    }

    /** 数値の欄の値。無い・読めないときは null（0 や NaN で埋めない）。 */
    private static Double finiteOrNull(Attributes ds, int tag) {
        if (!ds.containsValue(tag)) {
            return null;
        }
        double v = ds.getDouble(tag, Double.NaN);
        return Double.isFinite(v) ? v : null;
    }

    /** AcquisitionTime（HHMMSS.FFFFFF）の秒。無い・読めないときは null（日付は見ない。時相の間隔は同じ日の中だけ）。 */
    private static Double acquisitionSeconds(Attributes ds) {
        String t = ds.getString(Tag.AcquisitionTime);
        if (t == null || t.length() < 6) {
            return null;
        }
        try {
            return Integer.parseInt(t.substring(0, 2)) * 3600.0 + Integer.parseInt(t.substring(2, 4)) * 60.0
                    + Double.parseDouble(t.substring(4));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** 時相の鍵の名前（{@code assemble4d} の鍵の順と同じ）。 */
    private static final String[] PHASE_KEY_NAMES = {"TemporalPosition", "FrameReferenceTime", "TriggerTime", "AcquisitionTime"};
    /** 時相 t の鍵の値が位置の間で「同じ」とみなす差（ms の浮動小数の丸め）。 */
    private static final double PHASE_KEY_TOLERANCE = 1e-6;

    /**
     * NIfTI 用の並べ方。3D は {@link #assemble()} と同じ。同じ位置に同じ枚数ずつ（T &gt; 1）あれば、時相として並べる。
     *
     * <p>時相の鍵は、全インスタンスが持つ最初のもの（TemporalPosition → FrameReferenceTime → TriggerTime → AcquisitionTime）で、
     * 位置の中で昇順・重複なしになるものを使う。InstanceNumber だけでは決めない（{@code nifti-ambiguous-phases}）。**モザイク（1 枚に多数のスライス）は、位置が 1 つ・時相が多数に見えて黙って誤った幾何になる**ので
     * 3D・4D とも断る。
     *
     * @throws UnsupportedLayout {@code nifti-mosaic}・{@code nifti-uneven-phases}・{@code nifti-ambiguous-phases} ほか
     */
    Assembled assemble4d() throws IOException {
        if (mosaic) {
            throw new UnsupportedLayout("nifti-mosaic");
        }
        double[] normal = normal();
        boolean spatial = !slices.isEmpty() && normal != null && multiFrameInstances == 0
                && slices.stream().allMatch(s -> s.ipp() != null && s.ipp().length == 3);
        if (!spatial) {
            return assemble();
        }
        List<Slice> byPos = new ArrayList<>(slices);
        byPos.sort(Comparator.comparingDouble(s -> dot(s.ipp(), normal)));
        // 位置でまとめる（同じ位置 = 法線方向の差が 0.01 mm 以内）
        List<List<Slice>> groups = new ArrayList<>();
        double last = Double.NaN;
        for (Slice s : byPos) {
            double d = dot(s.ipp(), normal);
            if (groups.isEmpty() || d - last > 0.01) {
                groups.add(new ArrayList<>());
            }
            groups.get(groups.size() - 1).add(s);
            last = d;
        }
        int t = groups.get(0).size();
        if (t == 1 && groups.size() == slices.size()) {
            return assemble();
        }
        for (List<Slice> g : groups) {
            if (g.size() != t) {
                throw new UnsupportedLayout("nifti-uneven-phases");
            }
        }
        // 位置の間隔（3D と同じ検査。各位置の先頭の位置で見る）
        if (groups.size() > 1) {
            double[] gaps = new double[groups.size() - 1];
            for (int i = 1; i < groups.size(); i++) {
                gaps[i - 1] = dot(groups.get(i).get(0).ipp(), normal) - dot(groups.get(i - 1).get(0).ipp(), normal);
            }
            double[] sg = gaps.clone();
            java.util.Arrays.sort(sg);
            double dz = sg[sg.length / 2];
            double tol = Math.max(0.01, 0.01 * Math.abs(dz));
            for (double g : gaps) {
                if (Math.abs(g - dz) > tol) {
                    throw new UnsupportedLayout("npz-uneven-spacing");
                }
            }
        }
        // 時相の鍵: 全インスタンスが持ち、各位置の中で昇順・重複なしになる最初のもの。
        // 順は TemporalPosition → FrameReferenceTime → TriggerTime → AcquisitionTime。
        //   FrameReferenceTime は動態のフレーム時刻そのもの、TriggerTime は心位相、AcquisitionTime は実時間
        //   （スライスごとにずれる・セグメント化した撮像では位置の中で単調にならないことがある）なので最後。
        // 🔴 InstanceNumber は鍵にしない。撮影順の番号に過ぎず、どれが時相 0 かの根拠が無い
        //    （手がかりの無い 2 回分の撮影が各位置に 2 枚ずつ混ざったシリーズを、黙って 4D にしてしまう）。
        String key = null;
        int keyIndex = -1;
        List<java.util.function.Function<Slice, Double>> keys = List.of(
                s -> s.temporalPosition() == null ? null : (double) s.temporalPosition(),
                Slice::frameReferenceTimeMs,
                Slice::triggerTimeMs,
                Slice::acquisitionSeconds);
        for (int ki = 0; ki < keys.size() && key == null; ki++) {
            var f = keys.get(ki);
            boolean usable = slices.stream().allMatch(s -> f.apply(s) != null);
            if (usable) {
                for (List<Slice> g : groups) {
                    g.sort(Comparator.comparingDouble(s -> f.apply(s)));
                    for (int i = 1; i < g.size() && usable; i++) {
                        usable = f.apply(g.get(i)) > f.apply(g.get(i - 1));
                    }
                }
            }
            // 時相 t の値は、どの位置でも同じでなければ時相を決められない（AcquisitionTime はスライスごとにずれるので対象外）
            if (usable && ki <= 2) {
                for (List<Slice> g : groups) {
                    for (int i = 0; i < t && usable; i++) {
                        usable = Math.abs(f.apply(g.get(i)) - f.apply(groups.get(0).get(i))) <= PHASE_KEY_TOLERANCE;
                    }
                }
            }
            if (usable) {
                key = PHASE_KEY_NAMES[ki];
                keyIndex = ki;
            }
        }
        if (key == null) {
            throw new UnsupportedLayout("nifti-ambiguous-phases");
        }
        List<Slice> sorted = new ArrayList<>(slices.size());
        for (int ti = 0; ti < t; ti++) {
            for (List<Slice> g : groups) {
                sorted.add(g.get(ti));
            }
        }
        // 時相の間隔（秒）: 時刻の鍵（FrameReferenceTime・TriggerTime・AcquisitionTime）が全部にあり、先頭の位置の時相ごとの差が
        // 均等（中央値の 1% 以内）のときだけ。時相の順を決めたのが時刻の鍵ならそれを、TemporalPosition が鍵のときは
        // FrameReferenceTime → TriggerTime → AcquisitionTime の最初に全部が持つものを使う。決まらなければ NaN（推測で埋めない）
        double dt = Double.NaN;
        if (t > 1) {
            List<java.util.function.Function<Slice, Double>> seconds = List.of(
                    s -> s.frameReferenceTimeMs() == null ? null : s.frameReferenceTimeMs() / 1000.0,
                    s -> s.triggerTimeMs() == null ? null : s.triggerTimeMs() / 1000.0,
                    Slice::acquisitionSeconds);
            int from = keyIndex >= 1 ? keyIndex - 1 : 0;
            int to = keyIndex >= 1 ? keyIndex : seconds.size() - 1;
            for (int si = from; si <= to && Double.isNaN(dt); si++) {
                var f = seconds.get(si);
                if (!slices.stream().allMatch(s -> f.apply(s) != null)) {
                    continue;
                }
                double[] diffs = new double[t - 1];
                for (int i = 1; i < t; i++) {
                    diffs[i - 1] = f.apply(groups.get(0).get(i)) - f.apply(groups.get(0).get(i - 1));
                }
                double[] sd = diffs.clone();
                java.util.Arrays.sort(sd);
                double med = sd[sd.length / 2];
                boolean even = med > 0;
                for (double d : diffs) {
                    even = even && Math.abs(d - med) <= 0.01 * med;
                }
                if (even) {
                    dt = med;
                }
            }
        }
        double dy = pixelSpacing != null && pixelSpacing.length == 2 ? pixelSpacing[0] : Double.NaN;
        double dx = pixelSpacing != null && pixelSpacing.length == 2 ? pixelSpacing[1] : Double.NaN;
        double[] direction = new double[9];
        System.arraycopy(iop, 0, direction, 0, 3);
        System.arraycopy(iop, 3, direction, 3, 3);
        System.arraycopy(normal, 0, direction, 6, 3);
        return new Assembled(sorted, "position+" + key, true, Double.NaN, groups.get(0).get(0).ipp().clone(), dy, dx, direction,
                normal, t, dt, key);
    }

    /** npz を書く。 */
    void writeNpz(OutputStream out, ObjectMapper mapper) throws IOException {
        Assembled asm = assemble();
        List<Slice> sorted = asm.sorted();
        String order = asm.order();
        double dz = asm.dz();
        double[] origin = asm.origin();
        double dy = asm.dy();
        double dx = asm.dx();
        double[] direction = asm.direction();

        ZipOutputStream zip = new ZipOutputStream(out);
        zip.putNextEntry(new ZipEntry("volume.npy"));
        NpyWriter.writeHeader(zip, "<f4", sorted.size(), rows, cols);
        ByteBuffer buf = ByteBuffer.allocate(rows * cols * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (Slice s : sorted) {
            buf.clear();
            writeFloats(s, buf);
            zip.write(buf.array(), 0, buf.position());
        }
        zip.closeEntry();
        zip.putNextEntry(new ZipEntry("spacing.npy"));
        NpyWriter.writeFloat64(zip, new double[]{dz, dy, dx}, 3);
        zip.closeEntry();
        zip.putNextEntry(new ZipEntry("origin.npy"));
        NpyWriter.writeFloat64(zip, origin, 3);
        zip.closeEntry();
        zip.putNextEntry(new ZipEntry("direction.npy"));
        NpyWriter.writeFloat64(zip, direction, 3, 3);
        zip.closeEntry();

        ObjectNode meta = mapper.createObjectNode()
                .put("format", "graphy-npz/1")
                .put("axes", "volume[z, y, x]; origin/direction in patient LPS mm")
                .put("modality", modality)
                .put("photometricInterpretation", photometric)
                .put("bitsStored", bitsStored)
                .put("signed", signed)
                .put("float", Boolean.TRUE.equals(floatValues))
                .put("valueUnit", valueUnit == null ? "" : valueUnit)
                .put("order", order)
                .put("slices", sorted.size())
                .put("anonymizedStudyInstanceUid", studyUid)
                .put("anonymizedSeriesInstanceUid", seriesUid);
        if (windowCenter != null) {
            var wc = meta.putArray("windowCenter");
            java.util.Arrays.stream(windowCenter).forEach(wc::add);
            var ww = meta.putArray("windowWidth");
            java.util.Arrays.stream(windowWidth).forEach(ww::add);
            if (voiLutFunction != null && !voiLutFunction.isBlank()) {
                meta.put("voiLutFunction", voiLutFunction);
            }
        }
        zip.putNextEntry(new ZipEntry("meta.json"));
        zip.write(mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(meta));
        zip.closeEntry();
        zip.finish();
    }

    int rows() { return rows; }
    int cols() { return cols; }
    String modality() { return modality; }
    String valueUnit() { return valueUnit; }
    double[] windowCenter() { return windowCenter; }
    double[] windowWidth() { return windowWidth; }
    double sliceStepMm() { return sliceStepMm; }
    String sliceStepSource() { return sliceStepSource; }
    double[] iop() { return iop; }

    /** 1 枚ぶんを Rescale 適用後の float32（リトルエンディアン）で {@code out} に積む。 */
    void putFloats(Slice s, ByteBuffer out) {
        writeFloats(s, out);
    }

    private void writeFloats(Slice s, ByteBuffer out) {
        if (s.values() != null) {
            for (float v : s.values()) {
                out.putFloat(v);
            }
            return;
        }
        ByteBuffer in = ByteBuffer.wrap(s.raw()).order(ByteOrder.LITTLE_ENDIAN);
        int n = rows * cols;
        int shift = 32 - bitsStored;
        long mask = bitsStored >= 32 ? 0xffffffffL : (1L << bitsStored) - 1;
        for (int i = 0; i < n; i++) {
            long raw = switch (bitsAllocated) {
                case 8 -> in.get() & 0xff;
                case 16 -> in.getShort() & 0xffff;
                default -> in.getInt() & 0xffffffffL;
            };
            double v;
            if (signed) {
                v = ((int) (raw << shift)) >> shift; // BitsStored の符号ビットから符号拡張
            } else {
                v = raw & mask;
            }
            out.putFloat((float) (v * s.slope() + s.intercept()));
        }
    }

    private double[] normal() {
        if (iop == null || iop.length != 6) {
            return null;
        }
        double[] n = {
                iop[1] * iop[5] - iop[2] * iop[4],
                iop[2] * iop[3] - iop[0] * iop[5],
                iop[0] * iop[4] - iop[1] * iop[3]};
        double len = Math.sqrt(dot(n, n));
        if (len < 1e-6) {
            return null;
        }
        return new double[]{n[0] / len, n[1] / len, n[2] / len};
    }

    private static double dot(double[] a, double[] b) {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }

    /** npz にできない形（dicom-zip なら送れる）。{@link #getMessage()} が理由のコード。 */
    static final class UnsupportedLayout extends IOException {
        UnsupportedLayout(String code) {
            super(code);
        }
    }
}

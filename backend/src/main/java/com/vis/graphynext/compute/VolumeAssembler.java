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
 *   <li>{@code meta.json}: モダリティ・光度解釈・匿名化後の UID・並べ方・値の単位（{@code numpy.load} では bytes で読める）</li>
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
    private record Slice(byte[] raw, float[] values, int frame, double[] ipp, int instanceNumber, double slope,
            double intercept) {
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
        if (ParametricMapFrameExpander.isParametricMap(ds)) {
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
        } else if (r != rows || c != cols || ba != bitsAllocated) {
            throw new UnsupportedLayout("npz-mixed-geometry");
        }
        int frames = ds.getInt(Tag.NumberOfFrames, 1);
        if (frames > 1) {
            multiFrameInstances++;
        }
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
            slices.add(new Slice(one, null, f, frames == 1 ? ipp : null, in, slope, intercept));
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
            iop = SegFrameExpander.sharedIop(ds);
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
            slices.add(new Slice(null, v, f, SegFrameExpander.perFrameIpp(ds, f), in, 1.0, 0.0));
        }
    }

    int sliceCount() {
        return slices.size();
    }

    /** npz を書く。 */
    void writeNpz(OutputStream out, ObjectMapper mapper) throws IOException {
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
        zip.putNextEntry(new ZipEntry("meta.json"));
        zip.write(mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(meta));
        zip.closeEntry();
        zip.finish();
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

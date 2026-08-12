/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Map;
import java.util.zip.GZIPInputStream;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;

/**
 * NIfTI（.nii / .nii.gz）→ DICOM Part-10 への変換。
 *
 * <p>Swing 版 GRAPHY の {@code NIfTIToDicomConverter} の移植。方針も同じ:
 * <ul>
 *   <li>4D/5D は <b>Z=スライス・T=時相・C=チャネル</b>に展開して 1 フレーム 1 インスタンスにする。
 *       時相は {@code TemporalPositionIndex} と {@code TriggerTime} に入れる（本体の ZCT 判定が
 *       "Temporal" / "Trigger" を見るため）。</li>
 *   <li>幾何は {@link NiftiGeometry}（sform → qform → pixdim）。</li>
 *   <li>サイドカー JSON は {@link NiftiMetadataMapper} で属性へ写す。</li>
 * </ul>
 *
 * <p><b>浮動小数・32bit 整数は 16bit へ量子化</b>し、Rescale Slope/Intercept で元の値域に戻せる形にする
 * （標準の画像 IOD が 8/16bit しか持てないため）。量子化係数は NIfTI の scl_slope / scl_inter と合成する。
 */
public final class NiftiToDicom {

    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("yyyyMMdd");

    /** 変換の入力。UID や患者情報は呼び出し側（＝ユーザー入力）が決める。 */
    public record Options(
            String modality,
            String patientId,
            String patientName,
            String patientBirthDate,
            String patientSex,
            String studyDate,
            String studyDescription,
            String seriesDescription,
            int seriesNumber,
            String studyInstanceUid,
            String seriesInstanceUid,
            Map<String, Object> metadata) {
    }

    /** 変換結果の要約。 */
    public record Summary(
            int instances, int slices, int phases, int channels,
            int rows, int columns,
            String geometrySource, boolean geometrySynthesized,
            String studyInstanceUid, String seriesInstanceUid,
            int metadataApplied, String pixelConversion,
            /** アフィンのスケールが pixdim と食い違い、pixdim を採ったときの説明（無ければ null）。 */
            String spacingNote) {
    }

    /** フレーム 1 枚ごとに呼ばれる出力先（ファイルへ書く / そのまま取り込む）。 */
    public interface FrameSink {
        void accept(Attributes dataset, String transferSyntaxUid) throws IOException;
    }

    private NiftiToDicom() {
    }

    /** ヘッダだけを読む（対応可否の判定や事前表示に使う）。 */
    public static NiftiHeader readHeader(Path file) throws IOException {
        try (InputStream in = open(file)) {
            byte[] head = in.readNBytes(NiftiHeader.NIFTI2_HEADER_SIZE);
            return NiftiHeader.parse(head);
        }
    }

    /** gzip かどうかをマジックで判定して開く（拡張子には頼らない）。 */
    static InputStream open(Path file) throws IOException {
        byte[] magic = new byte[2];
        try (InputStream probe = Files.newInputStream(file)) {
            if (probe.read(magic) != 2) {
                throw new IOException("ファイルが短すぎます: " + file);
            }
        }
        InputStream raw = Files.newInputStream(file);
        boolean gzip = (magic[0] & 0xFF) == 0x1F && (magic[1] & 0xFF) == 0x8B;
        return gzip ? new GZIPInputStream(raw, 1 << 16) : raw;
    }

    /**
     * 変換して 1 フレームずつ {@code sink} へ渡す。
     *
     * @param file  .nii / .nii.gz
     * @param opts  患者・スタディ情報など
     * @param sink  出力先
     */
    public static Summary convert(Path file, Options opts, FrameSink sink) throws IOException {
        NiftiHeader h = readHeader(file);
        NiftiGeometry geom = NiftiGeometry.of(h);

        int nx = h.nx();
        int ny = h.ny();
        int nz = h.nz();
        int nt = h.nt();
        int nc = h.nc();
        PixelSpec spec = PixelSpec.of(h);
        if (spec.quantizes()) {
            // **量子化係数はボリューム全体で 1 つ**にする。フレームごとに決めると、
            // スライスごとに Rescale が変わって同じ値が別の意味になる（3D・定量で破綻する）。
            spec.calibrateGlobally(file, h);
        }

        String studyUid = blankToNull(opts.studyInstanceUid()) != null ? opts.studyInstanceUid() : UIDUtils.createUID();
        String seriesUid = blankToNull(opts.seriesInstanceUid()) != null ? opts.seriesInstanceUid() : UIDUtils.createUID();
        String frameOfRef = UIDUtils.createUID();
        String sopClass = sopClassOf(opts.modality());
        String studyDate = blankToNull(opts.studyDate()) != null
                ? opts.studyDate()
                : LocalDate.now().format(DATE);

        long frameVoxels = (long) nx * ny;
        int bytesPerVoxel = h.bytesPerVoxel();
        long frameBytes = frameVoxels * bytesPerVoxel;
        if (frameBytes > Integer.MAX_VALUE) {
            throw new IOException("1 フレームが大きすぎます: " + frameBytes + " バイト");
        }

        int metaApplied = 0;
        int instance = 1;
        try (InputStream in = open(file)) {
            skipFully(in, h.voxOffset);
            // NIfTI は x が最速 → z → t → c の順で並ぶ。読み進めながら 1 フレームずつ出す。
            for (int c = 0; c < nc; c++) {
                for (int t = 0; t < nt; t++) {
                    for (int z = 0; z < nz; z++) {
                        byte[] raw = in.readNBytes((int) frameBytes);
                        if (raw.length < frameBytes) {
                            throw new IOException("画素データが足りません（スライス " + z + " / 時相 " + t + "）");
                        }
                        short[] pixels = spec.toPixels(raw, h.byteOrder, (int) frameVoxels);
                        if (geom.flipRows) {
                            flipRows(pixels, nx, ny, spec.samplesPerPixel);
                        }
                        Attributes ds = baseDataset(h, geom, opts, spec, studyUid, seriesUid, frameOfRef,
                                sopClass, studyDate, z, t, c, instance, nx, ny, nt);
                        metaApplied = NiftiMetadataMapper.apply(ds, opts.metadata());
                        ds.setBytes(Tag.PixelData, spec.samplesPerPixel == 3 || spec.bitsAllocated == 8 ? VR.OB : VR.OW,
                                toBytes(pixels, spec));
                        sink.accept(ds, UID.ExplicitVRLittleEndian);
                        instance++;
                    }
                }
            }
        }
        return new Summary(instance - 1, nz, nt, nc, ny, nx,
                geom.source, geom.synthesized, studyUid, seriesUid, metaApplied, spec.description,
                geom.spacingNote);
    }

    /** ファイルへ書き出す sink。 */
    public static FrameSink toFiles(Path dir) {
        int[] n = { 0 };
        return (ds, tsuid) -> {
            Files.createDirectories(dir);
            Path out = dir.resolve(String.format("nifti-%05d.dcm", ++n[0]));
            Attributes fmi = ds.createFileMetaInformation(tsuid);
            try (DicomOutputStream dos = new DicomOutputStream(out.toFile())) {
                dos.writeDataset(fmi, ds);
            }
        };
    }

    private static Attributes baseDataset(NiftiHeader h, NiftiGeometry geom, Options opts, PixelSpec spec,
            String studyUid, String seriesUid, String frameOfRef, String sopClass, String studyDate,
            int z, int t, int c, int instance, int nx, int ny, int nt) {
        Attributes ds = new Attributes();
        ds.setString(Tag.SpecificCharacterSet, VR.CS, "ISO_IR 192");
        ds.setString(Tag.SOPClassUID, VR.UI, sopClass);
        ds.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        ds.setString(Tag.StudyInstanceUID, VR.UI, studyUid);
        ds.setString(Tag.SeriesInstanceUID, VR.UI, seriesUid);
        ds.setString(Tag.FrameOfReferenceUID, VR.UI, frameOfRef);
        ds.setString(Tag.Modality, VR.CS, opts.modality() == null ? "MR" : opts.modality());

        ds.setString(Tag.PatientID, VR.LO, nvl(opts.patientId(), "NIFTI"));
        ds.setString(Tag.PatientName, VR.PN, nvl(opts.patientName(), nvl(opts.patientId(), "NIFTI")));
        ds.setString(Tag.PatientBirthDate, VR.DA, nvl(opts.patientBirthDate(), ""));
        ds.setString(Tag.PatientSex, VR.CS, nvl(opts.patientSex(), ""));
        ds.setString(Tag.StudyDate, VR.DA, studyDate);
        ds.setString(Tag.SeriesDate, VR.DA, studyDate);
        ds.setString(Tag.StudyDescription, VR.LO, nvl(opts.studyDescription(), "Imported from NIfTI"));
        ds.setString(Tag.SeriesDescription, VR.LO,
                nvl(opts.seriesDescription(), h.description.isBlank() ? "NIfTI" : h.description));
        ds.setInt(Tag.SeriesNumber, VR.IS, opts.seriesNumber() > 0 ? opts.seriesNumber() : 1);
        ds.setInt(Tag.InstanceNumber, VR.IS, instance);
        ds.setString(Tag.ConversionType, VR.CS, "WSD"); // Workstation で作られた画像
        ds.setString(Tag.DerivationDescription, VR.ST,
                "Converted from NIfTI (geometry from " + geom.source + (geom.synthesized ? ", SYNTHESIZED" : "") + ")");

        // --- 幾何 ---
        double[] ipp = geom.positionOf(z);
        ds.setDouble(Tag.ImagePositionPatient, VR.DS, ipp);
        ds.setDouble(Tag.ImageOrientationPatient, VR.DS, geom.iop);
        ds.setDouble(Tag.PixelSpacing, VR.DS, h.spacingY() * h.spatialUnitToMm(), h.spacingX() * h.spatialUnitToMm());
        // ※ PixelSpacing は pixdim 由来。幾何側もスケールが食い違えば pixdim に合わせるので
        //   （NiftiGeometry の spacingFromPixdim）、面内とスライス方向で源が割れることはない。
        ds.setDouble(Tag.SliceThickness, VR.DS, geom.sliceSpacing());
        ds.setDouble(Tag.SpacingBetweenSlices, VR.DS, geom.sliceSpacing());
        ds.setDouble(Tag.SliceLocation, VR.DS, geom.sliceSpacing() * z);
        if (geom.synthesized) {
            // 「向きは合成」であることを画像自身に残す（後から見た人が誤解しないため）
            ds.setString(Tag.ImageComments, VR.LT,
                    "Geometry synthesized: NIfTI had qform_code=sform_code=0 (orientation is NOT from the source)");
        }

        // --- 時相（T）・チャネル（C）---
        if (nt > 1) {
            ds.setInt(Tag.TemporalPositionIndex, VR.UL, t + 1);
            ds.setInt(Tag.NumberOfTemporalPositions, VR.IS, nt);
            double trSec = h.pixdim[4] > 0 ? h.pixdim[4] : 0;
            if (trSec > 0) {
                // pixdim[4] は 1 時相あたりの間隔（既定は秒）
                ds.setDouble(Tag.TriggerTime, VR.DS, trSec * 1000.0 * t);
            } else {
                ds.setDouble(Tag.TriggerTime, VR.DS, (double) t);
            }
        }
        if (h.nc() > 1) {
            ds.setInt(Tag.AcquisitionNumber, VR.IS, c + 1);
        }

        // --- 画素属性 ---
        ds.setInt(Tag.SamplesPerPixel, VR.US, spec.samplesPerPixel);
        ds.setString(Tag.PhotometricInterpretation, VR.CS, spec.samplesPerPixel == 3 ? "RGB" : "MONOCHROME2");
        if (spec.samplesPerPixel == 3) {
            ds.setInt(Tag.PlanarConfiguration, VR.US, 0);
        }
        ds.setInt(Tag.Rows, VR.US, ny);
        ds.setInt(Tag.Columns, VR.US, nx);
        ds.setInt(Tag.BitsAllocated, VR.US, spec.bitsAllocated);
        ds.setInt(Tag.BitsStored, VR.US, spec.bitsAllocated);
        ds.setInt(Tag.HighBit, VR.US, spec.bitsAllocated - 1);
        ds.setInt(Tag.PixelRepresentation, VR.US, spec.signed ? 1 : 0);
        if (spec.samplesPerPixel == 1) {
            ds.setDouble(Tag.RescaleSlope, VR.DS, spec.rescaleSlope);
            ds.setDouble(Tag.RescaleIntercept, VR.DS, spec.rescaleIntercept);
        }
        return ds;
    }

    private static void flipRows(short[] pixels, int cols, int rows, int samples) {
        int stride = cols * samples;
        short[] tmp = new short[stride];
        for (int y = 0; y < rows / 2; y++) {
            int top = y * stride;
            int bottom = (rows - 1 - y) * stride;
            System.arraycopy(pixels, top, tmp, 0, stride);
            System.arraycopy(pixels, bottom, pixels, top, stride);
            System.arraycopy(tmp, 0, pixels, bottom, stride);
        }
    }

    private static byte[] toBytes(short[] pixels, PixelSpec spec) {
        if (spec.bitsAllocated == 8) {
            byte[] out = new byte[pixels.length + (pixels.length & 1)]; // 偶数長にする
            for (int i = 0; i < pixels.length; i++) {
                out[i] = (byte) pixels[i];
            }
            return out;
        }
        ByteBuffer buf = ByteBuffer.allocate(pixels.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (short p : pixels) {
            buf.putShort(p);
        }
        return buf.array();
    }

    private static void skipFully(InputStream in, long n) throws IOException {
        long remaining = n;
        byte[] scratch = new byte[1 << 16];
        while (remaining > 0) {
            int want = (int) Math.min(scratch.length, remaining);
            int read = in.read(scratch, 0, want);
            if (read < 0) {
                throw new IOException("画素データの開始位置まで読めません（vox_offset=" + n + "）");
            }
            remaining -= read;
        }
    }

    static String sopClassOf(String modality) {
        if (modality == null) {
            return UID.MRImageStorage;
        }
        return switch (modality.toUpperCase()) {
            case "CT" -> UID.CTImageStorage;
            case "PT" -> UID.PositronEmissionTomographyImageStorage;
            case "NM", "ST" -> UID.NuclearMedicineImageStorage;
            case "US" -> UID.UltrasoundImageStorage;
            default -> UID.MRImageStorage;
        };
    }

    private static String nvl(String v, String fallback) {
        return v == null || v.isBlank() ? fallback : v;
    }

    private static String blankToNull(String v) {
        return v == null || v.isBlank() ? null : v;
    }

    /**
     * NIfTI のデータ型 → DICOM の画素表現。
     *
     * <p>32bit 以上（float / int32 / double）は 16bit へ量子化し、Rescale で元の値へ戻せるようにする。
     * <b>量子化は「値域を 16bit に収める」だけで情報を作らない</b>（元の分解能は落ちる）。
     */
    static final class PixelSpec {
        final int datatype;
        final int bitsAllocated;
        final boolean signed;
        final int samplesPerPixel;
        double rescaleSlope;
        double rescaleIntercept;
        final String description;
        /** NIfTI 側のスケーリング（scl_slope / scl_inter）。 */
        private final double sclSlope;
        private final double sclInter;

        private PixelSpec(int datatype, int bitsAllocated, boolean signed, int samplesPerPixel,
                double sclSlope, double sclInter, String description) {
            this.datatype = datatype;
            this.bitsAllocated = bitsAllocated;
            this.signed = signed;
            this.samplesPerPixel = samplesPerPixel;
            this.sclSlope = sclSlope;
            this.sclInter = sclInter;
            this.rescaleSlope = sclSlope;
            this.rescaleIntercept = sclInter;
            this.description = description;
        }

        static PixelSpec of(NiftiHeader h) throws IOException {
            return switch (h.datatype) {
                case NiftiHeader.DT_UINT8 ->
                    new PixelSpec(h.datatype, 8, false, 1, h.sclSlope, h.sclInter, "uint8 → 8bit");
                case NiftiHeader.DT_INT8 ->
                    new PixelSpec(h.datatype, 16, true, 1, h.sclSlope, h.sclInter, "int8 → 16bit signed");
                case NiftiHeader.DT_INT16 ->
                    new PixelSpec(h.datatype, 16, true, 1, h.sclSlope, h.sclInter, "int16 → 16bit signed");
                case NiftiHeader.DT_UINT16 ->
                    new PixelSpec(h.datatype, 16, false, 1, h.sclSlope, h.sclInter, "uint16 → 16bit unsigned");
                case NiftiHeader.DT_RGB24 ->
                    new PixelSpec(h.datatype, 8, false, 3, 1, 0, "RGB24 → 8bit RGB");
                case NiftiHeader.DT_FLOAT32, NiftiHeader.DT_INT32, NiftiHeader.DT_UINT32, NiftiHeader.DT_FLOAT64 ->
                    new PixelSpec(h.datatype, 16, true, 1, h.sclSlope, h.sclInter,
                            "float/32bit → 16bit signed（Rescale で復元）");
                default -> throw new IOException("未対応の NIfTI データ型です: datatype=" + h.datatype);
            };
        }

        /** 量子化が要る型か（float / 32bit 整数）。 */
        boolean quantizes() {
            return datatype == NiftiHeader.DT_FLOAT32 || datatype == NiftiHeader.DT_INT32
                    || datatype == NiftiHeader.DT_UINT32 || datatype == NiftiHeader.DT_FLOAT64;
        }

        /** 生バイト列 → 16bit（または 8bit 相当）画素。量子化型では値域から係数を決める。 */
        short[] toPixels(byte[] raw, ByteOrder order, int voxels) {
            ByteBuffer b = ByteBuffer.wrap(raw).order(order);
            int n = samplesPerPixel == 3 ? voxels * 3 : voxels;
            short[] out = new short[n];
            switch (datatype) {
                case NiftiHeader.DT_UINT8, NiftiHeader.DT_RGB24 -> {
                    for (int i = 0; i < n; i++) {
                        out[i] = (short) (raw[i] & 0xFF);
                    }
                }
                case NiftiHeader.DT_INT8 -> {
                    for (int i = 0; i < n; i++) {
                        out[i] = raw[i];
                    }
                }
                case NiftiHeader.DT_INT16, NiftiHeader.DT_UINT16 -> {
                    for (int i = 0; i < n; i++) {
                        out[i] = b.getShort(i * 2);
                    }
                }
                default -> quantize(b, out, n);
            }
            return out;
        }

        /** ボリューム全体を 1 度走査して量子化係数（Rescale）を決める。 */
        void calibrateGlobally(Path file, NiftiHeader h) throws IOException {
            long voxels = (long) h.nx() * h.ny() * h.nz() * h.nt() * h.nc();
            int unit = h.bytesPerVoxel();
            double min = Double.POSITIVE_INFINITY;
            double max = Double.NEGATIVE_INFINITY;
            byte[] buf = new byte[unit * 8192];
            try (InputStream in = open(file)) {
                skipFully(in, h.voxOffset);
                long remaining = voxels;
                while (remaining > 0) {
                    int want = (int) Math.min(buf.length / unit, remaining) * unit;
                    int read = in.readNBytes(buf, 0, want);
                    if (read < unit) {
                        break; // 足りないぶんは変換時に検出する
                    }
                    ByteBuffer b = ByteBuffer.wrap(buf, 0, read).order(h.byteOrder);
                    int count = read / unit;
                    for (int i = 0; i < count; i++) {
                        double v = rawValue(b, i) * sclSlope + sclInter;
                        min = Math.min(min, v);
                        max = Math.max(max, v);
                    }
                    remaining -= count;
                }
            }
            if (!Double.isFinite(min) || !Double.isFinite(max)) {
                min = 0;
                max = 0;
            }
            double range = max - min;
            this.rescaleSlope = range > 0 ? range / 32000.0 : 1.0; // 余裕を持って ±32000 に収める
            this.rescaleIntercept = min;
        }

        private double rawValue(ByteBuffer b, int i) {
            return switch (datatype) {
                case NiftiHeader.DT_FLOAT32 -> b.getFloat(i * 4);
                case NiftiHeader.DT_FLOAT64 -> b.getDouble(i * 8);
                case NiftiHeader.DT_INT32 -> b.getInt(i * 4);
                case NiftiHeader.DT_UINT32 -> b.getInt(i * 4) & 0xFFFFFFFFL;
                default -> 0;
            };
        }

        /** 全体で決めた係数（{@link #calibrateGlobally}）で 16bit へ落とす。 */
        private void quantize(ByteBuffer b, short[] out, int n) {
            for (int i = 0; i < n; i++) {
                double v = rawValue(b, i) * sclSlope + sclInter;
                double q = (v - rescaleIntercept) / rescaleSlope;
                out[i] = (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, Math.round(q)));
            }
        }
    }
}

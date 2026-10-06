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
 * <p><b>32 bit 以上の整数・浮動小数は、値がすべて整数で 16 bit に収まれば可逆に、そうでなければ 16 bit へ量子化</b>し、
 * Rescale Slope/Intercept で元の値に戻せる形にする（標準の画像 IOD が 8/16bit しか持てないため）。詳細は {@link PixelSpec}。
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
        if (spec.paddingValue != null) {
            // NaN・無限大を置いた符号（fw/nifti-import.md §3）
            ds.setInt(Tag.PixelPaddingValue, spec.signed ? VR.SS : VR.US, spec.paddingValue);
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
     * NIfTI のデータ型 → DICOM の画素表現（標準の画像 IOD は 8/16 bit 整数＋Rescale）。
     *
     * <p>8/16 bit の整数型はそのまま入れる。32 bit 以上の整数・浮動小数は、取り込みの前にボリューム全体を 1 度走査し
     * （{@link #calibrateGlobally}）、次の順で決める（fw/nifti-import.md §3）。
     * <ol>
     *   <li><b>値がすべて整数で、範囲が 16 bit の符号の数に収まる</b> → <b>可逆</b>。生の値をそのまま（必要なら一定の
     *       オフセットだけずらして）入れ、Rescale でオフセットと scl_slope / scl_inter を戻す。
     *       int32 の CT や、HU を float で保存した CT はここに入る。</li>
     *   <li>それ以外（整数でない浮動小数、範囲が広すぎる整数） → 16 bit の全域を使って量子化し、最大誤差（刻みの半分）を
     *       説明に出す。量子化は「値域を 16 bit に収める」だけで情報を作らない。</li>
     * </ol>
     * NaN・無限大は 16 bit で表せないので、使わない最小の符号（−32768）に置き、{@code PixelPaddingValue} にする。
     * 件数は説明に出す（黙って別の値に変えない）。
     */
    static final class PixelSpec {
        /** 8/16 bit の整数型をそのまま入れる。 */
        private static final int DIRECT = 0;
        /** 32 bit 以上の型だが、整数値で 16 bit に収まるので可逆に入れる。 */
        private static final int LOSSLESS = 1;
        /** 16 bit の全域へ量子化する。 */
        private static final int QUANTIZE = 2;
        /** NaN・無限大を置く符号（符号付き 16 bit の最小）。 */
        static final short PADDING_CODE = Short.MIN_VALUE;

        final int datatype;
        final int bitsAllocated;
        boolean signed;
        final int samplesPerPixel;
        double rescaleSlope;
        double rescaleIntercept;
        String description;
        /** NaN・無限大があったときの PixelPaddingValue（無ければ null）。 */
        Short paddingValue;
        /** NIfTI 側のスケーリング（scl_slope / scl_inter）。 */
        private final double sclSlope;
        private final double sclInter;
        private int mode = DIRECT;
        /** LOSSLESS のとき: 保存する値 = 生の値 − offset。 */
        private long offset;
        /** QUANTIZE のとき: 有限値が使う最小の符号（パディングがあれば −32767）。 */
        private int lowestCode = Short.MIN_VALUE;

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
                case NiftiHeader.DT_FLOAT32, NiftiHeader.DT_FLOAT64, NiftiHeader.DT_INT32, NiftiHeader.DT_UINT32,
                        NiftiHeader.DT_INT64, NiftiHeader.DT_UINT64 ->
                    new PixelSpec(h.datatype, 16, true, 1, h.sclSlope, h.sclInter,
                            typeName(h.datatype) + " → 16bit（取り込み時に値を見て、可逆か量子化かを決める）");
                default -> throw new IOException("未対応の NIfTI データ型です: datatype=" + h.datatype);
            };
        }

        private static String typeName(int datatype) {
            return switch (datatype) {
                case NiftiHeader.DT_FLOAT32 -> "float32";
                case NiftiHeader.DT_FLOAT64 -> "float64";
                case NiftiHeader.DT_INT32 -> "int32";
                case NiftiHeader.DT_UINT32 -> "uint32";
                case NiftiHeader.DT_INT64 -> "int64";
                case NiftiHeader.DT_UINT64 -> "uint64";
                default -> "datatype " + datatype;
            };
        }

        private boolean isFloat() {
            return datatype == NiftiHeader.DT_FLOAT32 || datatype == NiftiHeader.DT_FLOAT64;
        }

        /** 取り込み前の全走査が要る型か（32 bit 以上の整数・浮動小数）。 */
        boolean quantizes() {
            return isFloat() || datatype == NiftiHeader.DT_INT32 || datatype == NiftiHeader.DT_UINT32
                    || datatype == NiftiHeader.DT_INT64 || datatype == NiftiHeader.DT_UINT64;
        }

        /** 生バイト列 → 16bit（または 8bit 相当）画素。 */
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
                default -> {
                    if (mode == LOSSLESS) {
                        storeLossless(b, out, n);
                    } else {
                        quantize(b, out, n);
                    }
                }
            }
            return out;
        }

        /**
         * ボリューム全体を 1 度走査して、可逆に入れられるか・量子化の係数・NaN の有無を決める。
         * 係数は<b>ボリューム全体で 1 つ</b>（フレームごとに決めると同じ値が別の意味になる）。
         */
        void calibrateGlobally(Path file, NiftiHeader h) throws IOException {
            long voxels = (long) h.nx() * h.ny() * h.nz() * h.nt() * h.nc();
            int unit = h.bytesPerVoxel();
            // 生の値（scl を掛ける前）の有限値の最小・最大。整数かどうか、long に収まるかも見る
            double rawMin = Double.POSITIVE_INFINITY;
            double rawMax = Double.NEGATIVE_INFINITY;
            long longMin = Long.MAX_VALUE;
            long longMax = Long.MIN_VALUE;
            boolean allInteger = true;
            long nonFinite = 0;
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
                        double v = rawValue(b, i);
                        if (!Double.isFinite(v)) {
                            nonFinite++;
                            continue;
                        }
                        rawMin = Math.min(rawMin, v);
                        rawMax = Math.max(rawMax, v);
                        if (allInteger) {
                            Long lv = rawLong(b, i, v);
                            if (lv == null) {
                                allInteger = false;
                            } else {
                                longMin = Math.min(longMin, lv);
                                longMax = Math.max(longMax, lv);
                            }
                        }
                    }
                    remaining -= count;
                }
            }
            int pad = nonFinite > 0 ? 1 : 0;
            if (nonFinite > 0) {
                paddingValue = PADDING_CODE;
            }
            String nanNote = nonFinite > 0
                    ? "・NaN/無限大 " + nonFinite + " ボクセルはパディング値（" + PADDING_CODE + "）"
                    : "";
            if (rawMin > rawMax) {
                // 有限値が 1 つも無い（すべて NaN）。全部パディングになる
                mode = QUANTIZE;
                lowestCode = Short.MIN_VALUE + pad;
                rescaleSlope = 1.0;
                rescaleIntercept = 0.0;
                description = typeName(datatype) + " → 16bit（有限値なし" + nanNote + "）";
                return;
            }
            // 1) 整数値で、範囲が 16 bit の符号の数（パディングに 1 つ取るならその残り）に収まる → 可逆
            // 差が long を桁あふれする（int64 の両端など）ときは、16 bit に収まらないので量子化へ
            boolean fits = allInteger && longMax - longMin >= 0 && longMax - longMin <= 65535L - pad;
            if (fits) {
                mode = LOSSLESS;
                if (pad == 0 && longMin >= Short.MIN_VALUE && longMax <= Short.MAX_VALUE) {
                    offset = 0;
                    signed = true;
                } else if (pad == 0 && longMin >= 0 && longMax <= 65535) {
                    offset = 0;
                    signed = false;
                } else if (longMin >= Short.MIN_VALUE + pad && longMax <= Short.MAX_VALUE) {
                    offset = 0;
                    signed = true;
                } else {
                    // 符号付き 16 bit の下端（パディングの次）へ寄せる
                    offset = longMin - (Short.MIN_VALUE + pad);
                    signed = true;
                }
                // 元の値 = (保存した値 + offset) × scl_slope + scl_inter
                rescaleSlope = sclSlope;
                rescaleIntercept = offset * sclSlope + sclInter;
                description = typeName(datatype) + " → 16bit " + (signed ? "signed" : "unsigned") + "（整数値のため可逆"
                        + (offset != 0 ? "・オフセット " + offset : "") + nanNote + "）";
                return;
            }
            // 2) 量子化。16 bit の全域（パディングの分を除く）を使う
            mode = QUANTIZE;
            signed = true;
            lowestCode = Short.MIN_VALUE + pad;
            double vMin = Math.min(rawMin * sclSlope + sclInter, rawMax * sclSlope + sclInter);
            double vMax = Math.max(rawMin * sclSlope + sclInter, rawMax * sclSlope + sclInter);
            int levels = Short.MAX_VALUE - lowestCode; // 符号の数 − 1
            double range = vMax - vMin;
            rescaleSlope = range > 0 ? range / levels : 1.0;
            rescaleIntercept = vMin - lowestCode * rescaleSlope;
            description = typeName(datatype) + " → 16bit signed（"
                    + (allInteger ? "整数だが範囲が 16bit を超えるため" : "整数でない値を含むため")
                    + "量子化・最大誤差 ±" + String.format(java.util.Locale.ROOT, "%.6g", range > 0 ? rescaleSlope / 2 : 0.0)
                    + nanNote + "）";
        }

        /** 整数型ならその値、浮動小数なら整数値のときだけ long。整数でなければ null。 */
        private Long rawLong(ByteBuffer b, int i, double asDouble) {
            return switch (datatype) {
                case NiftiHeader.DT_INT32 -> (long) b.getInt(i * 4);
                case NiftiHeader.DT_UINT32 -> b.getInt(i * 4) & 0xFFFFFFFFL;
                case NiftiHeader.DT_INT64 -> b.getLong(i * 8);
                case NiftiHeader.DT_UINT64 -> {
                    long v = b.getLong(i * 8);
                    yield v >= 0 ? v : null; // 2^63 以上は long で扱わない（量子化へ）
                }
                default -> asDouble == Math.rint(asDouble) && Math.abs(asDouble) < 0x1p62 ? (long) asDouble : null;
            };
        }

        private double rawValue(ByteBuffer b, int i) {
            return switch (datatype) {
                case NiftiHeader.DT_FLOAT32 -> b.getFloat(i * 4);
                case NiftiHeader.DT_FLOAT64 -> b.getDouble(i * 8);
                case NiftiHeader.DT_INT32 -> b.getInt(i * 4);
                case NiftiHeader.DT_UINT32 -> b.getInt(i * 4) & 0xFFFFFFFFL;
                case NiftiHeader.DT_INT64 -> b.getLong(i * 8);
                case NiftiHeader.DT_UINT64 -> {
                    long v = b.getLong(i * 8);
                    yield v >= 0 ? (double) v : (double) (v >>> 1) * 2.0 + (v & 1);
                }
                default -> 0;
            };
        }

        /** 可逆: 保存する値 = 生の値 − offset（{@link #calibrateGlobally} で 16 bit に収まることを確かめてある）。 */
        private void storeLossless(ByteBuffer b, short[] out, int n) {
            for (int i = 0; i < n; i++) {
                double v = rawValue(b, i);
                if (!Double.isFinite(v)) {
                    out[i] = PADDING_CODE;
                    continue;
                }
                long stored = rawLong(b, i, v) - offset;
                // unsigned のときは 0〜65535 を short のビット列として入れる
                out[i] = (short) stored;
            }
        }

        /** 全体で決めた係数（{@link #calibrateGlobally}）で 16bit へ落とす。 */
        private void quantize(ByteBuffer b, short[] out, int n) {
            for (int i = 0; i < n; i++) {
                double v = rawValue(b, i) * sclSlope + sclInter;
                if (!Double.isFinite(v)) {
                    out[i] = PADDING_CODE;
                    continue;
                }
                double q = (v - rescaleIntercept) / rescaleSlope;
                out[i] = (short) Math.max(lowestCode, Math.min(Short.MAX_VALUE, Math.round(q)));
            }
        }
    }
}

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
import org.dcm4che3.data.Sequence;
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
                        Attributes ds = baseDataset(h, geom, opts, spec, studyUid, seriesUid, frameOfRef,
                                sopClass, studyDate, z, t, c, instance, nx, ny, nt);
                        metaApplied = NiftiMetadataMapper.apply(ds, opts.metadata());
                        if (spec.floatMode()) {
                            // 整数で 16 bit に収まらないもの・NaN を含む float は Parametric Map（32 bit float）
                            float[] values = spec.toFloats(raw, h.byteOrder, (int) frameVoxels);
                            if (geom.flipRows) {
                                flipRows(values, nx, ny);
                            }
                            toParametricMap(ds, geom, h, z, t, nt);
                            ds.setBytes(Tag.FloatPixelData, VR.OF, toBytes(values));
                        } else {
                            short[] pixels = spec.toPixels(raw, h.byteOrder, (int) frameVoxels);
                            if (geom.flipRows) {
                                flipRows(pixels, nx, ny, spec.samplesPerPixel);
                            }
                            ds.setBytes(Tag.PixelData, spec.samplesPerPixel == 3 || spec.bitsAllocated == 8 ? VR.OB : VR.OW,
                                    toBytes(pixels, spec));
                        }
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

    /**
     * 通常の画像のデータセットを Parametric Map（1 インスタンス 1 フレーム）に組み替える（fw/nifti-import.md §3.1）。
     * 幾何はトップレベルから Functional Groups へ移し、Rescale の代わりに RealWorldValueMapping（傾き 1・切片 0）を書く。
     * PixelRepresentation・BitsStored・HighBit は Float Pixel Data には無いので書かない。
     */
    private static void toParametricMap(Attributes ds, NiftiGeometry geom, NiftiHeader h, int z, int t, int nt) {
        double[] ipp = ds.getDoubles(Tag.ImagePositionPatient);
        double[] iop = ds.getDoubles(Tag.ImageOrientationPatient);
        double[] ps = ds.getDoubles(Tag.PixelSpacing);
        for (int tag : new int[] { Tag.ImagePositionPatient, Tag.ImageOrientationPatient, Tag.PixelSpacing,
                Tag.SliceThickness, Tag.SpacingBetweenSlices, Tag.SliceLocation, Tag.RescaleSlope, Tag.RescaleIntercept,
                Tag.RescaleType, Tag.BitsStored, Tag.HighBit, Tag.PixelRepresentation, Tag.PixelPaddingValue,
                Tag.TemporalPositionIndex }) {
            ds.remove(tag);
        }
        ds.setString(Tag.SOPClassUID, VR.UI, UID.ParametricMapStorage);
        ds.setString(Tag.ImageType, VR.CS, "DERIVED", "PRIMARY");
        ds.setInt(Tag.NumberOfFrames, VR.IS, 1);
        ds.setInt(Tag.BitsAllocated, VR.US, 32);
        ds.setString(Tag.ContentLabel, VR.CS, "NIFTI");
        ds.setString(Tag.ContentDescription, VR.LO, "Imported from NIfTI as 32-bit float");
        ds.setString(Tag.ContentCreatorName, VR.PN, "GRAPHY-Next");
        ds.setString(Tag.ContentDate, VR.DA, ds.getString(Tag.SeriesDate, ""));
        ds.setString(Tag.ContentTime, VR.TM, "000000");
        ds.setString(Tag.Manufacturer, VR.LO, "Visionary Imaging Services, Inc.");
        ds.setString(Tag.ManufacturerModelName, VR.LO, "GRAPHY-Next");
        ds.setString(Tag.DeviceSerialNumber, VR.LO, "NIFTI-IMPORT");
        ds.setString(Tag.SoftwareVersions, VR.LO, "GRAPHY-Next");
        ds.setString(Tag.PresentationLUTShape, VR.CS, "IDENTITY");

        String dimOrgUid = ds.getString(Tag.SeriesInstanceUID) + ".1";
        if (dimOrgUid.length() > 64) {
            dimOrgUid = UIDUtils.createUID();
        }
        Attributes org = new Attributes();
        org.setString(Tag.DimensionOrganizationUID, VR.UI, dimOrgUid);
        ds.newSequence(Tag.DimensionOrganizationSequence, 1).add(org);
        Sequence dims = ds.newSequence(Tag.DimensionIndexSequence, 2);
        dims.add(dimIndexItem(dimOrgUid, Tag.ImagePositionPatient, Tag.PlanePositionSequence));
        if (nt > 1) {
            dims.add(dimIndexItem(dimOrgUid, Tag.TemporalPositionIndex, Tag.FrameContentSequence));
        }

        Attributes shared = new Attributes();
        Attributes po = new Attributes();
        po.setDouble(Tag.ImageOrientationPatient, VR.DS, iop);
        shared.newSequence(Tag.PlaneOrientationSequence, 1).add(po);
        Attributes pm = new Attributes();
        pm.setDouble(Tag.PixelSpacing, VR.DS, ps);
        pm.setDouble(Tag.SliceThickness, VR.DS, geom.sliceSpacing());
        pm.setDouble(Tag.SpacingBetweenSlices, VR.DS, geom.sliceSpacing());
        shared.newSequence(Tag.PixelMeasuresSequence, 1).add(pm);
        Attributes ft = new Attributes();
        ft.setString(Tag.FrameType, VR.CS, "DERIVED", "PRIMARY");
        shared.newSequence(Tag.ParametricMapFrameTypeSequence, 1).add(ft);
        // 値はそのまま実際の量（傾き 1・切片 0）。単位は取り込みの画面で選ぶ（段 F2）。それまでは無次元「1」
        Attributes rw = new Attributes();
        rw.setDouble(Tag.DoubleFloatRealWorldValueFirstValueMapped, VR.FD, -Float.MAX_VALUE);
        rw.setDouble(Tag.DoubleFloatRealWorldValueLastValueMapped, VR.FD, Float.MAX_VALUE);
        rw.setDouble(Tag.RealWorldValueSlope, VR.FD, 1.0);
        rw.setDouble(Tag.RealWorldValueIntercept, VR.FD, 0.0);
        rw.setString(Tag.LUTLabel, VR.SH, "NIFTI");
        rw.setString(Tag.LUTExplanation, VR.LO, "Values as stored in the NIfTI file");
        Attributes unit = new Attributes();
        unit.setString(Tag.CodeValue, VR.SH, "1");
        unit.setString(Tag.CodingSchemeDesignator, VR.SH, "UCUM");
        unit.setString(Tag.CodeMeaning, VR.LO, "no units");
        rw.newSequence(Tag.MeasurementUnitsCodeSequence, 1).add(unit);
        shared.newSequence(Tag.RealWorldValueMappingSequence, 1).add(rw);
        ds.newSequence(Tag.SharedFunctionalGroupsSequence, 1).add(shared);

        Attributes frame = new Attributes();
        Attributes pp = new Attributes();
        pp.setDouble(Tag.ImagePositionPatient, VR.DS, ipp);
        frame.newSequence(Tag.PlanePositionSequence, 1).add(pp);
        Attributes fc = new Attributes();
        if (nt > 1) {
            fc.setInt(Tag.DimensionIndexValues, VR.UL, z + 1, t + 1);
            fc.setInt(Tag.TemporalPositionIndex, VR.UL, t + 1);
        } else {
            fc.setInt(Tag.DimensionIndexValues, VR.UL, z + 1);
        }
        frame.newSequence(Tag.FrameContentSequence, 1).add(fc);
        ds.newSequence(Tag.PerFrameFunctionalGroupsSequence, 1).add(frame);
    }

    private static Attributes dimIndexItem(String dimOrgUid, int pointer, int functionalGroupPointer) {
        Attributes item = new Attributes();
        item.setString(Tag.DimensionOrganizationUID, VR.UI, dimOrgUid);
        item.setInt(Tag.DimensionIndexPointer, VR.AT, pointer);
        item.setInt(Tag.FunctionalGroupPointer, VR.AT, functionalGroupPointer);
        return item;
    }

    private static void flipRows(float[] values, int cols, int rows) {
        float[] tmp = new float[cols];
        for (int y = 0; y < rows / 2; y++) {
            int top = y * cols;
            int bottom = (rows - 1 - y) * cols;
            System.arraycopy(values, top, tmp, 0, cols);
            System.arraycopy(values, bottom, values, top, cols);
            System.arraycopy(tmp, 0, values, bottom, cols);
        }
    }

    private static byte[] toBytes(float[] values) {
        ByteBuffer buf = ByteBuffer.allocate(values.length * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (float v : values) {
            buf.putFloat(v);
        }
        return buf.array();
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
     * NIfTI のデータ型 → DICOM の画素表現（fw/nifti-import.md §3・§3.1）。
     *
     * <p>8/16 bit の整数型は通常の画像（16 bit ＋ Rescale）にそのまま入れる。32 bit 以上の整数・浮動小数は、取り込みの前に
     * ボリューム全体を 1 度走査し（{@link #calibrateGlobally}）、次のどちらかにする。
     * <ol>
     *   <li><b>値がすべて整数で、範囲が 16 bit の符号の数に収まり、NaN・無限大が無い</b> → 通常の画像に<b>可逆</b>
     *       （生の値をそのまま、必要なら一定のオフセットだけずらして入れ、Rescale で戻す）。int32 の CT、HU を float で持つ CT。</li>
     *   <li>それ以外 → <b>Parametric Map（32 bit float）</b>。float32 は誤差なし、float64・2^24 を超える整数は float32 への丸め
     *       （最大誤差を説明に出す）。<b>NaN はそのまま</b>、無限大も NaN にする（2026-10-06 のユーザ判断）。</li>
     * </ol>
     */
    static final class PixelSpec {
        /** 8/16 bit の整数型をそのまま入れる。 */
        private static final int DIRECT = 0;
        /** 32 bit 以上の型だが、整数値で 16 bit に収まるので可逆に入れる。 */
        private static final int LOSSLESS = 1;
        /** Parametric Map（32 bit float）で入れる。 */
        private static final int FLOAT = 2;

        final int datatype;
        final int bitsAllocated;
        boolean signed;
        final int samplesPerPixel;
        double rescaleSlope;
        double rescaleIntercept;
        String description;
        /** NIfTI 側のスケーリング（scl_slope / scl_inter）。 */
        private final double sclSlope;
        private final double sclInter;
        private int mode = DIRECT;
        /** LOSSLESS のとき: 保存する値 = 生の値 − offset。 */
        private long offset;

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
                            typeName(h.datatype) + "（取り込み時に値を見て、16bit で可逆か 32bit float かを決める）");
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

        /** Parametric Map（32 bit float）で書くか。 */
        boolean floatMode() {
            return mode == FLOAT;
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
                default -> storeLossless(b, out, n);
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
            double maxFloatError = 0;
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
                        maxFloatError = Math.max(maxFloatError, floatError(b, i, v));
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
            // 1) 整数値で、範囲が 16 bit の符号の数に収まり、NaN・無限大が無い → 通常の画像に可逆
            //    （差が long を桁あふれする int64 の両端などは収まらない側へ）
            boolean fits = nonFinite == 0 && rawMin <= rawMax && allInteger
                    && longMax - longMin >= 0 && longMax - longMin <= 65535L;
            if (fits) {
                mode = LOSSLESS;
                if (longMin >= Short.MIN_VALUE && longMax <= Short.MAX_VALUE) {
                    offset = 0;
                    signed = true;
                } else if (longMin >= 0 && longMax <= 65535) {
                    offset = 0;
                    signed = false;
                } else {
                    // 符号付き 16 bit の下端へ寄せる
                    offset = longMin - Short.MIN_VALUE;
                    signed = true;
                }
                // 元の値 = (保存した値 + offset) × scl_slope + scl_inter
                rescaleSlope = sclSlope;
                rescaleIntercept = offset * sclSlope + sclInter;
                description = typeName(datatype) + " → 16bit " + (signed ? "signed" : "unsigned") + "（整数値のため可逆"
                        + (offset != 0 ? "・オフセット " + offset : "") + "）";
                return;
            }
            // 2) Parametric Map（32 bit float）。float32 は誤差なし。それ以外は float32 への丸めの最大誤差を出す
            mode = FLOAT;
            rescaleSlope = 1.0;
            rescaleIntercept = 0.0;
            String err = maxFloatError > 0
                    ? "・float32 への丸めの最大誤差 ±" + String.format(java.util.Locale.ROOT, "%.6g", maxFloatError)
                    : "・誤差なし";
            String nan = nonFinite > 0 ? "・NaN/無限大 " + nonFinite + " ボクセルは NaN のまま" : "";
            description = typeName(datatype) + " → 32bit float（Parametric Map" + err + nan + "）";
        }

        /**
         * その値を float32 にしたときの誤差。整数型は<b>元の 64 bit 整数と</b>比べる（double に直してから比べると、
         * 2^53 を超える整数は double の段階で丸まっていて誤差が見えない）。
         */
        private double floatError(ByteBuffer b, int i, double v) {
            Long lv = (sclSlope == 1.0 && sclInter == 0.0 && !isFloat()) ? rawLong(b, i, v) : null;
            if (lv != null) {
                return new java.math.BigDecimal(lv).subtract(new java.math.BigDecimal((double) (float) v)).abs().doubleValue();
            }
            double real = v * sclSlope + sclInter;
            return Math.abs(real - (double) (float) real);
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
                long stored = rawLong(b, i, rawValue(b, i)) - offset;
                // unsigned のときは 0〜65535 を short のビット列として入れる
                out[i] = (short) stored;
            }
        }

        /** Parametric Map の値（scl を掛けた実際の量・float32）。無限大は NaN にする。 */
        float[] toFloats(byte[] raw, ByteOrder order, int voxels) {
            ByteBuffer b = ByteBuffer.wrap(raw).order(order);
            float[] out = new float[voxels];
            for (int i = 0; i < voxels; i++) {
                double v = rawValue(b, i) * sclSlope + sclInter;
                out[i] = Double.isFinite(v) ? (float) v : Float.NaN;
            }
            return out;
        }
    }
}

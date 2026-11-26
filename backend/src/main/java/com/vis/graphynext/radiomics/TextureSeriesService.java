/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.dicom.Utf8Output;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.microscopy.ConfocalMicroscopyWriter;
import com.vis.graphynext.microscopy.InstallationIdentity;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Texture（Radiomics 可視化マップ）派生シリーズ生成サービス。
 *
 * <p>{@link RadiomicsMapEngine} が計算した 32bit float マップを <b>16bit unsigned</b> へ変換し
 * （{@code slope=(max-min)/65535, intercept=min}）、RescaleSlope/Intercept で 32bit 原値を保持する。
 * 元シリーズの患者/検査/幾何属性を引き継ぎ、UID を再生成、SOPClass=SecondaryCapture、
 * ImageType=DERIVED\SECONDARY\TEXTURE として {@link DicomStorageService#ingest(Path)} で DB 保存する。
 * 設計 {@code fw/texture-radiomics-design.md} §5,§6。
 */
@Service
public class TextureSeriesService {

    private static final Logger log = LoggerFactory.getLogger(TextureSeriesService.class);

    private final DicomStorageService storage;
    private final RadiomicsMapEngine engine;
    private final RadiomicsMode mode;
    private final InstallationIdentity identity;

    public TextureSeriesService(DicomStorageService storage, RadiomicsMapEngine engine, RadiomicsMode mode,
                                InstallationIdentity identity) {
        this.storage = storage;
        this.engine = engine;
        this.mode = mode;
        this.identity = identity;
    }

    /** 生成結果。 */
    /** @param lossyCompressed 元画像が非可逆圧縮（マップの値は圧縮の影響を受ける） */
    public record Result(String seriesInstanceUid, List<String> sopInstanceUids, boolean lossyCompressed) {}

    /** マップを計算し派生シリーズとして保存する（進み具合は見ない）。 */
    public Result create(TextureSeriesRequest req) throws IOException {
        return create(req, TextureProgress.NONE);
    }

    /** マップを計算し派生シリーズとして保存する。 */
    public Result create(TextureSeriesRequest req, TextureProgress progress) throws IOException {
        mode.require("テクスチャ可視化マップ");
        validate(req);

        // 属性テンプレート = 元シリーズ代表インスタンス。
        List<Path> srcFiles = storage.resolveFiles(req.studyInstanceUid(), List.of(req.sourceSeriesUid()));
        if (srcFiles.isEmpty()) {
            throw new IllegalArgumentException("ターゲットシリーズが見つかりません: " + req.sourceSeriesUid());
        }
        Attributes tmpl = readHeader(srcFiles.get(0));

        // マップ計算（重い）。
        RadiomicsMapEngine.Computed computed = engine.computeResumable(req, progress);
        RadiomicsMapEngine.MapResult map = computed.map();

        // 32bit float → 16bit unsigned。画素 0 は「値なし」に空け、実値は 1〜65535 に写す（RWVM の First Value Mapped=1）。
        double[] q = quantization(minMax(map.data()));
        double min = q[0], max = q[1], slope = q[2], intercept = q[3];

        String newSeriesUid = UIDUtils.createUID();
        int seriesNumber = req.seriesNumber() != null ? req.seriesNumber()
                : tmpl.getInt(Tag.SeriesNumber, 0) + 2000;
        String featureName = map.featureName();
        String seriesDesc = req.seriesDescription() != null && !req.seriesDescription().isBlank()
                ? req.seriesDescription()
                : featureName + " " + tmpl.getString(Tag.SeriesDescription, "");
        double sliceThickness = tmpl.getDouble(Tag.SliceThickness, 0.0);
        double spacingBetween = tmpl.getDouble(Tag.SpacingBetweenSlices,
                spacingFromIpp(map.ippPerZ(), sliceThickness));
        String derivation = derivationDescription(req, featureName, map.lossyCompressed(), map.valueCalibration());

        List<String> sops = new ArrayList<>(map.slices());
        for (int z = 0; z < map.slices(); z++) {
            byte[] px = to16bit(map.data()[z], slope, intercept);
            // 全域が見える窓を、実値で渡す（buildInstance が保存値の領域に直す）
            double windowWidth = Math.max(1e-6, max - min);
            Attributes a = buildInstance(tmpl, req.studyInstanceUid(), map, newSeriesUid, seriesNumber, seriesDesc,
                    "TEXTURE", featureName, derivation, slope, intercept, min + windowWidth / 2.0, windowWidth,
                    sliceThickness, spacingBetween, z, px, identity.equipment());
            sops.add(a.getString(Tag.SOPInstanceUID));
            ingest(storage, a);
        }
        // 派生シリーズは保管庫に入った。途中結果はもう要らない（失敗・キャンセルのときだけ残す）。
        engine.discardCheckpoints(computed);
        log.info("texture series created: {} ({} instances) feature={} from {}",
                newSeriesUid, sops.size(), featureName, req.sourceSeriesUid());
        return new Result(newSeriesUid, sops, map.lossyCompressed());
    }

    /**
     * DerivationDescription。<b>マップの値の意味を決めるパラメータを、シリーズ自身に書き残す</b>。
     * 特に GLAM は maxRadius と境界補正で数値の意味が変わり、後から設定を辿る術が無い。
     */
    static String derivationDescription(TextureSeriesRequest req, String featureName, boolean lossy) {
        return derivationDescription(req, featureName, lossy, ValueCalibration.UNSET);
    }

    /** @param calibration 読み込みで掛けた校正。校正しなかった（{@link ValueCalibration#text()} が空）ときは項目を足さない */
    static String derivationDescription(TextureSeriesRequest req, String featureName, boolean lossy,
                                        ValueCalibration calibration) {
        StringBuilder sb = new StringBuilder("Texture map ").append(featureName)
                .append(" (GRAPHY-Next Radiomics; kernel=").append(req.filterSize())
                .append(", stride=").append(req.stride())
                .append(", ").append(req.force2D() ? "2D" : "3D")
                .append(", margin=").append(req.margin() != null ? req.margin().toString() : "default")
                // リサンプリングすると「距離 1」の意味が変わるので、値の意味を決めるパラメータに含まれる。
                .append(", resampling=").append(TextureResampling.describe(req.settings()));
        if (GlamMapSupport.isGlam(req.feature())) {
            sb.append(", maxRadius=")
                    .append(GlamMapSupport.maxRadiusFor(Math.max(1, req.filterSize()), req.settings()))
                    .append(", boundaryCorrection=").append(setting(req, "BOOL_GLAM_boundaryCorrection", "1"))
                    .append(", randomisations=").append(setting(req, "INT_GLAM_numRandomisations", "0"));
        }
        if (calibration != null && !calibration.text().isEmpty()) {
            // PET の SUV 校正など。FIRSTORDER・固定ビン幅のマップは値の単位に直接依存するので、シリーズ自身に残す
            sb.append(", calibration=").append(calibration.text());
        }
        if (lossy) {
            // 元画像が非可逆圧縮なら、値は圧縮の影響を受けている。派生シリーズだけ見ても分かるように残す
            sb.append(", source: lossy compressed");
        }
        return sb.append(")").toString();
    }

    private static String setting(TextureSeriesRequest req, String key, String def) {
        if (req.settings() == null) return def;
        String v = req.settings().get(key);
        return (v == null || v.isBlank()) ? def : v.trim();
    }

    private void validate(TextureSeriesRequest req) {
        if (req.studyInstanceUid() == null || req.studyInstanceUid().isBlank()
                || req.sourceSeriesUid() == null || req.sourceSeriesUid().isBlank()) {
            throw new IllegalArgumentException("studyInstanceUid / sourceSeriesUid は必須です");
        }
        if (req.feature() == null || req.feature().isBlank()) {
            throw new IllegalArgumentException("feature は必須です（例 GLCM_JointEntropy）");
        }
        TextureSeriesRequest.checkCalibration(req.calibration());
    }

    /** 全スライスから NaN/Inf を除いた min/max。 */
    static double[] minMax(float[][] data) {
        double min = Double.POSITIVE_INFINITY, max = Double.NEGATIVE_INFINITY;
        for (float[] slice : data) {
            for (float v : slice) {
                if (Float.isNaN(v) || Float.isInfinite(v)) continue;
                if (v < min) min = v;
                if (v > max) max = v;
            }
        }
        if (min == Double.POSITIVE_INFINITY) {
            return new double[]{0.0, 1.0};
        }
        return new double[]{min, max};
    }

    /**
     * 実値の範囲から量子化の係数を決める。画素 0 は「値なし」用に空けるので、min が画素 1・max が画素 65535 になる:
     * 傾き=(max-min)/65534、切片=min−傾き。
     *
     * @return {min, max（同じ値なら +1 に広げた後）, slope, intercept}
     */
    static double[] quantization(double[] minMax) {
        double min = minMax[0], max = minMax[1];
        if (Double.isNaN(min) || Double.isNaN(max) || Double.isInfinite(min) || Double.isInfinite(max)) {
            min = 0.0;
            max = 1.0;
        }
        if (min == max) {
            max = min + 1.0;
        }
        double slope = (max - min) / 65534.0;
        return new double[] { min, max, slope, min - slope };
    }

    /** float[] → 16bit unsigned（リトルエンディアン byte[]）。実値は 1〜65535、NaN・Inf は 0（値なし）。 */
    static byte[] to16bit(float[] src, double slope, double intercept) {
        byte[] out = new byte[src.length * 2];
        for (int i = 0; i < src.length; i++) {
            float v = src[i];
            int p;
            if (Float.isNaN(v) || Float.isInfinite(v)) {
                p = 0;
            } else {
                p = (int) Math.floor((v - intercept) / slope + 0.5);
                if (p < 1) p = 1;
                if (p > 65535) p = 65535;
            }
            out[i * 2] = (byte) (p & 0xFF);
            out[i * 2 + 1] = (byte) ((p >> 8) & 0xFF);
        }
        return out;
    }

    /** 隣接 IPP 距離から SpacingBetweenSlices を推定（無ければ sliceThickness or 1）。 */
    static double spacingFromIpp(List<double[]> ippPerZ, double sliceThickness) {
        if (ippPerZ != null && ippPerZ.size() >= 2) {
            double[] a = ippPerZ.get(0), b = ippPerZ.get(1);
            if (a != null && b != null && a.length == 3 && b.length == 3) {
                double dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
                double d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d > 1e-4) return d;
            }
        }
        return sliceThickness > 0 ? sliceThickness : 1.0;
    }

    /** 私的コード体系（Derivation Code・Coding Scheme Designator）。 */
    static final String PRIVATE_SCHEME = "99GRAPHYNEXT";

    /**
     * 派生シリーズ（Parametric Map・16 bit 符号なし整数＋Real World Value Mapping）の 1 スライス
     * （1 インスタンス 1 フレーム）。テクスチャマップとフィルタ画像が共有する。形は規格 A.75 の表による。
     *
     * @param imageTypeLast ImageType の 3 つ目（{@code TEXTURE}・{@code LOG}）。4 つ目は FILTERED
     * @param rescaleType   特徴名（LUT Explanation・Content Description へ。長さは各欄に切る）
     * @param slope         実値 = 画素 × slope + intercept（RWVM）。画素 0 は値なし
     * @param windowCenter  初期の窓の中心（<b>実値</b>）。保存値の領域に直して Frame VOI LUT へ書く
     */
    static Attributes buildInstance(Attributes tmpl, String studyInstanceUid, RadiomicsMapEngine.MapResult map,
                                    String newSeriesUid, int seriesNumber, String seriesDesc, String imageTypeLast,
                                    String rescaleType, String derivation, double slope, double intercept,
                                    double windowCenter, double windowWidth,
                                    double sliceThickness, double spacingBetween, int z, byte[] px,
                                    ConfocalMicroscopyWriter.Equipment eq) {
        return buildInstance(tmpl, studyInstanceUid, map, newSeriesUid, seriesNumber, seriesDesc, imageTypeLast,
                rescaleType, derivation, slope, intercept, windowCenter, windowWidth, sliceThickness,
                spacingBetween, z, px, eq, null);
    }

    /**
     * RWVM の単位（UCUM）を持つ版。{@code unit} が null なら「単位なし」（コード {@code 1}）。値が SUV など実量の
     * ときだけ渡す（フィルタ画像の PET 校正）。
     *
     * @param unit {コード値, コードの意味}。コード値は UCUM（Code Value は SH＝16 文字まで）
     */
    static Attributes buildInstance(Attributes tmpl, String studyInstanceUid, RadiomicsMapEngine.MapResult map,
                                    String newSeriesUid, int seriesNumber, String seriesDesc, String imageTypeLast,
                                    String rescaleType, String derivation, double slope, double intercept,
                                    double windowCenter, double windowWidth,
                                    double sliceThickness, double spacingBetween, int z, byte[] px,
                                    ConfocalMicroscopyWriter.Equipment eq, String[] unit) {
        if (!hasGeometry(map)) {
            // エンジンの入り口（格子として扱えない画像を断る）で先に断られるので、通常は到達しない最後の守り
            throw new IllegalArgumentException(
                    "位置・向き（IOP・FrameOfReference・各スライスの IPP）が無いシリーズは Parametric Map にできません");
        }
        return buildParametricMap(tmpl, studyInstanceUid, map, newSeriesUid, seriesNumber, seriesDesc, imageTypeLast,
                rescaleType, derivation, slope, intercept, windowCenter, windowWidth, sliceThickness,
                spacingBetween, z, px, eq, unit);
    }

    /** 位置情報（IOP・FrameOfReference・全スライスの IPP）が揃うか。Parametric Map の必須。 */
    static boolean hasGeometry(RadiomicsMapEngine.MapResult map) {
        double[] iop = map.imageOrientationPatient();
        if (iop == null || iop.length != 6 || map.frameOfReferenceUid() == null || map.frameOfReferenceUid().isBlank()) {
            return false;
        }
        List<double[]> ipps = map.ippPerZ();
        if (ipps == null || ipps.size() < map.slices()) {
            return false;
        }
        for (int z = 0; z < map.slices(); z++) {
            if (ipps.get(z) == null || ipps.get(z).length != 3) {
                return false;
            }
        }
        return true;
    }

    private static Attributes buildParametricMap(Attributes tmpl, String studyInstanceUid,
                                                 RadiomicsMapEngine.MapResult map, String newSeriesUid,
                                                 int seriesNumber, String seriesDesc, String imageTypeLast,
                                                 String rescaleType, String derivation, double slope,
                                                 double intercept, double windowCenter, double windowWidth,
                                                 double sliceThickness, double spacingBetween, int z, byte[] px,
                                                 ConfocalMicroscopyWriter.Equipment eq, String[] ucum) {
        Attributes a = new Attributes();
        double[] iop = map.imageOrientationPatient();
        double[] ipp = map.ippPerZ().get(z);

        // 患者・検査（Type 2 は元が空でも空で書く。元に無い属性を欠落させない）
        a.setString(Tag.SpecificCharacterSet, VR.CS, tmpl.getString(Tag.SpecificCharacterSet, "ISO_IR 192"));
        type2(tmpl, a, Tag.PatientName, VR.PN);
        type2(tmpl, a, Tag.PatientID, VR.LO);
        type2(tmpl, a, Tag.PatientBirthDate, VR.DA);
        type2(tmpl, a, Tag.PatientSex, VR.CS);
        a.setString(Tag.StudyInstanceUID, VR.UI, tmpl.getString(Tag.StudyInstanceUID, studyInstanceUid));
        type2(tmpl, a, Tag.StudyDate, VR.DA);
        type2(tmpl, a, Tag.StudyTime, VR.TM);
        type2(tmpl, a, Tag.ReferringPhysicianName, VR.PN);
        type2(tmpl, a, Tag.StudyID, VR.SH);
        type2(tmpl, a, Tag.AccessionNumber, VR.SH);
        for (int tag : new int[] { Tag.PatientAge, Tag.StudyDescription, Tag.PatientPosition }) {
            copyTag(tmpl, a, tag);
        }

        // シリーズ。Modality は元を保つ（PM の Modality は元のモダリティでよい。C.8.32.1）
        a.setString(Tag.Modality, VR.CS, tmpl.getString(Tag.Modality, "OT"));
        a.setString(Tag.SeriesInstanceUID, VR.UI, newSeriesUid);
        a.setInt(Tag.SeriesNumber, VR.IS, seriesNumber);
        a.setString(Tag.SeriesDescription, VR.LO, seriesDesc);
        a.setString(Tag.FrameOfReferenceUID, VR.UI, map.frameOfReferenceUid());
        type2(tmpl, a, Tag.PositionReferenceIndicator, VR.LO);

        // 装置（Enhanced General Equipment は 4 つとも Type 1）
        a.setString(Tag.Manufacturer, VR.LO, eq.manufacturer());
        a.setString(Tag.ManufacturerModelName, VR.LO, eq.model());
        a.setString(Tag.DeviceSerialNumber, VR.LO, eq.serial());
        a.setString(Tag.SoftwareVersions, VR.LO, eq.softwareVersion());

        a.setString(Tag.SOPClassUID, VR.UI, UID.ParametricMapStorage);
        a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        a.setInt(Tag.InstanceNumber, VR.IS, z + 1);
        String[] imageType = { "DERIVED", "PRIMARY", imageTypeLast, "FILTERED" };
        a.setString(Tag.ImageType, VR.CS, imageType);
        boolean log = "LOG".equals(imageTypeLast);
        String label = log ? "LOG_FILTER" : "TEXTURE_MAP";
        a.setString(Tag.ContentLabel, VR.CS, label);
        a.setString(Tag.ContentDescription, VR.LO, cut(rescaleType, 64));
        a.setString(Tag.ContentQualification, VR.CS, "RESEARCH");
        java.time.LocalDateTime now = java.time.LocalDateTime.now();
        a.setString(Tag.ContentDate, VR.DA, now.format(java.time.format.DateTimeFormatter.BASIC_ISO_DATE));
        a.setString(Tag.ContentTime, VR.TM, now.format(java.time.format.DateTimeFormatter.ofPattern("HHmmss")));
        a.setString(Tag.PresentationLUTShape, VR.CS, "IDENTITY");
        a.setString(Tag.BurnedInAnnotation, VR.CS, "NO");
        a.setString(Tag.RecognizableVisualFeatures, VR.CS, "YES");
        boolean lossy = map.lossyCompressed() || "01".equals(tmpl.getString(Tag.LossyImageCompression));
        a.setString(Tag.LossyImageCompression, VR.CS, lossy ? "01" : "00");
        if (lossy) {
            copyTag(tmpl, a, Tag.LossyImageCompressionRatio);
            copyTag(tmpl, a, Tag.LossyImageCompressionMethod);
        }

        // 画素（16 bit 符号なし整数。BitsStored=16・HighBit=15）
        a.setInt(Tag.Rows, VR.US, map.height());
        a.setInt(Tag.Columns, VR.US, map.width());
        a.setInt(Tag.SamplesPerPixel, VR.US, 1);
        a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        a.setInt(Tag.BitsAllocated, VR.US, 16);
        a.setInt(Tag.BitsStored, VR.US, 16);
        a.setInt(Tag.HighBit, VR.US, 15);
        a.setInt(Tag.PixelRepresentation, VR.US, 0);
        a.setInt(Tag.NumberOfFrames, VR.IS, 1);

        // Multi-frame Dimension（1 インスタンス 1 フレーム。既存の Parametric Map と同じ並べ方）
        String dimOrgUid = newSeriesUid + ".1";
        if (dimOrgUid.length() > 64) {
            dimOrgUid = UIDUtils.createUID();
        }
        Attributes org = new Attributes();
        org.setString(Tag.DimensionOrganizationUID, VR.UI, dimOrgUid);
        a.newSequence(Tag.DimensionOrganizationSequence, 1).add(org);
        Attributes dim = new Attributes();
        dim.setString(Tag.DimensionOrganizationUID, VR.UI, dimOrgUid);
        dim.setInt(Tag.DimensionIndexPointer, VR.AT, Tag.ImagePositionPatient);
        dim.setInt(Tag.FunctionalGroupPointer, VR.AT, Tag.PlanePositionSequence);
        a.newSequence(Tag.DimensionIndexSequence, 1).add(dim);

        // 共有の機能グループ
        Attributes shared = new Attributes();
        Attributes po = new Attributes();
        po.setDouble(Tag.ImageOrientationPatient, VR.DS, iop);
        shared.newSequence(Tag.PlaneOrientationSequence, 1).add(po);
        Attributes pm = new Attributes();
        if (map.pixelSpacingRow() > 0 && map.pixelSpacingCol() > 0) {
            pm.setDouble(Tag.PixelSpacing, VR.DS, map.pixelSpacingRow(), map.pixelSpacingCol());
        }
        if (sliceThickness > 0) {
            pm.setDouble(Tag.SliceThickness, VR.DS, sliceThickness);
        }
        pm.setDouble(Tag.SpacingBetweenSlices, VR.DS, spacingBetween);
        shared.newSequence(Tag.PixelMeasuresSequence, 1).add(pm);
        Attributes ft = new Attributes();
        ft.setString(Tag.FrameType, VR.CS, imageType);
        shared.newSequence(Tag.ParametricMapFrameTypeSequence, 1).add(ft);
        // Modality LUT は恒等に固定（実値への換算は RWVM が持つ）
        Attributes pvt = new Attributes();
        pvt.setDouble(Tag.RescaleIntercept, VR.DS, 0.0);
        pvt.setDouble(Tag.RescaleSlope, VR.DS, 1.0);
        pvt.setString(Tag.RescaleType, VR.LO, "US");
        shared.newSequence(Tag.PixelValueTransformationSequence, 1).add(pvt);
        /*
         * 特徴値のとる範囲はモダリティ由来の W/L とは何の関係も無く、特徴ごとに桁も符号も違う。
         * 何も書かないとビューアは既定の窓で開き、マップは一様な白に潰れて何も読めない。
         * 窓は Modality LUT（恒等）の出力＝保存値に掛かるので、実値の窓を (実値−切片)/傾き に直して書く。
         */
        Attributes voi = new Attributes();
        voi.setDouble(Tag.WindowCenter, VR.DS, (windowCenter - intercept) / slope);
        voi.setDouble(Tag.WindowWidth, VR.DS, windowWidth / slope);
        voi.setString(Tag.VOILUTFunction, VR.CS, "LINEAR_EXACT");
        shared.newSequence(Tag.FrameVOILUTSequence, 1).add(voi);
        Attributes rw = new Attributes();
        rw.setInt(Tag.RealWorldValueFirstValueMapped, VR.US, 1); // 画素 0 は値なし
        rw.setInt(Tag.RealWorldValueLastValueMapped, VR.US, 65535);
        rw.setDouble(Tag.RealWorldValueSlope, VR.FD, slope);
        rw.setDouble(Tag.RealWorldValueIntercept, VR.FD, intercept);
        rw.setString(Tag.LUTLabel, VR.SH, cut(rescaleType, 16));
        rw.setString(Tag.LUTExplanation, VR.LO, cut(rescaleType, 64));
        Attributes unit = new Attributes();
        unit.setString(Tag.CodeValue, VR.SH, ucum == null ? "1" : ucum[0]);
        unit.setString(Tag.CodingSchemeDesignator, VR.SH, "UCUM");
        unit.setString(Tag.CodeMeaning, VR.LO, ucum == null ? "no units" : ucum[1]);
        rw.newSequence(Tag.MeasurementUnitsCodeSequence, 1).add(unit);
        shared.newSequence(Tag.RealWorldValueMappingSequence, 1).add(rw);
        a.newSequence(Tag.SharedFunctionalGroupsSequence, 1).add(shared);

        // フレームごとの機能グループ（位置・Frame Content・導出）
        Attributes frame = new Attributes();
        Attributes pp = new Attributes();
        pp.setDouble(Tag.ImagePositionPatient, VR.DS, ipp);
        frame.newSequence(Tag.PlanePositionSequence, 1).add(pp);
        Attributes fc = new Attributes();
        fc.setInt(Tag.DimensionIndexValues, VR.UL, z + 1);
        frame.newSequence(Tag.FrameContentSequence, 1).add(fc);

        String srcSop = (map.srcSopPerZ() != null && z < map.srcSopPerZ().size()) ? map.srcSopPerZ().get(z) : null;
        String srcSopClass = tmpl.getString(Tag.SOPClassUID);
        String srcSeries = tmpl.getString(Tag.SeriesInstanceUID);
        Attributes der = new Attributes();
        der.setString(Tag.DerivationDescription, VR.ST, derivation);
        Attributes code = new Attributes();
        code.setString(Tag.CodeValue, VR.SH, label);
        code.setString(Tag.CodingSchemeDesignator, VR.SH, PRIVATE_SCHEME);
        code.setString(Tag.CodeMeaning, VR.LO, log ? "Laplacian of Gaussian filter" : "Radiomics texture feature map");
        der.newSequence(Tag.DerivationCodeSequence, 1).add(code);
        Sequence srcSeq = der.newSequence(Tag.SourceImageSequence, 1);
        if (srcSop != null && srcSopClass != null) {
            Attributes ref = new Attributes(3);
            ref.setString(Tag.ReferencedSOPClassUID, VR.UI, srcSopClass);
            ref.setString(Tag.ReferencedSOPInstanceUID, VR.UI, srcSop);
            Attributes purpose = new Attributes();
            purpose.setString(Tag.CodeValue, VR.SH, "121322");
            purpose.setString(Tag.CodingSchemeDesignator, VR.SH, "DCM");
            purpose.setString(Tag.CodeMeaning, VR.LO, "Source image for image processing operation");
            ref.newSequence(Tag.PurposeOfReferenceCodeSequence, 1).add(purpose);
            srcSeq.add(ref);
        }
        frame.newSequence(Tag.DerivationImageSequence, 1).add(der);
        a.newSequence(Tag.PerFrameFunctionalGroupsSequence, 1).add(frame);

        // Acquisition Context（Type 2。導出画像なので空）
        a.newSequence(Tag.AcquisitionContextSequence, 0);

        // Common Instance Reference（導出元が同じ Study のとき必須）
        if (srcSop != null && srcSopClass != null && srcSeries != null) {
            Attributes inst = new Attributes(2);
            inst.setString(Tag.ReferencedSOPClassUID, VR.UI, srcSopClass);
            inst.setString(Tag.ReferencedSOPInstanceUID, VR.UI, srcSop);
            Attributes ser = new Attributes(2);
            ser.setString(Tag.SeriesInstanceUID, VR.UI, srcSeries);
            ser.newSequence(Tag.ReferencedInstanceSequence, 1).add(inst);
            a.newSequence(Tag.ReferencedSeriesSequence, 1).add(ser);
        }

        a.setBytes(Tag.PixelData, VR.OW, px);
        Utf8Output.apply(a); // 元からの写しがすべて終わった後で呼ぶ
        return a;
    }

    /** Type 2: 元に値があれば複写、無ければ空で書く（VR は元のものを優先）。 */
    private static void type2(Attributes from, Attributes to, int tag, VR vr) {
        String[] v = from.getStrings(tag);
        VR use = from.contains(tag) ? from.getVR(tag) : vr;
        if (v == null || v.length == 0) {
            to.setNull(tag, use);
        } else {
            to.setString(tag, use, v);
        }
    }

    private static String cut(String s, int max) {
        return s.length() > max ? s.substring(0, max) : s;
    }

    static void copyTag(Attributes from, Attributes to, int tag) {
        if (!from.contains(tag)) {
            return;
        }
        VR vr = from.getVR(tag);
        String[] v = from.getStrings(tag);
        if (v != null && v.length > 0) {
            to.setString(tag, vr, v);
        }
    }

    static Attributes readHeader(Path p) throws IOException {
        try (DicomInputStream in = new DicomInputStream(p.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            return in.readDataset();
        }
    }

    static void ingest(DicomStorageService storage, Attributes attrs) throws IOException {
        Path tmp = Files.createTempFile("texture-", ".dcm");
        boolean consumed = false;
        try {
            Attributes fmi = attrs.createFileMetaInformation(UID.ExplicitVRLittleEndian);
            try (DicomOutputStream dos = new DicomOutputStream(tmp.toFile())) {
                dos.writeDataset(fmi, attrs);
            }
            storage.ingest(tmp);
            consumed = true;
        } finally {
            if (!consumed) {
                Files.deleteIfExists(tmp);
            }
        }
    }
}

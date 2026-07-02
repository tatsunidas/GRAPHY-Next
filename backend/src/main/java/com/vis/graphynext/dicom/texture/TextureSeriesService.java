/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.texture;

import com.vis.graphynext.dicom.store.DicomStorageService;
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

    public TextureSeriesService(DicomStorageService storage, RadiomicsMapEngine engine) {
        this.storage = storage;
        this.engine = engine;
    }

    /** 生成結果。 */
    public record Result(String seriesInstanceUid, List<String> sopInstanceUids) {}

    /** マップを計算し派生シリーズとして保存する。 */
    public Result create(TextureSeriesRequest req) throws IOException {
        validate(req);

        // 属性テンプレート = 元シリーズ代表インスタンス。
        List<Path> srcFiles = storage.resolveFiles(req.studyInstanceUid(), List.of(req.sourceSeriesUid()));
        if (srcFiles.isEmpty()) {
            throw new IllegalArgumentException("ターゲットシリーズが見つかりません: " + req.sourceSeriesUid());
        }
        Attributes tmpl = readHeader(srcFiles.get(0));

        // マップ計算（重い）。
        RadiomicsMapEngine.MapResult map = engine.compute(req);

        // 32bit float → 16bit unsigned のスケール係数（GRAPHY convertTo16BitWithCalibration 準拠）。
        double[] mm = minMax(map.data());
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
        String derivation = "Texture map " + featureName + " (GRAPHY-Next Radiomics; kernel=" + req.filterSize()
                + ", stride=" + req.stride() + ", " + (req.force2D() ? "2D" : "3D") + ")";

        List<String> sops = new ArrayList<>(map.slices());
        for (int z = 0; z < map.slices(); z++) {
            byte[] px = to16bit(map.data()[z], slope, intercept);
            Attributes a = buildInstance(tmpl, req, map, newSeriesUid, seriesNumber, seriesDesc,
                    featureName, derivation, slope, intercept, sliceThickness, spacingBetween, z, px);
            sops.add(a.getString(Tag.SOPInstanceUID));
            ingest(a);
        }
        log.info("texture series created: {} ({} instances) feature={} from {}",
                newSeriesUid, sops.size(), featureName, req.sourceSeriesUid());
        return new Result(newSeriesUid, sops);
    }

    private void validate(TextureSeriesRequest req) {
        if (req.studyInstanceUid() == null || req.studyInstanceUid().isBlank()
                || req.sourceSeriesUid() == null || req.sourceSeriesUid().isBlank()) {
            throw new IllegalArgumentException("studyInstanceUid / sourceSeriesUid は必須です");
        }
        if (req.feature() == null || req.feature().isBlank()) {
            throw new IllegalArgumentException("feature は必須です（例 GLCM_JointEntropy）");
        }
    }

    /** 全スライスから NaN/Inf を除いた min/max。 */
    private static double[] minMax(float[][] data) {
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

    /** float[] → 16bit unsigned（リトルエンディアン byte[]）。pixel16 = round((v-intercept)/slope)。 */
    private static byte[] to16bit(float[] src, double slope, double intercept) {
        byte[] out = new byte[src.length * 2];
        for (int i = 0; i < src.length; i++) {
            float v = src[i];
            int p;
            if (Float.isNaN(v) || Float.isInfinite(v)) {
                p = 0;
            } else {
                p = (int) Math.floor((v - intercept) / slope + 0.5);
                if (p < 0) p = 0;
                if (p > 65535) p = 65535;
            }
            out[i * 2] = (byte) (p & 0xFF);
            out[i * 2 + 1] = (byte) ((p >> 8) & 0xFF);
        }
        return out;
    }

    /** 隣接 IPP 距離から SpacingBetweenSlices を推定（無ければ sliceThickness or 1）。 */
    private static double spacingFromIpp(List<double[]> ippPerZ, double sliceThickness) {
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

    /** 1 スライスの Attributes を構築（属性引き継ぎ＋16bit unsigned＋Rescale＋幾何）。 */
    private Attributes buildInstance(Attributes tmpl, TextureSeriesRequest req, RadiomicsMapEngine.MapResult map,
                                     String newSeriesUid, int seriesNumber, String seriesDesc, String featureName,
                                     String derivation, double slope, double intercept,
                                     double sliceThickness, double spacingBetween, int z, byte[] px) {
        Attributes a = new Attributes();
        double[] iop = map.imageOrientationPatient();
        boolean hasGeom = iop != null && iop.length == 6;

        int[] inherit = {
                Tag.SpecificCharacterSet,
                Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex, Tag.PatientAge,
                Tag.StudyInstanceUID, Tag.StudyDate, Tag.StudyTime, Tag.StudyID,
                Tag.AccessionNumber, Tag.StudyDescription, Tag.ReferringPhysicianName,
                Tag.Manufacturer, Tag.ManufacturerModelName,
                Tag.PatientPosition,
        };
        for (int tag : inherit) {
            copyTag(tmpl, a, tag);
        }
        if (hasGeom && map.frameOfReferenceUid() != null) {
            a.setString(Tag.FrameOfReferenceUID, VR.UI, map.frameOfReferenceUid());
            copyTag(tmpl, a, Tag.PositionReferenceIndicator);
        }
        if (a.getString(Tag.SpecificCharacterSet) == null) {
            a.setSpecificCharacterSet("ISO_IR 192");
        }
        if (a.getString(Tag.StudyInstanceUID) == null) {
            a.setString(Tag.StudyInstanceUID, VR.UI, req.studyInstanceUid());
        }

        // SOP Class = Secondary Capture（テクスチャ値は HU 等ではないため）。Modality は元を維持。
        a.setString(Tag.Modality, VR.CS, tmpl.getString(Tag.Modality, "OT"));
        a.setString(Tag.SOPClassUID, VR.UI, UID.SecondaryCaptureImageStorage);

        a.setString(Tag.SeriesInstanceUID, VR.UI, newSeriesUid);
        a.setInt(Tag.SeriesNumber, VR.IS, seriesNumber);
        a.setString(Tag.SeriesDescription, VR.LO, seriesDesc);

        a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        a.setInt(Tag.InstanceNumber, VR.IS, z + 1);
        a.setString(Tag.ImageType, VR.CS, "DERIVED", "SECONDARY", "TEXTURE");
        a.setString(Tag.DerivationDescription, VR.ST, derivation);
        copyTag(tmpl, a, Tag.ContentDate);
        copyTag(tmpl, a, Tag.ContentTime);

        // 画素モジュール（16bit unsigned MONOCHROME2）。
        a.setInt(Tag.Rows, VR.US, map.height());
        a.setInt(Tag.Columns, VR.US, map.width());
        a.setInt(Tag.BitsAllocated, VR.US, 16);
        a.setInt(Tag.BitsStored, VR.US, 15);
        a.setInt(Tag.HighBit, VR.US, 15);
        a.setInt(Tag.SamplesPerPixel, VR.US, 1);
        a.setInt(Tag.PixelRepresentation, VR.US, 0); // unsigned
        a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        // 32bit 原値を保持: value = px * slope + intercept。
        a.setDouble(Tag.RescaleIntercept, VR.DS, intercept);
        a.setDouble(Tag.RescaleSlope, VR.DS, slope);
        // RescaleType(LO, 64 桁): 校正済み画素値の意味＝特徴名。
        a.setString(Tag.RescaleType, VR.LO, featureName.length() > 64 ? featureName.substring(0, 64) : featureName);

        // 幾何（source と共有：Trilinear 拡大済みで 1:1）。
        if (hasGeom) {
            a.setDouble(Tag.ImageOrientationPatient, VR.DS, iop);
            double[] ipp = (map.ippPerZ() != null && z < map.ippPerZ().size()) ? map.ippPerZ().get(z) : null;
            if (ipp != null && ipp.length == 3) {
                a.setDouble(Tag.ImagePositionPatient, VR.DS, ipp);
            }
            a.setDouble(Tag.SpacingBetweenSlices, VR.DS, spacingBetween);
        }
        if (map.pixelSpacingRow() > 0 && map.pixelSpacingCol() > 0) {
            a.setDouble(Tag.PixelSpacing, VR.DS, map.pixelSpacingRow(), map.pixelSpacingCol());
        }
        if (sliceThickness > 0) {
            a.setDouble(Tag.SliceThickness, VR.DS, sliceThickness);
        }

        // トレーサビリティ: 元インスタンスへの参照。
        String srcSop = (map.srcSopPerZ() != null && z < map.srcSopPerZ().size()) ? map.srcSopPerZ().get(z) : null;
        String srcSopClass = tmpl.getString(Tag.SOPClassUID);
        if (srcSop != null && srcSopClass != null) {
            Attributes ref = new Attributes(2);
            ref.setString(Tag.ReferencedSOPClassUID, VR.UI, srcSopClass);
            ref.setString(Tag.ReferencedSOPInstanceUID, VR.UI, srcSop);
            Sequence seq = a.newSequence(Tag.SourceImageSequence, 1);
            seq.add(ref);
        }

        a.setBytes(Tag.PixelData, VR.OW, px);
        return a;
    }

    private static void copyTag(Attributes from, Attributes to, int tag) {
        if (!from.contains(tag)) {
            return;
        }
        VR vr = from.getVR(tag);
        String[] v = from.getStrings(tag);
        if (v != null && v.length > 0) {
            to.setString(tag, vr, v);
        }
    }

    private Attributes readHeader(Path p) throws IOException {
        try (DicomInputStream in = new DicomInputStream(p.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            return in.readDataset();
        }
    }

    private void ingest(Attributes attrs) throws IOException {
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

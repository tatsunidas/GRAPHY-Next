/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.microscopy;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.util.UIDUtils;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;

/**
 * 顕微鏡の 1 チャネル（Z×T のフレーム）を Confocal Microscopy Image（CFM、1.2.840.10008.5.1.4.1.1.77.1.8）の
 * マルチフレーム 1 インスタンスにする（fw/microscopy-cfm.md）。
 *
 * <p><b>規格外</b>: 値は 32 ビット浮動小数（Float Pixel Data）で持つ。PS3.3 C.8.12.1.1.2 は Bits Allocated=8 だけを許す
 * （2026-10-17 ユーザー決定。ImageComments に明記する）。照明の波長が分からないときも、波長・色の 1C を入れない（値を作らない）。
 * それ以外の必須項目（Type 1）は、元のファイルに無いものを変換器が作り、作ったことを記録する。
 */
public final class ConfocalMicroscopyWriter {

    public static final String NON_STANDARD_NOTE =
            "Non-standard: 32-bit float pixel data in Confocal Microscopy Image (PS3.3 C.8.12.1.1.2 allows 8-bit only)";
    public static final String ILLUMINATION_UNKNOWN_NOTE =
            "Illumination wavelength/color unknown in the source (not recorded)";

    /** 解剖部位のコード（既定は SCT 91723000 "Anatomical Structure"、PS3.16 CID 9501）。 */
    public record Code(String value, String scheme, String meaning) {
        public static final Code ANATOMICAL_STRUCTURE = new Code("91723000", "SCT", "Anatomical Structure");
    }

    /** 変換した本体（装置）。シリアル番号はインストールごとの識別子（2026-10-17 ユーザー決定）。 */
    public record Equipment(String manufacturer, String model, String serial, String softwareVersion) {
    }

    /**
     * @param frames         フレームの値。並びは t が外側・z が内側（frames.get(t * nz + z)）。各 width×height
     * @param spacingMm      {x, y, z} mm
     * @param channelName    光路の名前（チャネル名・色素名）
     * @param wavelengthNm   照明の波長 nm（分からなければ null）
     * @param confocalMode   FLUORESCENCE / REFLECTANCE
     * @param sourceFormat   変換元（"Zeiss LSM" など）
     */
    public record Request(int width, int height, int nz, int nt, List<float[]> frames, double[] spacingMm,
                          String channelName, Double wavelengthNm, String confocalMode, String sourceFormat,
                          String sourceName, Code anatomy, Equipment equipment,
                          String patientId, String patientName, String patientBirthDate, String patientSex,
                          String studyInstanceUid, String studyDescription, String seriesInstanceUid,
                          String seriesDescription, int seriesNumber, String frameOfReferenceUid,
                          String specimenUid) {
    }

    private ConfocalMicroscopyWriter() {
    }

    public static Attributes write(Request r) {
        if (r.frames().size() != r.nz() * Math.max(1, r.nt())) {
            throw new IllegalArgumentException("フレームの数が Z×T と合いません: " + r.frames().size());
        }
        String now = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"));
        String time = LocalDateTime.now().format(DateTimeFormatter.ofPattern("HHmmss"));
        Attributes ds = new Attributes();
        ds.setString(Tag.SpecificCharacterSet, VR.CS, "ISO_IR 192");
        ds.setString(Tag.SOPClassUID, VR.UI, UID.ConfocalMicroscopyImageStorage);
        ds.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        // Patient・Study・Series
        ds.setString(Tag.PatientID, VR.LO, nvl(r.patientId(), "MICROSCOPY"));
        ds.setString(Tag.PatientName, VR.PN, nvl(r.patientName(), nvl(r.patientId(), "MICROSCOPY")));
        ds.setString(Tag.PatientBirthDate, VR.DA, nvl(r.patientBirthDate(), ""));
        ds.setString(Tag.PatientSex, VR.CS, nvl(r.patientSex(), ""));
        ds.setString(Tag.StudyInstanceUID, VR.UI, nvl(r.studyInstanceUid(), UIDUtils.createUID()));
        ds.setString(Tag.StudyDate, VR.DA, now);
        ds.setString(Tag.StudyTime, VR.TM, time);
        ds.setString(Tag.ReferringPhysicianName, VR.PN, "");
        ds.setString(Tag.StudyID, VR.SH, "");
        ds.setString(Tag.AccessionNumber, VR.SH, "");
        ds.setString(Tag.StudyDescription, VR.LO, nvl(r.studyDescription(), "Imported microscopy"));
        ds.setString(Tag.Modality, VR.CS, "CFM");
        ds.setString(Tag.SeriesInstanceUID, VR.UI, nvl(r.seriesInstanceUid(), UIDUtils.createUID()));
        ds.setInt(Tag.SeriesNumber, VR.IS, Math.max(1, r.seriesNumber()));
        ds.setString(Tag.SeriesDescription, VR.LO, nvl(r.seriesDescription(), nvl(r.channelName(), "CFM")));
        ds.setString(Tag.FrameOfReferenceUID, VR.UI, nvl(r.frameOfReferenceUid(), UIDUtils.createUID()));
        ds.setString(Tag.PositionReferenceIndicator, VR.LO, "SLIDECORNER");
        // Equipment（General・Enhanced General）
        Equipment eq = r.equipment();
        ds.setString(Tag.Manufacturer, VR.LO, eq.manufacturer());
        ds.setString(Tag.ManufacturerModelName, VR.LO, eq.model());
        ds.setString(Tag.DeviceSerialNumber, VR.LO, eq.serial());
        ds.setString(Tag.SoftwareVersions, VR.LO, eq.softwareVersion());
        // General Image・Multi-frame Functional Groups
        ds.setInt(Tag.InstanceNumber, VR.IS, 1);
        ds.setString(Tag.ContentDate, VR.DA, now);
        ds.setString(Tag.ContentTime, VR.TM, time);
        ds.setString(Tag.ImageType, VR.CS, "ORIGINAL", "PRIMARY", "VOLUME", "NONE");
        ds.setString(Tag.LossyImageCompression, VR.CS, "00");
        ds.setString(Tag.BurnedInAnnotation, VR.CS, "NO");
        ds.setString(Tag.DerivationDescription, VR.ST,
                "Converted from " + nvl(r.sourceFormat(), "microscopy data") + " (" + nvl(r.sourceName(), "") + ")");
        StringBuilder comments = new StringBuilder(NON_STANDARD_NOTE);
        if (r.wavelengthNm() == null) {
            comments.append(" / ").append(ILLUMINATION_UNKNOWN_NOTE);
        }
        comments.append(" / Specimen identifiers generated by the converter");
        ds.setString(Tag.ImageComments, VR.LT, comments.toString());
        // Confocal Microscopy Image
        String mode = "REFLECTANCE".equalsIgnoreCase(r.confocalMode()) ? "REFLECTANCE" : "FLUORESCENCE";
        ds.setString(Tag.ConfocalMode, VR.CS, mode);
        ds.setString(Tag.TissueLocation, VR.CS, "EXVIVO");
        // Image Pixel（規格外: 32 ビット浮動小数）
        ds.setInt(Tag.SamplesPerPixel, VR.US, 1);
        ds.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        ds.setInt(Tag.Rows, VR.US, r.height());
        ds.setInt(Tag.Columns, VR.US, r.width());
        ds.setInt(Tag.BitsAllocated, VR.US, 32);
        int nf = r.frames().size();
        ds.setInt(Tag.NumberOfFrames, VR.IS, nf);
        // Acquisition Context（Type 2、空）
        ds.newSequence(Tag.AcquisitionContextSequence, 0);
        // Specimen（元のファイルに無いので変換器が作る）
        String specimenUid = nvl(r.specimenUid(), UIDUtils.createUID());
        ds.setString(Tag.ContainerIdentifier, VR.LO, trim64(nvl(r.sourceName(), "UNKNOWN")));
        ds.newSequence(Tag.IssuerOfTheContainerIdentifierSequence, 0);
        ds.newSequence(Tag.ContainerTypeCodeSequence, 0);
        Attributes spec = new Attributes();
        spec.setString(Tag.SpecimenIdentifier, VR.LO, trim64(nvl(r.sourceName(), "UNKNOWN")));
        spec.newSequence(Tag.IssuerOfTheSpecimenIdentifierSequence, 0);
        spec.setString(Tag.SpecimenUID, VR.UI, specimenUid);
        spec.newSequence(Tag.SpecimenPreparationSequence, 0);
        ds.newSequence(Tag.SpecimenDescriptionSequence, 1).add(spec);
        // Optical Path
        Attributes op = new Attributes();
        op.setString(Tag.OpticalPathIdentifier, VR.SH, "1");
        op.setString(Tag.OpticalPathDescription, VR.ST, nvl(r.channelName(), ""));
        if (r.wavelengthNm() != null) {
            op.setFloat(Tag.IlluminationWaveLength, VR.FL, r.wavelengthNm().floatValue());
        }
        // 照明方式（PS3.16 CID 8123）: 蛍光は落射蛍光、反射は反射照明
        op.newSequence(Tag.IlluminationTypeCodeSequence, 1).add("REFLECTANCE".equals(mode)
                ? code("111742", "DCM", "Reflection illumination")
                : code("111743", "DCM", "Epifluorescence illumination"));
        ds.setInt(Tag.NumberOfOpticalPaths, VR.UL, 1);
        ds.newSequence(Tag.OpticalPathSequence, 1).add(op);
        // Multi-frame Dimension（Z・T）
        String dimOrg = UIDUtils.createUID();
        ds.newSequence(Tag.DimensionOrganizationSequence, 1).add(single(Tag.DimensionOrganizationUID, VR.UI, dimOrg));
        ds.setString(Tag.DimensionOrganizationType, VR.CS, "3D");
        Sequence dimIdx = ds.newSequence(Tag.DimensionIndexSequence, 2);
        dimIdx.add(dimItem(dimOrg, Tag.ZOffsetInSlideCoordinateSystem, Tag.PlanePositionSlideSequence));
        dimIdx.add(dimItem(dimOrg, Tag.TemporalPositionIndex, Tag.FrameContentSequence));
        // Shared Functional Groups
        Attributes shared = new Attributes();
        Attributes pm = new Attributes();
        pm.setDouble(Tag.PixelSpacing, VR.DS, r.spacingMm()[1], r.spacingMm()[0]); // 行の間隔\列の間隔
        pm.setDouble(Tag.SliceThickness, VR.DS, r.spacingMm()[2]);
        pm.setDouble(Tag.SpacingBetweenSlices, VR.DS, r.spacingMm()[2]);
        shared.newSequence(Tag.PixelMeasuresSequence, 1).add(pm);
        Attributes opi = new Attributes();
        opi.setString(Tag.OpticalPathIdentifier, VR.SH, "1");
        shared.newSequence(Tag.OpticalPathIdentificationSequence, 1).add(opi);
        Attributes anat = new Attributes();
        Code ac = r.anatomy() == null ? Code.ANATOMICAL_STRUCTURE : r.anatomy();
        anat.newSequence(Tag.AnatomicRegionSequence, 1).add(code(ac.value(), ac.scheme(), ac.meaning()));
        anat.setString(Tag.FrameLaterality, VR.CS, "U");
        shared.newSequence(Tag.FrameAnatomySequence, 1).add(anat);
        Attributes ft = new Attributes();
        ft.setString(Tag.FrameType, VR.CS, "ORIGINAL", "PRIMARY", "VOLUME", "NONE");
        shared.newSequence(Tag.ConfocalMicroscopyImageFrameTypeSequence, 1).add(ft);
        Attributes rw = new Attributes();
        // Parametric Map の書き方（NiftiToDicom.toParametricMap）と同じ: 浮動小数の全域を傾き 1・切片 0 で写す
        rw.setDouble(Tag.DoubleFloatRealWorldValueFirstValueMapped, VR.FD, -Float.MAX_VALUE);
        rw.setDouble(Tag.DoubleFloatRealWorldValueLastValueMapped, VR.FD, Float.MAX_VALUE);
        rw.setDouble(Tag.RealWorldValueSlope, VR.FD, 1.0);
        rw.setDouble(Tag.RealWorldValueIntercept, VR.FD, 0.0);
        rw.setString(Tag.LUTLabel, VR.SH, "MICROSCOPY");
        rw.setString(Tag.LUTExplanation, VR.LO, "Values as stored in the source file");
        rw.newSequence(Tag.MeasurementUnitsCodeSequence, 1).add(code("1", "UCUM", "no units"));
        shared.newSequence(Tag.RealWorldValueMappingSequence, 1).add(rw);
        ds.newSequence(Tag.SharedFunctionalGroupsSequence, 1).add(shared);
        // Per-frame Functional Groups
        Sequence pf = ds.newSequence(Tag.PerFrameFunctionalGroupsSequence, nf);
        int nz = r.nz();
        int nt = Math.max(1, r.nt());
        double zUm = r.spacingMm()[2] * 1000.0;
        for (int t = 0; t < nt; t++) {
            for (int z = 0; z < nz; z++) {
                Attributes fr = new Attributes();
                Attributes sp = new Attributes();
                sp.setInt(Tag.ColumnPositionInTotalImagePixelMatrix, VR.SL, 1);
                sp.setInt(Tag.RowPositionInTotalImagePixelMatrix, VR.SL, 1);
                sp.setDouble(Tag.XOffsetInSlideCoordinateSystem, VR.DS, 0.0);
                sp.setDouble(Tag.YOffsetInSlideCoordinateSystem, VR.DS, 0.0);
                sp.setDouble(Tag.ZOffsetInSlideCoordinateSystem, VR.DS, z * zUm); // µm（PS3.3 C.8.12.2）
                fr.newSequence(Tag.PlanePositionSlideSequence, 1).add(sp);
                Attributes fc = new Attributes();
                fc.setInt(Tag.DimensionIndexValues, VR.UL, z + 1, t + 1);
                fc.setInt(Tag.TemporalPositionIndex, VR.UL, t + 1);
                fr.newSequence(Tag.FrameContentSequence, 1).add(fc);
                pf.add(fr);
            }
        }
        // Float Pixel Data（リトルエンディアン）
        int n = r.width() * r.height();
        ByteBuffer px = ByteBuffer.allocate(nf * n * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (float[] f : r.frames()) {
            if (f.length != n) {
                throw new IllegalArgumentException("フレームの画素数が幅×高さと合いません");
            }
            for (float v : f) {
                px.putFloat(v);
            }
        }
        ds.setBytes(Tag.FloatPixelData, VR.OF, px.array());
        return ds;
    }

    private static Attributes code(String value, String scheme, String meaning) {
        Attributes c = new Attributes();
        c.setString(Tag.CodeValue, VR.SH, value);
        c.setString(Tag.CodingSchemeDesignator, VR.SH, scheme);
        c.setString(Tag.CodeMeaning, VR.LO, meaning);
        return c;
    }

    private static Attributes single(int tag, VR vr, String v) {
        Attributes a = new Attributes();
        a.setString(tag, vr, v);
        return a;
    }

    private static Attributes dimItem(String dimOrg, int pointer, int group) {
        Attributes d = new Attributes();
        d.setString(Tag.DimensionOrganizationUID, VR.UI, dimOrg);
        d.setInt(Tag.DimensionIndexPointer, VR.AT, pointer);
        d.setInt(Tag.FunctionalGroupPointer, VR.AT, group);
        return d;
    }

    private static String nvl(String v, String fb) {
        return v == null || v.isBlank() ? fb : v;
    }

    private static String trim64(String s) {
        return s.length() > 64 ? s.substring(0, 64) : s;
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

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
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * マスク（labelmap）→ DICOM SEG（BINARY）書き出し。GRAPHY の SegWriter を移植（dcm4che 直 Attributes）。
 * 参照シリーズのヘッダから患者/検査を継承し、Shared/PerFrame FunctionalGroups と LSB-first ビットパック
 * PixelData を組み、保管庫へ ingest する。読込（`DicomStorageService.segLayoutIfApplicable`）と対称。
 */
@Service
public class SegExportService {

    private static final Logger log = LoggerFactory.getLogger(SegExportService.class);

    private final DicomStorageService storage;

    public SegExportService(DicomStorageService storage) {
        this.storage = storage;
    }

    public record Result(String seriesInstanceUid, String sopInstanceUid) {
    }

    public Result export(SegExportRequest req) throws IOException {
        validate(req);
        List<Path> srcFiles = storage.resolveFiles(req.studyInstanceUid(), List.of(req.seriesInstanceUid()));
        if (srcFiles.isEmpty()) {
            throw new IllegalArgumentException("参照シリーズが見つかりません (study=" + req.studyInstanceUid()
                    + ", series=" + req.seriesInstanceUid() + ")");
        }
        Attributes tmpl = readHeader(srcFiles.get(0));

        final int rows = req.rows();
        final int cols = req.columns();
        final int frameSize = rows * cols;

        // PerFrame の順序でフレームを平坦化（bit-pack と同順）。
        final List<SegExportRequest.Segment> segs = req.segments();
        int totalFrames = 0;
        for (SegExportRequest.Segment s : segs) {
            totalFrames += s.frames() != null ? s.frames().size() : 0;
        }
        if (totalFrames == 0) {
            throw new IllegalArgumentException("非空フレームがありません");
        }

        String newSeriesUid = UIDUtils.createUID();
        String newSopUid = UIDUtils.createUID();
        String dimOrgUid = UIDUtils.createUID();

        Attributes a = new Attributes();
        // 患者・検査を参照シリーズから継承。
        for (int tag : new int[] { Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex,
                Tag.StudyInstanceUID, Tag.StudyDate, Tag.StudyTime, Tag.StudyID, Tag.AccessionNumber,
                Tag.ReferringPhysicianName, Tag.StudyDescription }) {
            copyTag(tmpl, a, tag);
        }
        // SEG 本体属性。
        a.setString(Tag.SOPClassUID, VR.UI, UID.SegmentationStorage);
        a.setString(Tag.SOPInstanceUID, VR.UI, newSopUid);
        a.setString(Tag.Modality, VR.CS, "SEG");
        a.setString(Tag.SeriesInstanceUID, VR.UI, newSeriesUid);
        a.setInt(Tag.SeriesNumber, VR.IS, tmpl.getInt(Tag.SeriesNumber, 0) + 5000);
        a.setInt(Tag.InstanceNumber, VR.IS, 1);
        a.setString(Tag.SeriesDescription, VR.LO,
                req.seriesDescription() != null && !req.seriesDescription().isBlank()
                        ? req.seriesDescription() : "Segmentation");
        a.setString(Tag.ImageType, VR.CS, "DERIVED", "PRIMARY");
        a.setString(Tag.SegmentationType, VR.CS, "BINARY");
        a.setString(Tag.ContentLabel, VR.CS, "SEG");
        a.setString(Tag.ContentDescription, VR.LO, "GRAPHY-Next Segmentation");
        a.setString(Tag.ContentCreatorName, VR.PN, "GRAPHY-Next");
        copyTag(tmpl, a, Tag.ContentDate);
        copyTag(tmpl, a, Tag.ContentTime);
        if (req.frameOfReferenceUID() != null && !req.frameOfReferenceUID().isBlank()) {
            a.setString(Tag.FrameOfReferenceUID, VR.UI, req.frameOfReferenceUID());
        }
        // 画素属性（BINARY = 1bit）。
        a.setInt(Tag.SamplesPerPixel, VR.US, 1);
        a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        a.setInt(Tag.Rows, VR.US, rows);
        a.setInt(Tag.Columns, VR.US, cols);
        a.setInt(Tag.BitsAllocated, VR.US, 1);
        a.setInt(Tag.BitsStored, VR.US, 1);
        a.setInt(Tag.HighBit, VR.US, 0);
        a.setInt(Tag.PixelRepresentation, VR.US, 0);
        a.setString(Tag.LossyImageCompression, VR.CS, "00");
        a.setInt(Tag.NumberOfFrames, VR.IS, totalFrames);

        // DimensionOrganization / DimensionIndex（segment#, IPP）。
        Sequence dimOrg = a.newSequence(Tag.DimensionOrganizationSequence, 1);
        Attributes dimOrgItem = new Attributes();
        dimOrgItem.setString(Tag.DimensionOrganizationUID, VR.UI, dimOrgUid);
        dimOrg.add(dimOrgItem);
        Sequence dimIdx = a.newSequence(Tag.DimensionIndexSequence, 2);
        dimIdx.add(dimIndexItem(dimOrgUid, Tag.ReferencedSegmentNumber, Tag.SegmentIdentificationSequence));
        dimIdx.add(dimIndexItem(dimOrgUid, Tag.ImagePositionPatient, Tag.PlanePositionSequence));

        // SegmentSequence。
        Sequence segSeq = a.newSequence(Tag.SegmentSequence, segs.size());
        for (SegExportRequest.Segment s : segs) {
            segSeq.add(segmentItem(s));
        }

        // SharedFunctionalGroupsSequence（IOP・PixelMeasures）。
        Sequence shared = a.newSequence(Tag.SharedFunctionalGroupsSequence, 1);
        Attributes sharedItem = new Attributes();
        Sequence po = sharedItem.newSequence(Tag.PlaneOrientationSequence, 1);
        Attributes poItem = new Attributes();
        poItem.setDouble(Tag.ImageOrientationPatient, VR.DS, req.imageOrientationPatient());
        po.add(poItem);
        Sequence pm = sharedItem.newSequence(Tag.PixelMeasuresSequence, 1);
        Attributes pmItem = new Attributes();
        // PixelSpacing は [row, col]。req.pixelSpacing() を [row,col] で受ける。
        pmItem.setDouble(Tag.PixelSpacing, VR.DS, req.pixelSpacing()[0], req.pixelSpacing()[1]);
        double thick = req.sliceThickness() > 0 ? req.sliceThickness() : 1.0;
        pmItem.setDouble(Tag.SliceThickness, VR.DS, thick);
        pmItem.setDouble(Tag.SpacingBetweenSlices, VR.DS, thick);
        pm.add(pmItem);
        shared.add(sharedItem);

        // PerFrameFunctionalGroupsSequence ＋ PixelData（LSB-first bit-pack）。
        Sequence perFrame = a.newSequence(Tag.PerFrameFunctionalGroupsSequence, totalFrames);
        long totalBits = (long) totalFrames * frameSize;
        byte[] packed = new byte[(int) ((totalBits + 7) / 8)];
        String srcClassUid = tmpl.getString(Tag.SOPClassUID);
        Set<String> refSops = new LinkedHashSet<>();
        long bitPos = 0;
        for (SegExportRequest.Segment s : segs) {
            int spatialIdx = 0;
            for (SegExportRequest.Frame fr : s.frames()) {
                spatialIdx++;
                byte[] plane = Base64.getDecoder().decode(fr.mask());
                if (plane.length != frameSize) {
                    throw new IllegalArgumentException("mask バイト長が rows*cols と不一致 (got=" + plane.length
                            + ", expected=" + frameSize + ")");
                }
                for (int idx = 0; idx < frameSize; idx++, bitPos++) {
                    if (plane[idx] != 0) {
                        packed[(int) (bitPos >> 3)] |= (byte) (1 << (int) (bitPos & 7));
                    }
                }
                perFrame.add(perFrameItem(s.number(), spatialIdx, fr, srcClassUid));
                if (fr.sopInstanceUid() != null && !fr.sopInstanceUid().isBlank()) {
                    refSops.add(fr.sopInstanceUid());
                }
            }
        }
        a.setBytes(Tag.PixelData, VR.OB, packed);

        // ReferencedSeriesSequence（参照元シリーズと全参照インスタンス）。
        if (!refSops.isEmpty()) {
            Sequence refSeries = a.newSequence(Tag.ReferencedSeriesSequence, 1);
            Attributes rsItem = new Attributes();
            rsItem.setString(Tag.SeriesInstanceUID, VR.UI, req.seriesInstanceUid());
            Sequence refInst = rsItem.newSequence(Tag.ReferencedInstanceSequence, refSops.size());
            for (String sop : refSops) {
                Attributes ri = new Attributes();
                if (srcClassUid != null) ri.setString(Tag.ReferencedSOPClassUID, VR.UI, srcClassUid);
                ri.setString(Tag.ReferencedSOPInstanceUID, VR.UI, sop);
                refInst.add(ri);
            }
            refSeries.add(rsItem);
        }

        ingest(a);
        log.info("DICOM SEG exported: series={} sop={} frames={} segments={} from {}",
                newSeriesUid, newSopUid, totalFrames, segs.size(), req.seriesInstanceUid());
        return new Result(newSeriesUid, newSopUid);
    }

    // --- helpers ---

    private void validate(SegExportRequest req) {
        if (req.studyInstanceUid() == null || req.studyInstanceUid().isBlank()
                || req.seriesInstanceUid() == null || req.seriesInstanceUid().isBlank()) {
            throw new IllegalArgumentException("studyInstanceUid / seriesInstanceUid は必須です");
        }
        if (req.rows() <= 0 || req.columns() <= 0) {
            throw new IllegalArgumentException("rows / columns が不正です");
        }
        if (req.imageOrientationPatient() == null || req.imageOrientationPatient().length != 6) {
            throw new IllegalArgumentException("imageOrientationPatient は 6 要素が必要です");
        }
        if (req.pixelSpacing() == null || req.pixelSpacing().length != 2) {
            throw new IllegalArgumentException("pixelSpacing は 2 要素 [row,col] が必要です");
        }
        if (req.segments() == null || req.segments().isEmpty()) {
            throw new IllegalArgumentException("segments が空です");
        }
    }

    private Attributes segmentItem(SegExportRequest.Segment s) {
        Attributes item = new Attributes();
        item.setInt(Tag.SegmentNumber, VR.US, s.number());
        item.setString(Tag.SegmentLabel, VR.LO, s.label() != null ? s.label() : "Segment " + s.number());
        item.setString(Tag.SegmentAlgorithmType, VR.CS, "MANUAL");
        if (s.color() != null && s.color().length >= 3) {
            item.setInt(Tag.RecommendedDisplayCIELabValue, VR.US, rgbToCieLab(s.color()[0], s.color()[1], s.color()[2]));
        }
        // 汎用の SegmentedProperty コード（Tissue）。IOD の必須要素を満たす。
        item.newSequence(Tag.SegmentedPropertyCategoryCodeSequence, 1)
                .add(codeItem("T-D0050", "SRT", "Tissue"));
        item.newSequence(Tag.SegmentedPropertyTypeCodeSequence, 1)
                .add(codeItem("T-D0050", "SRT", "Tissue"));
        return item;
    }

    private Attributes perFrameItem(int segNumber, int spatialIdx, SegExportRequest.Frame fr, String srcClassUid) {
        Attributes item = new Attributes();
        Sequence fc = item.newSequence(Tag.FrameContentSequence, 1);
        Attributes fcItem = new Attributes();
        fcItem.setInt(Tag.DimensionIndexValues, VR.UL, segNumber, spatialIdx);
        fc.add(fcItem);
        Sequence pp = item.newSequence(Tag.PlanePositionSequence, 1);
        Attributes ppItem = new Attributes();
        if (fr.imagePositionPatient() != null && fr.imagePositionPatient().length >= 3) {
            ppItem.setDouble(Tag.ImagePositionPatient, VR.DS,
                    fr.imagePositionPatient()[0], fr.imagePositionPatient()[1], fr.imagePositionPatient()[2]);
        }
        pp.add(ppItem);
        Sequence sid = item.newSequence(Tag.SegmentIdentificationSequence, 1);
        Attributes sidItem = new Attributes();
        sidItem.setInt(Tag.ReferencedSegmentNumber, VR.US, segNumber);
        sid.add(sidItem);
        // DerivationImage → SourceImage（参照 source スライス）。任意だが読込との対称性のため付与。
        if (fr.sopInstanceUid() != null && !fr.sopInstanceUid().isBlank() && srcClassUid != null) {
            Sequence di = item.newSequence(Tag.DerivationImageSequence, 1);
            Attributes diItem = new Attributes();
            Sequence si = diItem.newSequence(Tag.SourceImageSequence, 1);
            Attributes siItem = new Attributes();
            siItem.setString(Tag.ReferencedSOPClassUID, VR.UI, srcClassUid);
            siItem.setString(Tag.ReferencedSOPInstanceUID, VR.UI, fr.sopInstanceUid());
            si.add(siItem);
            di.add(diItem);
        }
        return item;
    }

    private Attributes dimIndexItem(String dimOrgUid, int pointer, int functionalGroupPointer) {
        Attributes item = new Attributes();
        item.setString(Tag.DimensionOrganizationUID, VR.UI, dimOrgUid);
        item.setInt(Tag.DimensionIndexPointer, VR.AT, pointer);
        item.setInt(Tag.FunctionalGroupPointer, VR.AT, functionalGroupPointer);
        return item;
    }

    private Attributes codeItem(String codeValue, String scheme, String meaning) {
        Attributes item = new Attributes();
        item.setString(Tag.CodeValue, VR.SH, codeValue);
        item.setString(Tag.CodingSchemeDesignator, VR.SH, scheme);
        item.setString(Tag.CodeMeaning, VR.LO, meaning);
        return item;
    }

    /** sRGB(0..255) → DICOM RecommendedDisplayCIELabValue（各 0..65535, [L*,a*,b*]）。GRAPHY 移植。 */
    static int[] rgbToCieLab(int r8, int g8, int b8) {
        double r = srgbToLinear(r8 / 255.0);
        double g = srgbToLinear(g8 / 255.0);
        double b = srgbToLinear(b8 / 255.0);
        double x = r * 0.4124 + g * 0.3576 + b * 0.1805;
        double y = r * 0.2126 + g * 0.7152 + b * 0.0722;
        double z = r * 0.0193 + g * 0.1192 + b * 0.9505;
        double fx = labF(x / 0.95047);
        double fy = labF(y / 1.0);
        double fz = labF(z / 1.08883);
        double lStar = 116.0 * fy - 16.0;
        double aStar = 500.0 * (fx - fy);
        double bStar = 200.0 * (fy - fz);
        int li = clamp16((int) Math.round(lStar * 65535.0 / 100.0));
        int ai = clamp16((int) Math.round((aStar + 128.0) * 65535.0 / 255.0));
        int bi = clamp16((int) Math.round((bStar + 128.0) * 65535.0 / 255.0));
        return new int[] { li, ai, bi };
    }

    private static double srgbToLinear(double c) {
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    private static double labF(double t) {
        return t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16.0 / 116.0);
    }

    private static int clamp16(int v) {
        return v < 0 ? 0 : (v > 65535 ? 65535 : v);
    }

    private static void copyTag(Attributes from, Attributes to, int tag) {
        if (!from.contains(tag)) return;
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
        Path tmp = Files.createTempFile("seg-", ".dcm");
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

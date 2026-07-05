/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
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
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 2D ベクタ ROI → DICOM RT Structure Set 書き出し。閉輪郭（CLOSED_PLANAR, 患者座標 mm）を
 * StructureSetROI / ROIContour / RTROIObservations にして保管庫へ ingest する
 * （`fw/dicom-seg-rtstruct-design.md` S2）。
 */
@Service
public class RtStructExportService {

    private static final Logger log = LoggerFactory.getLogger(RtStructExportService.class);

    /** Detached Study Management SOP Class（RTReferencedStudy 用）。 */
    private static final String STUDY_COMPONENT_MGMT = "1.2.840.10008.3.1.2.3.1";

    private final DicomStorageService storage;
    /** web モードのときだけ存在（STOW-RS 書き戻し用）。standalone では null。 */
    private final ObjectProvider<WebDicomDataService> webProvider;

    public RtStructExportService(DicomStorageService storage, ObjectProvider<WebDicomDataService> webProvider) {
        this.storage = storage;
        this.webProvider = webProvider;
    }

    public record Result(String seriesInstanceUid, String sopInstanceUid) {
    }

    public Result export(RtStructExportRequest req) throws IOException {
        validate(req);
        WebDicomDataService web = webProvider != null ? webProvider.getIfAvailable() : null;
        // 参照シリーズ属性テンプレート: standalone はローカル、web は WADO-RS /metadata の先頭インスタンス。
        Attributes tmpl;
        if (web != null) {
            List<Attributes> metas = web.seriesMetadata(req.studyInstanceUid(), req.seriesInstanceUid());
            if (metas.isEmpty()) {
                throw new IllegalArgumentException("参照シリーズが見つかりません (web, study="
                        + req.studyInstanceUid() + ", series=" + req.seriesInstanceUid() + ")");
            }
            tmpl = metas.get(0);
        } else {
            List<Path> srcFiles = storage.resolveFiles(req.studyInstanceUid(), List.of(req.seriesInstanceUid()));
            if (srcFiles.isEmpty()) {
                throw new IllegalArgumentException("参照シリーズが見つかりません (study=" + req.studyInstanceUid()
                        + ", series=" + req.seriesInstanceUid() + ")");
            }
            tmpl = readHeader(srcFiles.get(0));
        }
        String srcClassUid = tmpl.getString(Tag.SOPClassUID);
        String forUid = req.frameOfReferenceUID();

        String newSeriesUid = UIDUtils.createUID();
        String newSopUid = UIDUtils.createUID();

        Attributes a = new Attributes();
        for (int tag : new int[] { Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex,
                Tag.StudyInstanceUID, Tag.StudyDate, Tag.StudyTime, Tag.StudyID, Tag.AccessionNumber,
                Tag.ReferringPhysicianName, Tag.StudyDescription }) {
            copyTag(tmpl, a, tag);
        }
        a.setString(Tag.SOPClassUID, VR.UI, UID.RTStructureSetStorage);
        a.setString(Tag.SOPInstanceUID, VR.UI, newSopUid);
        a.setString(Tag.Modality, VR.CS, "RTSTRUCT");
        a.setString(Tag.SeriesInstanceUID, VR.UI, newSeriesUid);
        a.setInt(Tag.SeriesNumber, VR.IS, tmpl.getInt(Tag.SeriesNumber, 0) + 5100);
        a.setInt(Tag.InstanceNumber, VR.IS, 1);
        String label = req.structureSetLabel() != null && !req.structureSetLabel().isBlank()
                ? req.structureSetLabel() : "ROI";
        a.setString(Tag.StructureSetLabel, VR.SH, label);
        a.setString(Tag.StructureSetName, VR.LO, label);
        a.setString(Tag.SeriesDescription, VR.LO, "RTSTRUCT: " + label);
        copyTag(tmpl, a, Tag.StudyDate);
        copyTag(tmpl, a, Tag.StudyTime);

        // 全 ROI が参照するスライス SOP（ContourImage 用）。
        Set<String> refSops = new LinkedHashSet<>();
        for (RtStructExportRequest.Roi roi : req.rois()) {
            for (RtStructExportRequest.Contour c : roi.contours()) {
                if (c.sopInstanceUid() != null && !c.sopInstanceUid().isBlank()) refSops.add(c.sopInstanceUid());
            }
        }

        // ReferencedFrameOfReferenceSequence → RTReferencedStudy → RTReferencedSeries → ContourImageSequence。
        Sequence rfor = a.newSequence(Tag.ReferencedFrameOfReferenceSequence, 1);
        Attributes rforItem = new Attributes();
        rforItem.setString(Tag.FrameOfReferenceUID, VR.UI, forUid);
        Attributes rtRefStudyItem = new Attributes();
        rtRefStudyItem.setString(Tag.ReferencedSOPClassUID, VR.UI, STUDY_COMPONENT_MGMT);
        rtRefStudyItem.setString(Tag.ReferencedSOPInstanceUID, VR.UI, req.studyInstanceUid());
        Attributes rtRefSeriesItem = new Attributes();
        rtRefSeriesItem.setString(Tag.SeriesInstanceUID, VR.UI, req.seriesInstanceUid());
        Sequence ciSeq = rtRefSeriesItem.newSequence(Tag.ContourImageSequence, refSops.size());
        for (String sop : refSops) {
            ciSeq.add(imageRef(srcClassUid, sop));
        }
        rtRefStudyItem.newSequence(Tag.RTReferencedSeriesSequence, 1).add(rtRefSeriesItem);
        rforItem.newSequence(Tag.RTReferencedStudySequence, 1).add(rtRefStudyItem);
        rfor.add(rforItem);

        // StructureSetROISequence。
        Sequence ssRoi = a.newSequence(Tag.StructureSetROISequence, req.rois().size());
        for (RtStructExportRequest.Roi roi : req.rois()) {
            Attributes item = new Attributes();
            item.setInt(Tag.ROINumber, VR.IS, roi.number());
            item.setString(Tag.ReferencedFrameOfReferenceUID, VR.UI, forUid);
            item.setString(Tag.ROIName, VR.LO, roi.name() != null ? roi.name() : "ROI " + roi.number());
            item.setString(Tag.ROIGenerationAlgorithm, VR.CS, "MANUAL");
            ssRoi.add(item);
        }

        // ROIContourSequence。
        Sequence roiContour = a.newSequence(Tag.ROIContourSequence, req.rois().size());
        for (RtStructExportRequest.Roi roi : req.rois()) {
            Attributes item = new Attributes();
            if (roi.color() != null && roi.color().length >= 3) {
                item.setInt(Tag.ROIDisplayColor, VR.IS, roi.color()[0], roi.color()[1], roi.color()[2]);
            }
            item.setInt(Tag.ReferencedROINumber, VR.IS, roi.number());
            Sequence cont = item.newSequence(Tag.ContourSequence, roi.contours().size());
            for (RtStructExportRequest.Contour c : roi.contours()) {
                Attributes ci = new Attributes();
                if (c.sopInstanceUid() != null && !c.sopInstanceUid().isBlank()) {
                    ci.newSequence(Tag.ContourImageSequence, 1).add(imageRef(srcClassUid, c.sopInstanceUid()));
                }
                ci.setString(Tag.ContourGeometricType, VR.CS, "CLOSED_PLANAR");
                ci.setInt(Tag.NumberOfContourPoints, VR.IS, c.points().length / 3);
                ci.setDouble(Tag.ContourData, VR.DS, c.points());
                cont.add(ci);
            }
            roiContour.add(item);
        }

        // RTROIObservationsSequence。
        Sequence obs = a.newSequence(Tag.RTROIObservationsSequence, req.rois().size());
        int obsNum = 0;
        for (RtStructExportRequest.Roi roi : req.rois()) {
            obsNum++;
            Attributes item = new Attributes();
            item.setInt(Tag.ObservationNumber, VR.IS, obsNum);
            item.setInt(Tag.ReferencedROINumber, VR.IS, roi.number());
            item.setString(Tag.RTROIInterpretedType, VR.CS, roi.type() != null ? roi.type() : "");
            item.setString(Tag.ROIInterpreter, VR.PN, "");
            obs.add(item);
        }

        if (web != null) {
            web.storeDatasets(List.of(a)); // STOW-RS で PACS へ保存
        } else {
            ingest(a);
        }
        log.info("RTSTRUCT exported: series={} sop={} rois={} from {}",
                newSeriesUid, newSopUid, req.rois().size(), req.seriesInstanceUid());
        return new Result(newSeriesUid, newSopUid);
    }

    // --- helpers ---

    private void validate(RtStructExportRequest req) {
        if (req.studyInstanceUid() == null || req.studyInstanceUid().isBlank()
                || req.seriesInstanceUid() == null || req.seriesInstanceUid().isBlank()) {
            throw new IllegalArgumentException("studyInstanceUid / seriesInstanceUid は必須です");
        }
        if (req.frameOfReferenceUID() == null || req.frameOfReferenceUID().isBlank()) {
            throw new IllegalArgumentException("frameOfReferenceUID は必須です（RTSTRUCT の幾何参照）");
        }
        if (req.rois() == null || req.rois().isEmpty()) {
            throw new IllegalArgumentException("rois が空です");
        }
        for (RtStructExportRequest.Roi roi : req.rois()) {
            if (roi.contours() == null || roi.contours().isEmpty()) {
                throw new IllegalArgumentException("ROI " + roi.number() + " に輪郭がありません");
            }
            for (RtStructExportRequest.Contour c : roi.contours()) {
                if (c.points() == null || c.points().length < 9 || c.points().length % 3 != 0) {
                    throw new IllegalArgumentException("輪郭点列は 3 の倍数かつ 3 点以上が必要です (roi=" + roi.number() + ")");
                }
            }
        }
    }

    private Attributes imageRef(String sopClassUid, String sopInstanceUid) {
        Attributes item = new Attributes();
        if (sopClassUid != null) item.setString(Tag.ReferencedSOPClassUID, VR.UI, sopClassUid);
        item.setString(Tag.ReferencedSOPInstanceUID, VR.UI, sopInstanceUid);
        return item;
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
        Path tmp = Files.createTempFile("rtss-", ".dcm");
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

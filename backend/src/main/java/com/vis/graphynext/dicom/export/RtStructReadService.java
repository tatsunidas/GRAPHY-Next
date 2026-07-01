/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * DICOM RTSTRUCT 読込。StructureSetROI/ROIContour を解析して ROI 輪郭（患者座標 mm）を DTO 化する
 * （書込 {@link RtStructExportService} と対称。`fw/dicom-seg-rtstruct-design.md` S3）。
 */
@Service
public class RtStructReadService {

    private final DicomStorageService storage;

    public RtStructReadService(DicomStorageService storage) {
        this.storage = storage;
    }

    /** 指定 RTSTRUCT シリーズの ROI 群を読む。RTSTRUCT でなければ空。 */
    public List<RtStructRoiDto> read(String studyUid, String seriesUid) throws IOException {
        List<Path> files = storage.resolveFiles(studyUid, List.of(seriesUid));
        for (Path f : files) {
            Attributes ds;
            try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                ds = in.readDataset();
            }
            if (!"RTSTRUCT".equals(ds.getString(Tag.Modality))) {
                continue;
            }
            return parse(ds);
        }
        return List.of();
    }

    private List<RtStructRoiDto> parse(Attributes ds) {
        // ROINumber → 名前 / 種別。
        Map<Integer, String> names = new HashMap<>();
        Sequence ssRoi = ds.getSequence(Tag.StructureSetROISequence);
        if (ssRoi != null) {
            for (Attributes it : ssRoi) {
                names.put(it.getInt(Tag.ROINumber, -1), it.getString(Tag.ROIName));
            }
        }
        Map<Integer, String> types = new HashMap<>();
        Sequence obs = ds.getSequence(Tag.RTROIObservationsSequence);
        if (obs != null) {
            for (Attributes it : obs) {
                types.put(it.getInt(Tag.ReferencedROINumber, -1), it.getString(Tag.RTROIInterpretedType));
            }
        }

        List<RtStructRoiDto> out = new ArrayList<>();
        Sequence roiContour = ds.getSequence(Tag.ROIContourSequence);
        if (roiContour != null) {
            for (Attributes rc : roiContour) {
                int num = rc.getInt(Tag.ReferencedROINumber, -1);
                int[] color = rc.getInts(Tag.ROIDisplayColor);
                List<RtStructRoiDto.Contour> contours = new ArrayList<>();
                Sequence cs = rc.getSequence(Tag.ContourSequence);
                if (cs != null) {
                    for (Attributes ci : cs) {
                        double[] pts = ci.getDoubles(Tag.ContourData);
                        if (pts == null || pts.length < 9 || pts.length % 3 != 0) {
                            continue;
                        }
                        String refSop = null;
                        Sequence ciImg = ci.getSequence(Tag.ContourImageSequence);
                        if (ciImg != null && !ciImg.isEmpty()) {
                            refSop = ciImg.get(0).getString(Tag.ReferencedSOPInstanceUID);
                        }
                        contours.add(new RtStructRoiDto.Contour(refSop, pts));
                    }
                }
                if (!contours.isEmpty()) {
                    out.add(new RtStructRoiDto(names.getOrDefault(num, "ROI " + num), color, types.get(num), contours));
                }
            }
        }
        return out;
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.anonymize.AnonymizeMaskStore;
import com.vis.graphynext.anonymize.AnonymizeService;
import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.springframework.beans.factory.ObjectProvider;

import java.io.IOException;
import java.lang.reflect.Proxy;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * データセットのテストの土台（compute のテストで共有）。索引は {@link Proxy} で最小限だけ真似る
 * （⚠ Mockito はこの開発機の JDK 25 で動かないので使わない）。本物の {@link AnonymizeService} を通す。
 */
final class DatasetFixture {

    static final String STUDY = "1.2.3.100";
    static final String CT_SERIES = "1.2.3.100.1";
    static final String PHI_NAME = "YAMADA^TARO";
    static final String PHI_ID = "PID-12345";
    static final double SLOPE = 1.0;
    static final double INTERCEPT = -1024.0;

    final Path dir;
    final Map<String, List<DicomInstance>> bySeries = new HashMap<>();
    final AnonymizeMaskStore masks = new AnonymizeMaskStore();
    final ObjectMapper mapper = new ObjectMapper();

    DatasetFixture(Path dir) {
        this.dir = dir;
    }

    ComputeDatasetService service() {
        DicomInstanceRepository repo = (DicomInstanceRepository) Proxy.newProxyInstance(
                getClass().getClassLoader(), new Class<?>[]{DicomInstanceRepository.class}, (p, m, a) -> {
                    if (m.getName().equals("findBySeries")) {
                        return bySeries.getOrDefault((String) a[1], List.of());
                    }
                    if (m.getName().equals("findByStudyInstanceUid")) {
                        List<DicomInstance> all = new ArrayList<>();
                        bySeries.values().forEach(all::addAll);
                        return all;
                    }
                    throw new UnsupportedOperationException(m.getName());
                });
        @SuppressWarnings("unchecked")
        ObjectProvider<com.vis.graphynext.dicom.web.WebDicomDataService> web =
                (ObjectProvider<com.vis.graphynext.dicom.web.WebDicomDataService>) Proxy.newProxyInstance(
                        getClass().getClassLoader(), new Class<?>[]{ObjectProvider.class}, (p, m, a) -> null);
        PixelCodec codec = new PixelCodec(new DicomProperties());
        return new ComputeDatasetService(new AnonymizeService(repo, masks, web, codec), codec, mapper);
    }

    void index(String series, String sop, Path file, String modality, String sopClass) {
        DicomInstance inst = new DicomInstance(sop);
        inst.setUri(file.toUri().toString());
        inst.setStudyInstanceUid(STUDY);
        inst.setSeriesInstanceUid(series);
        inst.setPatientId(PHI_ID);
        inst.setModality(modality);
        inst.setSopClassUid(sopClass);
        bySeries.computeIfAbsent(series, k -> new ArrayList<>()).add(inst);
    }

    /**
     * 4×3 の CT を 3 枚。<b>索引の順（InstanceNumber）と位置の順をわざとずらす</b>（並べ替えを確かめるため）。
     * 画素値 = 100*z + 10*y + x（格納値）。HU = 格納値 − 1024。
     */
    void writeCtSeries() throws IOException {
        int[] zOrderByInstance = {2, 0, 1};
        for (int i = 0; i < 3; i++) {
            int z = zOrderByInstance[i];
            String sop = CT_SERIES + "." + (i + 1);
            Attributes ds = new Attributes();
            ds.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
            ds.setString(Tag.SOPInstanceUID, VR.UI, sop);
            ds.setString(Tag.StudyInstanceUID, VR.UI, STUDY);
            ds.setString(Tag.SeriesInstanceUID, VR.UI, CT_SERIES);
            ds.setString(Tag.PatientName, VR.PN, PHI_NAME);
            ds.setString(Tag.PatientID, VR.LO, PHI_ID);
            ds.setString(Tag.PatientBirthDate, VR.DA, "19600101");
            ds.setString(Tag.StudyDate, VR.DA, "20260101");
            ds.setString(Tag.InstitutionName, VR.LO, "VIS GENERAL HOSPITAL");
            ds.setString(Tag.Modality, VR.CS, "CT");
            ds.setInt(Tag.InstanceNumber, VR.IS, i + 1);
            ds.setDouble(Tag.ImagePositionPatient, VR.DS, -10.0, -20.0, 5.0 + 2.5 * z);
            ds.setDouble(Tag.ImageOrientationPatient, VR.DS, 1, 0, 0, 0, 1, 0);
            ds.setDouble(Tag.PixelSpacing, VR.DS, 0.8, 0.5);
            ds.setDouble(Tag.RescaleSlope, VR.DS, SLOPE);
            ds.setDouble(Tag.RescaleIntercept, VR.DS, INTERCEPT);
            ds.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
            ds.setInt(Tag.SamplesPerPixel, VR.US, 1);
            ds.setInt(Tag.Rows, VR.US, 3);
            ds.setInt(Tag.Columns, VR.US, 4);
            ds.setInt(Tag.BitsAllocated, VR.US, 16);
            ds.setInt(Tag.BitsStored, VR.US, 12);
            ds.setInt(Tag.HighBit, VR.US, 11);
            ds.setInt(Tag.PixelRepresentation, VR.US, 0);
            ByteBuffer px = ByteBuffer.allocate(3 * 4 * 2).order(ByteOrder.LITTLE_ENDIAN);
            for (int y = 0; y < 3; y++) {
                for (int x = 0; x < 4; x++) {
                    px.putShort((short) (100 * z + 10 * y + x));
                }
            }
            ds.setBytes(Tag.PixelData, VR.OW, px.array());
            Path f = dir.resolve("ct" + i + ".dcm");
            try (DicomOutputStream out = new DicomOutputStream(f.toFile())) {
                out.writeDataset(ds.createFileMetaInformation(UID.ExplicitVRLittleEndian), ds);
            }
            index(CT_SERIES, sop, f, "CT", UID.CTImageStorage);
        }
    }

}

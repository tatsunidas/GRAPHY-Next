/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.media.DicomDirReader;
import org.dcm4che3.media.DicomDirWriter;
import org.dcm4che3.media.RecordFactory;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * dcm4che の DICOMDIR 生成（{@link ExportService#addDirRecords}）が読み戻せる構造を作ることを検証。
 * 実 DICOM ファイル不要（Attributes を直接組む）。2 スタディ・各 1 シリーズ・各 2 画像を投入し、
 * Patient/Study/Series/Image レコードが想定数できることを確認する。
 */
class ExportDicomDirTest {

    private static Attributes dataset(String pid, String studyUid, String seriesUid, String sopUid) {
        Attributes ds = new Attributes();
        ds.setString(Tag.PatientID, VR.LO, pid);
        ds.setString(Tag.PatientName, VR.PN, "Test^" + pid);
        ds.setString(Tag.StudyInstanceUID, VR.UI, studyUid);
        ds.setString(Tag.StudyDate, VR.DA, "20260630");
        ds.setString(Tag.StudyID, VR.SH, "1");
        ds.setString(Tag.SeriesInstanceUID, VR.UI, seriesUid);
        ds.setString(Tag.Modality, VR.CS, "OT");
        ds.setInt(Tag.SeriesNumber, VR.IS, 1);
        ds.setString(Tag.SOPInstanceUID, VR.UI, sopUid);
        ds.setString(Tag.SOPClassUID, VR.UI, UID.SecondaryCaptureImageStorage);
        ds.setInt(Tag.InstanceNumber, VR.IS, 1);
        return ds;
    }

    private static Attributes fmi(Attributes ds) {
        return ds.createFileMetaInformation(UID.ExplicitVRLittleEndian);
    }

    @Test
    void buildsReadableDicomDir() throws Exception {
        Path dir = Files.createTempDirectory("dicomdir-test-");
        File dicomdir = dir.resolve("DICOMDIR").toFile();
        DicomDirWriter.createEmptyDirectory(dicomdir, "GRAPHY_EXP", null, null, null);
        DicomDirWriter writer = DicomDirWriter.open(dicomdir);
        RecordFactory rf = new RecordFactory();
        rf.loadDefaultConfiguration();

        // 同一患者・2 スタディ・各 1 シリーズ・各 2 画像
        String pid = "PID-1";
        for (int st = 1; st <= 2; st++) {
            String studyUid = "1.2.3." + st;
            String seriesUid = "1.2.3." + st + ".1";
            for (int im = 1; im <= 2; im++) {
                String sopUid = seriesUid + "." + im;
                Attributes ds = dataset(pid, studyUid, seriesUid, sopUid);
                String[] fileIDs = {"DICOM", "PAT00001", MediaNaming.dirName("STU", st),
                        MediaNaming.dirName("SER", st), MediaNaming.imageName(im)};
                ExportService.addDirRecords(writer, rf, ds, fmi(ds), fileIDs);
            }
        }
        writer.commit();
        writer.close();

        // 読み戻し: Patient 1, Study 2, Series 2, Image 4
        try (DicomDirReader reader = new DicomDirReader(dicomdir)) {
            int patients = 0, studies = 0, series = 0, images = 0;
            Attributes pat = reader.findFirstRootDirectoryRecordInUse(false);
            while (pat != null) {
                patients++;
                Attributes sty = reader.readLowerDirectoryRecord(pat);
                while (sty != null) {
                    studies++;
                    Attributes ser = reader.readLowerDirectoryRecord(sty);
                    while (ser != null) {
                        series++;
                        Attributes img = reader.readLowerDirectoryRecord(ser);
                        while (img != null) {
                            images++;
                            assertNotNull(img.getStrings(Tag.ReferencedFileID));
                            img = reader.readNextDirectoryRecord(img);
                        }
                        ser = reader.readNextDirectoryRecord(ser);
                    }
                    sty = reader.readNextDirectoryRecord(sty);
                }
                pat = reader.readNextDirectoryRecord(pat);
            }
            assertEquals(1, patients, "patients");
            assertEquals(2, studies, "studies");
            assertEquals(2, series, "series");
            assertEquals(4, images, "images");
        } finally {
            try (var s = Files.walk(dir)) {
                s.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
            }
        }
    }
}

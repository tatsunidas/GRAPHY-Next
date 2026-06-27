package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;

import java.io.IOException;
import java.nio.file.Path;

/**
 * テスト用のデジタル DICOM ファントム生成（実ファイル非依存）。
 *
 * <p>要件定義の方針どおり、テストはその場でファントムを生成して使う。
 * 最小だが有効な Secondary Capture 画像（4x4, 8bit MONOCHROME2）を作る。
 */
public final class DicomPhantomFactory {

    private DicomPhantomFactory() {
    }

    /** 与えた UID 群を持つ最小の SC 画像データセットを生成する。 */
    public static Attributes scImage(String patientId, String studyUid, String seriesUid, String sopUid) {
        Attributes a = new Attributes();
        a.setString(Tag.PatientID, VR.LO, patientId);
        a.setString(Tag.PatientName, VR.PN, "PHANTOM^TEST");
        a.setString(Tag.StudyInstanceUID, VR.UI, studyUid);
        a.setString(Tag.SeriesInstanceUID, VR.UI, seriesUid);
        a.setString(Tag.SOPInstanceUID, VR.UI, sopUid);
        a.setString(Tag.SOPClassUID, VR.UI, UID.SecondaryCaptureImageStorage);
        a.setString(Tag.Modality, VR.CS, "OT");
        a.setString(Tag.StudyDate, VR.DA, "20260101");
        a.setString(Tag.SeriesNumber, VR.IS, "1");
        a.setString(Tag.InstanceNumber, VR.IS, "1");

        int rows = 4;
        int cols = 4;
        a.setInt(Tag.Rows, VR.US, rows);
        a.setInt(Tag.Columns, VR.US, cols);
        a.setInt(Tag.BitsAllocated, VR.US, 8);
        a.setInt(Tag.BitsStored, VR.US, 8);
        a.setInt(Tag.HighBit, VR.US, 7);
        a.setInt(Tag.SamplesPerPixel, VR.US, 1);
        a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        a.setInt(Tag.PixelRepresentation, VR.US, 0);
        a.setBytes(Tag.PixelData, VR.OB, new byte[rows * cols]);
        return a;
    }

    /** データセットを DICOM Part-10 ファイル（FMI 付き）として書き出す。 */
    public static Path writeFile(Path file, Attributes dataset, String tsuid) throws IOException {
        Attributes fmi = dataset.createFileMetaInformation(tsuid);
        try (DicomOutputStream out = new DicomOutputStream(file.toFile())) {
            out.writeDataset(fmi, dataset);
        }
        return file;
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.dicom.store.DicomStorageService;
import ij.ImagePlus;
import ij.ImageStack;
import ij.measure.Calibration;
import ij.measure.ResultsTable;
import ij.process.ByteProcessor;
import ij.process.FloatProcessor;
import io.github.tatsunidas.radiomics.main.RadiomicsJ;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * ROI 特徴量表を保管庫のシリーズから通しで計算し、同じ画素・校正を試験の中で組み立てて
 * RadiomicsJ を直接呼んだ値と全特徴で一致することを確かめる（読み込み・マスクの整列・校正の配管）。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.profiles.active=standalone",
                "spring.datasource.url=jdbc:h2:mem:roifeat;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class RoiFeatureIntegrationTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DicomStorageService storage;

    @Autowired
    RoiFeatureService service;

    private static final int COLS = 20, ROWS = 18, SLICES = 8;
    private static final double PIXEL_SPACING = 0.75, SLICE_SPACING = 1.25;

    private static final String STUDY_UID = UIDUtils.createUID();
    private static final String SOURCE_SERIES_UID = UIDUtils.createUID();
    private static final String MASK_SERIES_UID = UIDUtils.createUID();
    private static final String FOR_UID = UIDUtils.createUID();

    @BeforeAll
    static void headless() {
        System.setProperty("java.awt.headless", "true");
    }

    private static int value(int x, int y, int z) {
        return ((x * 7 + y * 13 + z * 29) % 37) * 11 + (x / 5) * 50;
    }

    private static boolean inside(int x, int y, int z) {
        return z >= 2 && z < SLICES - 1 && x >= 4 && x < 15 && y >= 3 && y < 14;
    }

    private Attributes slice(int z, String series, boolean mask) {
        Attributes a = new Attributes();
        a.setString(Tag.PatientID, VR.LO, "ROIFEAT^TEST");
        a.setString(Tag.PatientName, VR.PN, "PHANTOM^ROIFEAT");
        a.setString(Tag.StudyInstanceUID, VR.UI, STUDY_UID);
        a.setString(Tag.SeriesInstanceUID, VR.UI, series);
        a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        a.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        a.setString(Tag.Modality, VR.CS, "CT");
        a.setString(Tag.SeriesNumber, VR.IS, mask ? "2" : "1");
        a.setString(Tag.InstanceNumber, VR.IS, String.valueOf(z + 1));
        a.setString(Tag.FrameOfReferenceUID, VR.UI, FOR_UID);
        a.setDouble(Tag.ImageOrientationPatient, VR.DS, 1, 0, 0, 0, 1, 0);
        a.setDouble(Tag.ImagePositionPatient, VR.DS, 0, 0, z * SLICE_SPACING);
        a.setDouble(Tag.PixelSpacing, VR.DS, PIXEL_SPACING, PIXEL_SPACING);
        a.setDouble(Tag.SliceThickness, VR.DS, SLICE_SPACING);
        a.setInt(Tag.Rows, VR.US, ROWS);
        a.setInt(Tag.Columns, VR.US, COLS);
        a.setInt(Tag.BitsAllocated, VR.US, 16);
        a.setInt(Tag.BitsStored, VR.US, 16);
        a.setInt(Tag.HighBit, VR.US, 15);
        a.setInt(Tag.SamplesPerPixel, VR.US, 1);
        a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        a.setInt(Tag.PixelRepresentation, VR.US, 0);
        a.setDouble(Tag.RescaleSlope, VR.DS, 1.0);
        a.setDouble(Tag.RescaleIntercept, VR.DS, mask ? 0.0 : -100.0);
        byte[] px = new byte[ROWS * COLS * 2];
        for (int y = 0; y < ROWS; y++) for (int x = 0; x < COLS; x++) {
            int v = mask ? (inside(x, y, z) ? 1 : 0) : value(x, y, z);
            int i = (y * COLS + x) * 2;
            px[i] = (byte) (v & 0xFF);
            px[i + 1] = (byte) ((v >> 8) & 0xFF);
        }
        a.setBytes(Tag.PixelData, VR.OW, px);
        return a;
    }

    private static boolean ingested;

    private synchronized void ingestPhantom() throws IOException {
        if (ingested) return;
        for (int z = 0; z < SLICES; z++) {
            for (boolean mask : new boolean[]{false, true}) {
                Path file = Files.createTempFile(tmp, "p", ".dcm");
                Attributes ds = slice(z, mask ? MASK_SERIES_UID : SOURCE_SERIES_UID, mask);
                try (DicomOutputStream out = new DicomOutputStream(file.toFile())) {
                    out.writeDataset(ds.createFileMetaInformation(UID.ExplicitVRLittleEndian), ds);
                }
                storage.ingest(file);
            }
        }
        ingested = true;
    }

    /** 試験の中で組み立てた、同じ画素（Rescale 後）・校正の画像とマスク。 */
    private static ImagePlus[] expected() {
        ImageStack img = new ImageStack(COLS, ROWS);
        ImageStack msk = new ImageStack(COLS, ROWS);
        for (int z = 0; z < SLICES; z++) {
            FloatProcessor ip = new FloatProcessor(COLS, ROWS);
            ByteProcessor mp = new ByteProcessor(COLS, ROWS);
            for (int y = 0; y < ROWS; y++) for (int x = 0; x < COLS; x++) {
                ip.setf(x, y, value(x, y, z) - 100f);
                mp.set(x, y, inside(x, y, z) ? 1 : 0);
            }
            img.addSlice(ip);
            msk.addSlice(mp);
        }
        ImagePlus i = new ImagePlus("e", img);
        ImagePlus m = new ImagePlus("m", msk);
        Calibration c = i.getCalibration();
        c.pixelWidth = PIXEL_SPACING; c.pixelHeight = PIXEL_SPACING; c.pixelDepth = SLICE_SPACING;
        m.setCalibration(c.copy());
        return new ImagePlus[]{i, m};
    }

    private static ResultsTable direct(Map<String, String> settings) throws Exception {
        ImagePlus[] e = expected();
        return RadiomicsLock.call(() -> {
            try {
                RadiomicsJ rj = new RadiomicsJ();
                Properties p = new Properties();
                p.putAll(settings);
                rj.loadSettings(p);
                return rj.extractAll(e[0], e[1], 1);
            } finally {
                RadiomicsJ.resetSettings();
                RadiomicsJ.discretiseImp = null;
            }
        });
    }

    private static RoiFeatureRequest req(Map<String, String> settings, boolean recompute) {
        return new RoiFeatureRequest(STUDY_UID, SOURCE_SERIES_UID, MASK_SERIES_UID, 0, 0, 0, settings, recompute);
    }

    @Test
    void storedSeriesGiveTheSameValuesAsADirectCall() throws Exception {
        ingestPhantom();
        Map<String, String> s = new HashMap<>(Map.of("INT_binCount", "32"));
        RoiFeatureResult r = service.compute(req(s, true), p -> { });

        Map<String, String> ds = new HashMap<>(s);
        ds.put("BOOL_enableOperationalInfo", "0");
        ResultsTable d = direct(ds);
        List<String> heads = Stream.of(d.getHeadings()).filter(d::columnExists).collect(Collectors.toList());
        assertEquals(heads, r.rows().stream().map(RoiFeatureResult.Row::column).collect(Collectors.toList()));
        int compared = 0;
        for (RoiFeatureResult.Row row : r.rows()) {
            double v = d.getValue(row.column(), d.size() - 1);
            if (Double.isNaN(v)) {
                assertNull(row.value(), row.column());
            } else {
                assertEquals(Double.doubleToLongBits(v), Double.doubleToLongBits(row.value()), row.column());
                compared++;
            }
        }
        assertTrue(compared >= 150, "比べた特徴の数: " + compared);
        assertEquals(11L * 11 * 5,
                Math.round(r.rows().stream().filter(x -> x.column().equals(
                        "Diagnostics_DiagnosticsInitialROIIntMaskVoxelCount")).findFirst().orElseThrow().value()),
                "マスクが IPP で揃っている");

        // 負例: ビン数を変えた直接の呼び出しとは一致しない
        Map<String, String> d16 = new HashMap<>(ds);
        d16.put("INT_binCount", "16");
        ResultsTable other = direct(d16);
        double a = other.getValue("GLCM_JointEntropy", other.size() - 1);
        double b = r.rows().stream().filter(x -> x.column().equals("GLCM_JointEntropy")).findFirst().orElseThrow().value();
        assertNotEquals(a, b);

        // 患者名は DICOM にあるが、結果には出ない
        assertTrue(r.rows().stream().noneMatch(x -> x.column().startsWith("OperationalInfo_")));

        // 同じ要求の 2 回目はキャッシュから（実際の RadiomicsJ の版が取れていること）
        assertNotNull(MapCheckpointStore.detectRadiomicsjVersion());
        RoiFeatureResult again = service.compute(req(s, false), p -> { });
        assertTrue(again.fromCache());
        assertEquals(r.computedAt(), again.computedAt());
    }
}

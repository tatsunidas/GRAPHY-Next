/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.nifti.FloatNiftiFixture;

/**
 * NIfTI の float を Parametric Map で取り込んだシリーズ（fw/nifti-import.md §3.1・F4）にテクスチャを掛ける。
 * 前は画素を PixelData からしか読まず「スライスをデコードできません」で止まっていた。
 * NaN（値なし）を含むシリーズは、窓の中の NaN を RadiomicsJ がどう扱うか確かめていないので断る。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.profiles.active=standalone",
                "spring.datasource.url=jdbc:h2:mem:pmtex;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class ParametricMapTextureIntegrationTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @BeforeAll
    static void headless() {
        System.setProperty("java.awt.headless", "true");
    }

    @Autowired
    DicomStorageService storage;

    @Autowired
    TextureSeriesService textureService;

    private static final int N = 12;
    private static final int NZ = 4;
    private static final String STUDY = UIDUtils.createUID();

    /** 格子模様の小さい float（ADC のよう）。 */
    private static float value(int i, int j, int k) {
        return (float) (0.0007 + 0.0004 * (((i / 3) + (j / 3)) % 2) + 0.00001 * (i + j + k));
    }

    private String ingest(String series, FloatNiftiFixture.Value v) throws IOException {
        Path nii = FloatNiftiFixture.write(Files.createTempFile(tmp, "adc", ".nii"), N, N, NZ, 1.0, 1.0, 1.0, v);
        for (Attributes ds : FloatNiftiFixture.toParametricMap(nii, "PM^TEX", "PM^TEX", STUDY, series, "mm2/s")) {
            Path f = Files.createTempFile(tmp, "pm", ".dcm");
            try (DicomOutputStream out = new DicomOutputStream(f.toFile())) {
                out.writeDataset(ds.createFileMetaInformation(UID.ExplicitVRLittleEndian), ds);
            }
            storage.ingest(f);
        }
        return series;
    }

    private static TextureSeriesRequest request(String series) {
        return new TextureSeriesRequest(STUDY, series, null, 0, "GLCM_JointEntropy", 3, 1, false, 0, 0,
                Map.of("MASK_LABEL_INT", "1"), null, null, null);
    }

    @Test
    void floatParametricMapBuildsATextureMap() throws Exception {
        String series = ingest(UIDUtils.createUID(), ParametricMapTextureIntegrationTest::value);
        TextureSeriesService.Result r = textureService.create(request(series));
        assertEquals(NZ, r.sopInstanceUids().size());
        boolean nonZero = false;
        for (Path f : storage.resolveFiles(STUDY, List.of(r.seriesInstanceUid()))) {
            try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
                byte[] px = in.readDataset().getBytes(Tag.PixelData);
                for (byte b : px) {
                    nonZero |= b != 0;
                }
            }
        }
        assertTrue(nonZero, "格子模様なので結合エントロピーは 0 ではない");
    }

    @Test
    void refusesASeriesWithNaN() throws Exception {
        String series = ingest(UIDUtils.createUID(),
                (i, j, k) -> i == 2 && j == 2 && k == 1 ? Float.NaN : value(i, j, k));
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> textureService.create(request(series)));
        assertTrue(e.getMessage().contains("NaN"), e.getMessage());
    }

    // ---- 整数の Parametric Map（マップ・フィルタ済みシリーズの新しい形式）を入力にする ----

    /** マップの形式で NZ 枚（N×N）を作って保管庫に入れる。値は {@code v(i,j,k)}。 */
    private String ingestIntegerMap(String series, String modality, FloatNiftiFixture.Value v) throws IOException {
        float[][] data = new float[NZ][N * N];
        List<double[]> ipps = new java.util.ArrayList<>();
        List<String> src = new java.util.ArrayList<>();
        for (int k = 0; k < NZ; k++) {
            for (int j = 0; j < N; j++) for (int i = 0; i < N; i++) data[k][j * N + i] = v.at(i, j, k);
            ipps.add(new double[] { 0, 0, k });
            src.add("1.2.3.4." + k);
        }
        double[] q = TextureSeriesService.quantization(TextureSeriesService.minMax(data));
        RadiomicsMapEngine.MapResult map = new RadiomicsMapEngine.MapResult(N, N, NZ, data, "FIRSTORDER_Mean",
                new double[] { 1, 0, 0, 0, 1, 0 }, 1.0, 1.0, ipps, src, "1.2.3.9", false);
        Attributes t = new Attributes();
        t.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        t.setString(Tag.SeriesInstanceUID, VR.UI, "1.2.3.4");
        t.setString(Tag.Modality, VR.CS, modality);
        t.setString(Tag.PatientID, VR.LO, "PM^INT");
        t.setString(Tag.PatientName, VR.PN, "PM^INT");
        t.setString(Tag.StudyInstanceUID, VR.UI, STUDY);
        for (int k = 0; k < NZ; k++) {
            Attributes a = TextureSeriesService.buildInstance(t, STUDY, map, series, 2001, "int map", "TEXTURE",
                    "FIRSTORDER_Mean", "test", q[2], q[3], q[0], q[1] - q[0], 1.0, 1.0, k,
                    TextureSeriesService.to16bit(data[k], q[2], q[3]), MapParametricMapFormatTest.EQ);
            Path f = Files.createTempFile(tmp, "ipm", ".dcm");
            try (DicomOutputStream out = new DicomOutputStream(f.toFile())) {
                out.writeDataset(a.createFileMetaInformation(UID.ExplicitVRLittleEndian), a);
            }
            storage.ingest(f);
        }
        return series;
    }

    private static float wide(int i, int j, int k) {
        return 100f + i * 37.5f + j * 11.25f + k * 400f; // 量子化後に 32768 以上の画素を含む
    }

    @Autowired
    RadiomicsMapEngine engine;

    @Test
    void integerMapIsReadAsRealValuesByRadiomics() throws Exception {
        String series = ingestIntegerMap(UIDUtils.createUID(), "CT", ParametricMapTextureIntegrationTest::wide);
        RadiomicsMapEngine.LoadedVolume vol = engine.load(STUDY, series, 0, 0, null, 0, 1, new java.util.HashMap<>());
        double worst = 0;
        int high = 0;
        for (int k = 0; k < NZ; k++) {
            float[] got = (float[]) vol.image().getStack().getProcessor(k + 1).convertToFloat().getPixels();
            for (int j = 0; j < N; j++) for (int i = 0; i < N; i++) {
                worst = Math.max(worst, Math.abs(got[j * N + i] - wide(i, j, k)));
                if (wide(i, j, k) > 100f + (1520f - 100f) / 2) high++;
            }
        }
        // 量子化の刻み（(最大−最小)/65534）の半分以内。旧形式（BitsStored=15）は 32768 以上が化けた
        double step = (wide(N - 1, N - 1, NZ - 1) - wide(0, 0, 0)) / 65534.0;
        assertTrue(worst <= step / 2 + 1e-4, "worst=" + worst + " step=" + step);
        assertTrue(high > 0);
    }

    @Test
    void integerMapWithNoValuePixelsIsRefusedWithTheReason() throws Exception {
        String series = ingestIntegerMap(UIDUtils.createUID(), "CT",
                (i, j, k) -> i == 2 && j == 2 && k == 1 ? Float.NaN : wide(i, j, k));
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> textureService.create(request(series)));
        assertTrue(e.getMessage().contains("NaN"), e.getMessage());
    }

    @Test
    void aMapMadeFromPetIsNotCalibratedAsSuv() throws Exception {
        String series = ingestIntegerMap(UIDUtils.createUID(), "PT", ParametricMapTextureIntegrationTest::wide);
        Map<String, String> auto = new java.util.HashMap<>();
        auto.put(RadiomicsMapEngine.CALIBRATION_SETTING, "auto");
        RadiomicsMapEngine.LoadedVolume vol = engine.load(STUDY, series, 0, 0, null, 0, 1, auto);
        float[] got = (float[]) vol.image().getStack().getProcessor(1).convertToFloat().getPixels();
        assertEquals(wide(3, 2, 0), got[2 * N + 3], 0.05, "値はそのまま（SUV の係数を掛けない）");
        assertFalse(vol.valueCalibration().scales());
        // 負例: 体重・投与量が無い PET を SUV に校正しようとして失敗する経路は、PM では取らない（理由を添えて断る）
        Map<String, String> bw = new java.util.HashMap<>();
        bw.put(RadiomicsMapEngine.CALIBRATION_SETTING, "bw");
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> engine.load(STUDY, series, 0, 0, null, 0, 1, bw));
        assertTrue(e.getMessage().contains("Parametric Map"), e.getMessage());
    }

    // ---- 旧版が書いた誤宣言のシリーズ ----

    private String ingestScMap(String series, String[] imageType, int bitsStored, int highBit) throws IOException {
        return ingestScMap(series, imageType, bitsStored, highBit, "OT");
    }

    private String ingestScMap(String series, String[] imageType, int bitsStored, int highBit, String modality) throws IOException {
        for (int k = 0; k < NZ; k++) {
            Attributes a = new Attributes();
            a.setString(Tag.PatientID, VR.LO, "SC^MAP");
            a.setString(Tag.PatientName, VR.PN, "SC^MAP");
            a.setString(Tag.StudyInstanceUID, VR.UI, STUDY);
            a.setString(Tag.SeriesInstanceUID, VR.UI, series);
            a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
            a.setString(Tag.SOPClassUID, VR.UI, UID.SecondaryCaptureImageStorage);
            a.setString(Tag.Modality, VR.CS, modality);
            a.setString(Tag.ImageType, VR.CS, imageType);
            a.setString(Tag.InstanceNumber, VR.IS, String.valueOf(k + 1));
            a.setString(Tag.FrameOfReferenceUID, VR.UI, "1.2.3.9");
            a.setDouble(Tag.ImageOrientationPatient, VR.DS, 1, 0, 0, 0, 1, 0);
            a.setDouble(Tag.ImagePositionPatient, VR.DS, 0, 0, k);
            a.setDouble(Tag.PixelSpacing, VR.DS, 1.0, 1.0);
            a.setInt(Tag.Rows, VR.US, N);
            a.setInt(Tag.Columns, VR.US, N);
            a.setInt(Tag.BitsAllocated, VR.US, 16);
            a.setInt(Tag.BitsStored, VR.US, bitsStored);
            a.setInt(Tag.HighBit, VR.US, highBit);
            a.setInt(Tag.SamplesPerPixel, VR.US, 1);
            a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
            a.setInt(Tag.PixelRepresentation, VR.US, 0);
            byte[] px = new byte[N * N * 2];
            for (int i = 0; i < N * N; i++) {
                int v = 1000 + i * 17 + k * 300;
                px[2 * i] = (byte) v;
                px[2 * i + 1] = (byte) (v >> 8);
            }
            a.setBytes(Tag.PixelData, VR.OW, px);
            Path f = Files.createTempFile(tmp, "sc", ".dcm");
            try (DicomOutputStream out = new DicomOutputStream(f.toFile())) {
                out.writeDataset(a.createFileMetaInformation(UID.ExplicitVRLittleEndian), a);
            }
            storage.ingest(f);
        }
        return series;
    }

    @Test
    void aMisdeclaredLegacyMapIsRefusedAndACorrectlyDeclaredSecondaryCaptureStillPasses() throws Exception {
        String bad = ingestScMap(UIDUtils.createUID(), new String[] {"DERIVED", "SECONDARY", "TEXTURE"}, 15, 15);
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> engine.load(STUDY, bad, 0, 0, null, 0, 1, new java.util.HashMap<>()));
        assertTrue(e.getMessage().contains("旧版で作られた"), e.getMessage());
        String badLog = ingestScMap(UIDUtils.createUID(), new String[] {"DERIVED", "SECONDARY", "LOG"}, 15, 15);
        assertThrows(IllegalArgumentException.class,
                () -> engine.load(STUDY, badLog, 0, 0, null, 0, 1, new java.util.HashMap<>()));
        // 正例: 同じ画素でも宣言が正しければ（16/15）通る。TEXTURE でない 15/15 の SC（普通の 15 bit 画像）も通る
        String ok = ingestScMap(UIDUtils.createUID(), new String[] {"DERIVED", "SECONDARY", "TEXTURE"}, 16, 15);
        assertNotNull(engine.load(STUDY, ok, 0, 0, null, 0, 1, new java.util.HashMap<>()));
        String plain15 = ingestScMap(UIDUtils.createUID(), new String[] {"DERIVED", "SECONDARY"}, 15, 14);
        assertNotNull(engine.load(STUDY, plain15, 0, 0, null, 0, 1, new java.util.HashMap<>()));
    }

    @Test
    void aMisdeclaredLegacyMapFromPetIsRefusedForTheDeclarationBeforeTheCalibration() throws Exception {
        Map<String, String> auto = new java.util.HashMap<>();
        auto.put(RadiomicsMapEngine.CALIBRATION_SETTING, "auto");
        String bad = ingestScMap(UIDUtils.createUID(), new String[] {"DERIVED", "SECONDARY", "TEXTURE"}, 15, 15, "PT");
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> engine.load(STUDY, bad, 0, 0, null, 0, 1, auto));
        assertTrue(e.getMessage().contains("旧版で作られた"), "校正の理由より先に宣言の誤りを言う: " + e.getMessage());
        // 負例: 宣言が正しい PET（PET の属性が無い）は従来どおり校正の段階で断られる
        String ok = ingestScMap(UIDUtils.createUID(), new String[] {"DERIVED", "SECONDARY"}, 16, 15, "PT");
        IllegalArgumentException c = assertThrows(IllegalArgumentException.class,
                () -> engine.load(STUDY, ok, 0, 0, null, 0, 1, auto));
        assertTrue(c.getMessage().contains("校正できません"), c.getMessage());
    }
}

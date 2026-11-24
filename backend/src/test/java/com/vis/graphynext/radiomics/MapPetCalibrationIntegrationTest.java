/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.dicom.store.DicomStorageService;
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

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * テクスチャのマップと GLAM 解析が、PET を SUV に校正してから計算すること（既定 auto）を、
 * 保管庫の合成 PET で通しで確かめる。FIRSTORDER のマップは値そのものが校正後の単位になり、
 * 固定ビン数の離散化は校正で変わらず、固定ビン幅は変わる。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.profiles.active=standalone",
                "spring.datasource.url=jdbc:h2:mem:mapsuv;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class MapPetCalibrationIntegrationTest {

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

    @Autowired DicomStorageService storage;
    @Autowired RadiomicsMapEngine engine;
    @Autowired TextureSeriesService textureService;
    @Autowired GlamAnalysisService glamService;

    private static final int COLS = 20, ROWS = 18, SLICES = 8;
    private static final String STUDY = UIDUtils.createUID();
    private static final String FOR_UID = UIDUtils.createUID();
    private static final String PET = UIDUtils.createUID();
    private static final String PET_NO_WEIGHT = UIDUtils.createUID();
    private static final String CT = UIDUtils.createUID();
    private static final String MASK = UIDUtils.createUID();

    /**
     * 体重 70 kg・投与量 71.68 MBq・撮像＝投与時刻 → 係数 2^-10（SUVbw = Bq/mL × 2^-10）。
     * 2 の冪にするのは、float の掛け算が丸めなしで済み、固定ビン数の離散化が bit 単位で一致するはずだから
     * （係数が 2 の冪でないと、窓の最小・最大からちょうど 1/8 刻みの値が丸めで隣のビンへ移りうる）。
     */
    private static final double EXPECTED_SCALE = 70_000.0 / 71.68e6;

    private static int value(int x, int y, int z) {
        // 窓の最小・最大からちょうど 1/8 刻みの位置に値が乗ると、浮動小数の丸めで 1 ボクセルのビンが変わる。
        // 刻みに乗らないように、整数でない比になる不規則な項を足す
        return 500 + ((x * 7 + y * 13 + z * 29) % 37) * 283 + (x / 5) * 411 + ((x * x * 5 + y * 3 + z * z * 11) % 23) * 17;
    }

    private static boolean inside(int x, int y, int z) {
        return z >= 2 && z < SLICES - 1 && x >= 4 && x < 15 && y >= 3 && y < 14;
    }

    private Attributes slice(int z, String series, String kind) {
        boolean mask = kind.equals("MASK");
        boolean pet = kind.startsWith("PET");
        Attributes a = new Attributes();
        a.setString(Tag.PatientID, VR.LO, "MAPSUV^TEST");
        a.setString(Tag.PatientName, VR.PN, "PHANTOM^MAPSUV");
        a.setString(Tag.StudyInstanceUID, VR.UI, STUDY);
        a.setString(Tag.SeriesInstanceUID, VR.UI, series);
        a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        a.setString(Tag.SOPClassUID, VR.UI, pet ? UID.PositronEmissionTomographyImageStorage : UID.CTImageStorage);
        a.setString(Tag.Modality, VR.CS, pet ? "PT" : "CT");
        a.setString(Tag.SeriesNumber, VR.IS, "1");
        a.setString(Tag.InstanceNumber, VR.IS, String.valueOf(z + 1));
        a.setString(Tag.FrameOfReferenceUID, VR.UI, FOR_UID);
        a.setDouble(Tag.ImageOrientationPatient, VR.DS, 1, 0, 0, 0, 1, 0);
        a.setDouble(Tag.ImagePositionPatient, VR.DS, 0, 0, z * 1.25);
        a.setDouble(Tag.PixelSpacing, VR.DS, 0.75, 0.75);
        a.setDouble(Tag.SliceThickness, VR.DS, 1.25);
        a.setInt(Tag.Rows, VR.US, ROWS);
        a.setInt(Tag.Columns, VR.US, COLS);
        a.setInt(Tag.BitsAllocated, VR.US, 16);
        a.setInt(Tag.BitsStored, VR.US, 16);
        a.setInt(Tag.HighBit, VR.US, 15);
        a.setInt(Tag.SamplesPerPixel, VR.US, 1);
        a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        a.setInt(Tag.PixelRepresentation, VR.US, 0);
        a.setDouble(Tag.RescaleSlope, VR.DS, 1.0);
        a.setDouble(Tag.RescaleIntercept, VR.DS, 0.0);
        if (pet) {
            a.setString(Tag.Units, VR.CS, "BQML");
            if (!kind.equals("PET_NO_WEIGHT")) a.setString(Tag.PatientWeight, VR.DS, "70");
            a.setString(Tag.PatientSex, VR.CS, "M");
            a.setString(Tag.SeriesDate, VR.DA, "20230115");
            a.setString(Tag.SeriesTime, VR.TM, "130000.000000");
            a.setString(Tag.AcquisitionDate, VR.DA, "20230115");
            a.setString(Tag.AcquisitionTime, VR.TM, "130000.000000");
            a.setString(Tag.DecayCorrection, VR.CS, "START");
            Attributes rad = new Attributes();
            rad.setString(Tag.RadionuclideTotalDose, VR.DS, "71680000");
            rad.setString(Tag.RadionuclideHalfLife, VR.DS, "6586.2");
            rad.setString(Tag.RadiopharmaceuticalStartTime, VR.TM, "130000.000000");
            rad.newSequence(Tag.RadionuclideCodeSequence, 1).add(new Attributes());
            a.newSequence(Tag.RadiopharmaceuticalInformationSequence, 1).add(rad);
        }
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

    private synchronized void ingestAll() throws IOException {
        if (ingested) return;
        String[][] sets = {{PET, "PET"}, {PET_NO_WEIGHT, "PET_NO_WEIGHT"}, {CT, "CT"}, {MASK, "MASK"}};
        for (String[] s : sets) {
            for (int z = 0; z < SLICES; z++) {
                Path file = Files.createTempFile(tmp, "p", ".dcm");
                Attributes ds = slice(z, s[0], s[1]);
                try (DicomOutputStream out = new DicomOutputStream(file.toFile())) {
                    out.writeDataset(ds.createFileMetaInformation(UID.ExplicitVRLittleEndian), ds);
                }
                storage.ingest(file);
            }
        }
        ingested = true;
    }

    private static Map<String, String> settings(String... kv) {
        Map<String, String> m = new HashMap<>();
        m.put("MASK_LABEL_INT", "1");
        for (int i = 0; i < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    private static TextureSeriesRequest mapReq(String series, String feature, Map<String, String> settings,
                                               String calibration) {
        return new TextureSeriesRequest(STUDY, series, MASK, 0, feature, 3, 1, false, 0, 0, settings, 0, null, null,
                calibration);
    }

    /** 検査のたびに途中結果を捨てて計算し直す（同じキーの途中結果を黙って拾わないため）。 */
    private RadiomicsMapEngine.MapResult map(TextureSeriesRequest r) throws IOException {
        RadiomicsMapEngine.Computed c = engine.computeResumable(r, TextureProgress.NONE);
        engine.discardCheckpoints(c);
        return c.map();
    }

    private static void assertClose(float[][] expectedScaled, float[][] actual, double relTol, String msg) {
        int compared = 0;
        for (int z = 0; z < actual.length; z++) {
            for (int i = 0; i < actual[z].length; i++) {
                double e = expectedScaled[z][i];
                if (Float.isNaN(expectedScaled[z][i])) { // ROI の外は値なし（NaN）。位置が一致することを見る
                    assertTrue(Float.isNaN(actual[z][i]), msg + " z=" + z + " i=" + i + " は値なしのはず");
                    continue;
                }
                assertEquals(e, actual[z][i], Math.abs(e) * relTol + 1e-9, msg + " z=" + z + " i=" + i);
                if (e != 0) compared++;
            }
        }
        assertTrue(compared > 100, "比べた非ゼロの点が少なすぎる: " + compared);
    }

    @Test
    void autoMapOfFirstOrderMeanIsTheBqmlMapTimesTheScale_noneIsUnchanged() throws Exception {
        ingestAll();
        RadiomicsMapEngine.MapResult none = map(mapReq(PET, "FIRSTORDER_Mean", settings(), "none"));
        RadiomicsMapEngine.MapResult auto = map(mapReq(PET, "FIRSTORDER_Mean", settings(), null));
        RadiomicsMapEngine.MapResult explicitAuto = map(mapReq(PET, "FIRSTORDER_Mean", settings(), "auto"));

        assertEquals("SUVbw", auto.valueCalibration().valueUnit());
        assertEquals(EXPECTED_SCALE, auto.valueCalibration().scale(), EXPECTED_SCALE * 1e-9);
        assertTrue(none.valueCalibration().uncalibratedPet());

        float[][] scaled = new float[none.data().length][];
        for (int z = 0; z < scaled.length; z++) {
            scaled[z] = new float[none.data()[z].length];
            for (int i = 0; i < scaled[z].length; i++) scaled[z][i] = (float) (none.data()[z][i] * EXPECTED_SCALE);
        }
        assertClose(scaled, auto.data(), 1e-4, "auto = none × 係数");
        assertClose(auto.data(), explicitAuto.data(), 0, "null と auto は同じ");

        // 負例: 校正が効いていなければ、none の値（Bq/mL の桁）がそのまま出てしまう
        double noneMax = 0, autoMax = 0;
        for (float[] s : none.data()) for (float v : s) if (!Float.isNaN(v)) noneMax = Math.max(noneMax, v);
        for (float[] s : auto.data()) for (float v : s) if (!Float.isNaN(v)) autoMax = Math.max(autoMax, v);
        assertTrue(noneMax > 1000 && autoMax < 100, "none=" + noneMax + " auto=" + autoMax);
    }

    @Test
    void noneEqualsTheOldPathThatPassesNoCalibrationSetting() throws Exception {
        ingestAll();
        TextureSeriesRequest r = mapReq(PET, "GLCM_JointEntropy", settings("BINCOUNT_GLCM_INT", "8"), "none");
        // 旧経路: 校正の指定を settings に足さずに読み、そのまま計算する
        RadiomicsMapEngine.LoadedVolume old = engine.load(STUDY, PET, 0, 0, MASK, 0, 1, r.settings());
        assertEquals(ValueCalibration.UNSET, old.valueCalibration());
        RadiomicsMapEngine.Computed oldRun = engine.computeFrom(r, TextureProgress.NONE, old);
        engine.discardCheckpoints(oldRun);
        RadiomicsMapEngine.MapResult none = map(r);
        for (int z = 0; z < none.data().length; z++) {
            assertArrayEquals(oldRun.map().data()[z], none.data()[z], "旧経路と none は同じ（z=" + z + "）");
        }
    }

    @Test
    void fixedBinCountMapMatchesAcrossCalibrations_fixedBinWidthDiffers() throws Exception {
        ingestAll();
        Map<String, String> count = settings("BINCOUNT_GLCM_BOOL", "true", "BINCOUNT_GLCM_INT", "8");
        RadiomicsMapEngine.MapResult a = map(mapReq(PET, "GLCM_JointEntropy", count, "auto"));
        RadiomicsMapEngine.MapResult n = map(mapReq(PET, "GLCM_JointEntropy", count, "none"));
        assertClose(n.data(), a.data(), 1e-6, "固定ビン数は校正で変わらない");

        Map<String, String> width = settings("BINCOUNT_GLCM_BOOL", "false", "BINWIDTH_GLCM_DOUBLE", "1000");
        RadiomicsMapEngine.MapResult aw = map(mapReq(PET, "GLCM_JointEntropy", width, "auto"));
        RadiomicsMapEngine.MapResult nw = map(mapReq(PET, "GLCM_JointEntropy", width, "none"));
        double maxDiff = 0;
        for (int z = 0; z < aw.data().length; z++) {
            for (int i = 0; i < aw.data()[z].length; i++) {
                float d = Math.abs(aw.data()[z][i] - nw.data()[z][i]);
                if (!Float.isNaN(d)) maxDiff = Math.max(maxDiff, d);
            }
        }
        assertTrue(maxDiff > 0.1, "固定ビン幅は単位が違えば別の離散化になる（負例）: " + maxDiff);
    }

    @Test
    void petWithoutWeightIsRefusedByAutoAndRunsWithNone() throws Exception {
        ingestAll();
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> engine.computeResumable(mapReq(PET_NO_WEIGHT, "FIRSTORDER_Mean", settings(), null),
                        TextureProgress.NONE));
        assertTrue(e.getMessage().contains("校正しない"), e.getMessage());
        RadiomicsMapEngine.MapResult none = map(mapReq(PET_NO_WEIGHT, "FIRSTORDER_Mean", settings(), "none"));
        assertTrue(none.valueCalibration().uncalibratedPet());
    }

    @Test
    void ctIsTheSameWithAutoAndWithoutACalibrationSetting() throws Exception {
        ingestAll();
        TextureSeriesRequest auto = mapReq(CT, "FIRSTORDER_Mean", settings(), "auto");
        RadiomicsMapEngine.MapResult a = map(auto);
        RadiomicsMapEngine.MapResult n = map(mapReq(CT, "FIRSTORDER_Mean", settings(), "none"));
        RadiomicsMapEngine.LoadedVolume old = engine.load(STUDY, CT, 0, 0, MASK, 0, 1, auto.settings());
        RadiomicsMapEngine.Computed oldRun = engine.computeFrom(auto, TextureProgress.NONE, old);
        engine.discardCheckpoints(oldRun);
        for (int z = 0; z < a.data().length; z++) {
            assertArrayEquals(oldRun.map().data()[z], a.data()[z], "CT: auto は従来と同じ");
            assertArrayEquals(n.data()[z], a.data()[z], "CT: none とも同じ");
        }
        assertEquals("HU", a.valueCalibration().valueUnit());
        assertEquals("", a.valueCalibration().text());
        assertFalse(TextureSeriesService.derivationDescription(auto, "FIRSTORDER_Mean", false,
                a.valueCalibration()).contains("calibration="), "校正しなかったときは項目を足さない");
    }

    @Test
    void anInvalidCalibrationIsRefused() throws Exception {
        ingestAll();
        TextureSeriesRequest bad = mapReq(PET, "FIRSTORDER_Mean", settings(), "suv");
        assertThrows(IllegalArgumentException.class, () -> engine.computeResumable(bad, TextureProgress.NONE));
        assertThrows(IllegalArgumentException.class, () -> textureService.create(bad));
        IllegalArgumentException g = assertThrows(IllegalArgumentException.class, () -> glamService.analyze(
                new GlamAnalysisRequest(STUDY, PET, MASK, 0, 0, 0, 3, settings(), "suv")));
        assertTrue(g.getMessage().contains("calibration"), g.getMessage());
        // 大文字・前後の空白は許す
        assertDoesNotThrow(() -> TextureSeriesRequest.checkCalibration(" BW "));
    }

    @Test
    void theDerivedSeriesRecordsTheCalibration() throws Exception {
        ingestAll();
        for (String cal : new String[] {null, "none"}) {
            TextureSeriesService.Result r = textureService.create(
                    mapReq(PET, "FIRSTORDER_Mean", settings(), cal));
            List<Path> files = storage.resolveFiles(STUDY, List.of(r.seriesInstanceUid()));
            Attributes h;
            try (DicomInputStream in = new DicomInputStream(files.get(0).toFile())) {
                h = in.readDatasetUntilPixelData();
            }
            String d = PmReadSupport.derivationDescription(h);
            if (cal == null) {
                assertTrue(d.contains("calibration=bw;scale="), d);
            } else {
                assertTrue(d.contains("calibration=none;scale=1.0;uncalibratedPet"), d);
            }
        }
    }

    @Test
    void anUncalibratedCheckpointIsNotPickedUpByAnAutoRun() throws Exception {
        ingestAll();
        TextureSeriesRequest none = mapReq(PET, "GLCM_JointEntropy", settings("BINCOUNT_GLCM_INT", "8"), "none");
        TextureSeriesRequest auto = mapReq(PET, "GLCM_JointEntropy", settings("BINCOUNT_GLCM_INT", "8"), "auto");
        RadiomicsMapEngine.Computed first = engine.computeResumable(none, TextureProgress.NONE);
        assertEquals(0, first.restoredSlices());
        // 正例: 同じ none なら途中結果を拾う（この検査が実在の途中結果を見ていることの確認）
        RadiomicsMapEngine.Computed again = engine.computeResumable(none, TextureProgress.NONE);
        assertTrue(again.restoredSlices() > 0, "同じ入力は途中結果を拾う");
        RadiomicsMapEngine.Computed other = engine.computeResumable(auto, TextureProgress.NONE);
        assertEquals(0, other.restoredSlices(), "校正が違えば別のキー（Bq/mL の途中結果を拾わない）");
        assertNotEquals(first.checkpointKey(), other.checkpointKey());
        engine.discardCheckpoints(first);
        engine.discardCheckpoints(other);
    }

    @Test
    void glamAnalysisCalibratesToo() throws Exception {
        ingestAll();
        Map<String, String> w1024 = settings("BINCOUNT_GLAM_BOOL", "false", "BINWIDTH_GLAM_DOUBLE", "1024");
        Map<String, String> w1 = settings("BINCOUNT_GLAM_BOOL", "false", "BINWIDTH_GLAM_DOUBLE", "1");
        GlamAnalysis none = glamService.analyze(new GlamAnalysisRequest(STUDY, PET, MASK, 0, 0, 0, 3, w1024, "none"));
        GlamAnalysis autoEquiv = glamService.analyze(new GlamAnalysisRequest(STUDY, PET, MASK, 0, 0, 0, 3, w1, null));
        assertEquals("SUVbw", autoEquiv.valueUnit());
        assertTrue(autoEquiv.calibration().startsWith("bw;scale="), autoEquiv.calibration());
        assertEquals("BQML（未校正）", none.valueUnit());
        // 単位換算後に同じ幅（SUV 1.0 = Bq/mL 1024）なら同じ離散化・同じ値
        assertEquals(none.nBins(), autoEquiv.nBins());
        assertArrayEquals(none.binOccupancy(), autoEquiv.binOccupancy());
        assertFeaturesEqual(none, autoEquiv);
        // 負例: 同じ幅の数値（1024）なら、SUV では別の離散化になる
        GlamAnalysis autoSame = glamService.analyze(new GlamAnalysisRequest(STUDY, PET, MASK, 0, 0, 0, 3, w1024, "auto"));
        assertNotEquals(none.nBins(), autoSame.nBins(), "固定ビン幅は校正で変わる");

        // 固定ビン数は一致
        Map<String, String> cnt = settings("BINCOUNT_GLAM_BOOL", "true", "BINCOUNT_GLAM_INT", "8");
        GlamAnalysis a = glamService.analyze(new GlamAnalysisRequest(STUDY, PET, MASK, 0, 0, 0, 3, cnt, "auto"));
        GlamAnalysis n = glamService.analyze(new GlamAnalysisRequest(STUDY, PET, MASK, 0, 0, 0, 3, cnt, "none"));
        assertArrayEquals(n.binOccupancy(), a.binOccupancy());
        assertFeaturesEqual(n, a);

        // CT・体重の無い PET
        GlamAnalysis ct = glamService.analyze(new GlamAnalysisRequest(STUDY, CT, MASK, 0, 0, 0, 3, cnt, null));
        assertEquals("HU", ct.valueUnit());
        assertEquals("", ct.calibration());
        assertThrows(IllegalArgumentException.class, () -> glamService.analyze(
                new GlamAnalysisRequest(STUDY, PET_NO_WEIGHT, MASK, 0, 0, 0, 3, cnt, null)));
        assertEquals("BQML（未校正）", glamService.analyze(
                new GlamAnalysisRequest(STUDY, PET_NO_WEIGHT, MASK, 0, 0, 0, 3, cnt, "none")).valueUnit());
    }

    private static void assertFeaturesEqual(GlamAnalysis expected, GlamAnalysis actual) {
        int compared = 0;
        for (var e : expected.features().entrySet()) {
            Double av = actual.features().get(e.getKey());
            if (e.getValue() == null) {
                assertNull(av, e.getKey());
            } else {
                assertEquals(e.getValue(), av, Math.abs(e.getValue()) * 1e-9 + 1e-12, e.getKey());
                compared++;
            }
        }
        assertTrue(compared > 50, "比べた特徴が少なすぎる: " + compared);
    }
}

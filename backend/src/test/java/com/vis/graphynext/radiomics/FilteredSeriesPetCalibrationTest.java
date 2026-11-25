/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import static org.junit.jupiter.api.Assertions.*;

import com.vis.graphynext.dicom.store.DicomStorageService;
import ij.ImagePlus;
import ij.ImageStack;
import ij.process.FloatProcessor;
import io.github.tatsunidas.radiomics.main.ImageFiltering;
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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

/**
 * フィルタ画像（LoG）が、PET を SUV に校正してから掛けること（既定 auto）を、合成 PET で通しで確かめる。
 * 期待値は、校正の実装（{@link ValueCalibration}）を使わず、投与量・体重から式で出した係数を生の画素に掛けた入力へ
 * 同じ LoG を掛けた結果。LoG は線形なので、校正してから掛けても掛けてから校正しても同じ。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.profiles.active=standalone",
                "spring.datasource.url=jdbc:h2:mem:filtsuv;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class FilteredSeriesPetCalibrationTest {

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
    @Autowired FilteredSeriesService service;
    @Autowired FilteredSeriesJobService jobs;
    @Autowired RadiomicsMapEngine engine;

    private static final int COLS = 24, ROWS = 20, SLICES = 8;
    private static final String STUDY = UIDUtils.createUID();
    private static final String FOR_UID = UIDUtils.createUID();
    private static final String PET = UIDUtils.createUID();
    private static final String PET_NO_WEIGHT = UIDUtils.createUID();
    private static final String PET_SUV = UIDUtils.createUID();
    private static final String CT = UIDUtils.createUID();

    /** 体重 70 kg、投与量 71.68 MBq、投与時刻＝撮像時刻（減衰なし）: SUVbw = Bq/mL × 70000 g / 71.68e6 Bq。 */
    private static final double SCALE = 70_000.0 / 71.68e6;
    private static final double SIGMA_R = 2.0;

    private static int value(int x, int y, int z) {
        double dx = x - COLS / 2.0, dy = y - ROWS / 2.0, dz = z - SLICES / 2.0;
        return (dx * dx + dy * dy + dz * dz < 20 ? 40000 : 800) + ((x * 7 + y * 13 + z * 29) % 37) * 283;
    }

    private Attributes slice(int z, String series, String kind) {
        boolean pet = kind.startsWith("PET");
        Attributes a = new Attributes();
        a.setString(Tag.PatientID, VR.LO, "FILTSUV^TEST");
        a.setString(Tag.PatientName, VR.PN, "PHANTOM^FILTSUV");
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
            a.setString(Tag.Units, VR.CS, kind.equals("PET_SUV") ? "GML" : "BQML");
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
            int v = value(x, y, z);
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
        String[][] sets = {{PET, "PET"}, {PET_NO_WEIGHT, "PET_NO_WEIGHT"}, {PET_SUV, "PET_SUV"}, {CT, "CT"}};
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

    private static FilteredSeriesRequest req(String series, String calibration) {
        return new FilteredSeriesRequest(STUDY, series, 0, 0, List.of(SIGMA_R), null, null, null, null, null, null,
                calibration);
    }

    private List<Attributes> read(String series) throws IOException {
        List<Attributes> out = new ArrayList<>();
        for (Path f : storage.resolveFiles(STUDY, List.of(series))) {
            try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
                out.add(in.readDataset());
            }
        }
        out.sort((a, b) -> Integer.compare(a.getInt(Tag.InstanceNumber, 0), b.getInt(Tag.InstanceNumber, 0)));
        return out;
    }

    /** 生の画素に係数 {@code factor} を掛けた入力へ、同じ 2D の LoG を直接掛けた float（スライスごと）。 */
    private float[][] reference(String series, double factor, double sigma) throws Exception {
        RadiomicsMapEngine.LoadedVolume raw = engine.load(STUDY, series, 0, 0, null, 0, 1, new HashMap<>());
        ImageStack st = new ImageStack(COLS, ROWS);
        for (int z = 1; z <= SLICES; z++) {
            float[] src = (float[]) raw.image().getStack().getProcessor(z).convertToFloat().getPixels();
            float[] dst = new float[src.length];
            for (int i = 0; i < src.length; i++) dst[i] = (float) (src[i] * factor);
            st.addSlice(new FloatProcessor(COLS, ROWS, dst));
        }
        ImagePlus in = new ImagePlus("ref", st);
        in.setCalibration(raw.image().getCalibration().copy());
        ImagePlus f = RadiomicsLock.call(() -> ImageFiltering.laplacianOfGaussian(
                in, sigma, 4.0, ImageFiltering.Padding.MIRROR, true));
        float[][] out = new float[SLICES][];
        for (int z = 0; z < SLICES; z++) out[z] = (float[]) f.getStack().getProcessor(z + 1).convertToFloat().getPixels();
        return out;
    }

    private static String unitCode(Attributes a) {
        return a.getSequence(Tag.SharedFunctionalGroupsSequence).get(0)
                .getSequence(Tag.RealWorldValueMappingSequence).get(0)
                .getSequence(Tag.MeasurementUnitsCodeSequence).get(0).getString(Tag.CodeValue);
    }

    /** 出力（RWVM で実値に戻したもの）と参照の、全画素での最大の絶対差。 */
    private double maxErr(List<Attributes> made, float[][] want) throws IOException {
        double worst = 0;
        for (int z = 0; z < SLICES; z++) {
            float[] got = PmReadSupport.decode(made.get(z));
            for (int i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[z][i]));
        }
        return worst;
    }

    private double slope(List<Attributes> made) {
        return PmReadSupport.slope(made.get(0));
    }

    private FilteredSeriesService.Created one(FilteredSeriesRequest r) throws IOException {
        return service.create(r).series().get(0);
    }

    @Test
    void autoFiltersTheSuvbwValuesAndMatchesAnIndependentReference_wrongCoefficientIsRejected() throws Exception {
        ingestAll();
        for (String cal : new String[] {null, "auto", "bw"}) {
            FilteredSeriesService.Created c = one(req(PET, cal));
            List<Attributes> made = read(c.seriesInstanceUid());
            double tol = slope(made) / 2.0 * 1.001 + 1e-9;
            double err = maxErr(made, reference(PET, SCALE, c.sigmaMm()));
            assertTrue(err <= tol, "cal=" + cal + " 最大誤差 " + err + " > 量子化の半分 " + tol);
            // 負例: 体重を 80 kg と取り違えた係数の参照とは、量子化の刻みより十分大きく違う
            double wrong = maxErr(made, reference(PET, SCALE * 80.0 / 70.0, c.sigmaMm()));
            assertTrue(wrong > 20 * tol, "誤った係数で不一致になるはず: " + wrong + " vs tol " + tol);
            // 校正しない参照（Bq/mL のまま）とも違う
            assertTrue(maxErr(made, reference(PET, 1.0, c.sigmaMm())) > 20 * tol);
            assertEquals("g/ml{SUVbw}", unitCode(made.get(0)));
            String d = PmReadSupport.derivationDescription(made.get(0));
            assertTrue(d.contains("input_calibration=bw;scale="), d);
            assertTrue(d.contains("input_unit=SUVbw"), d);
        }
    }

    @Test
    void noneKeepsBqPerMlAndRecordsIt() throws Exception {
        ingestAll();
        FilteredSeriesService.Created c = one(req(PET, "none"));
        List<Attributes> made = read(c.seriesInstanceUid());
        double tol = slope(made) / 2.0 * 1.001 + 1e-9;
        assertTrue(maxErr(made, reference(PET, 1.0, c.sigmaMm())) <= tol);
        assertTrue(maxErr(made, reference(PET, SCALE, c.sigmaMm())) > 20 * tol, "負例: SUV の参照とは違う");
        assertEquals("Bq/ml", unitCode(made.get(0)));
        String d = PmReadSupport.derivationDescription(made.get(0));
        assertTrue(d.contains("input_calibration=none;scale=1.0;uncalibratedPet"), d);
        assertTrue(d.contains("input_unit=BQML（未校正）"), d);
    }

    @Test
    void petWithoutWeightFailsWithTheReasonAndRunsWithNone() throws Exception {
        ingestAll();
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> service.create(req(PET_NO_WEIGHT, null)));
        assertTrue(e.getMessage().contains("校正しない"), e.getMessage());
        assertTrue(e.getMessage().contains("SUVbw"), e.getMessage());
        FilteredSeriesService.Created c = one(req(PET_NO_WEIGHT, "none"));
        assertEquals("Bq/ml", unitCode(read(c.seriesInstanceUid()).get(0)));
    }

    @Test
    void ctIsUnchangedByAutoAndKeepsNoUnits() throws Exception {
        ingestAll();
        // 変更前の経路（校正の指定を渡さない）と画素のバイト列が全画素一致
        RadiomicsMapEngine.LoadedVolume old = engine.load(STUDY, CT, 0, 0, null, 0, 1, new HashMap<>());
        FilteredSeriesService.Created c = one(req(CT, null));
        ImagePlus f = RadiomicsLock.call(() -> ImageFiltering.laplacianOfGaussian(
                old.image(), c.sigmaMm(), 4.0, ImageFiltering.Padding.MIRROR, true));
        float[][] data = new float[SLICES][];
        for (int z = 0; z < SLICES; z++) data[z] = (float[]) f.getStack().getProcessor(z + 1).convertToFloat().getPixels();
        double[] q = TextureSeriesService.quantization(TextureSeriesService.minMax(data));
        List<Attributes> made = read(c.seriesInstanceUid());
        for (int z = 0; z < SLICES; z++) {
            assertArrayEquals(TextureSeriesService.to16bit(data[z], q[2], q[3]),
                    made.get(z).getSafeBytes(Tag.PixelData), "CT z=" + z + " は変更前と全画素一致");
        }
        assertEquals("1", unitCode(made.get(0)));
        assertFalse(PmReadSupport.derivationDescription(made.get(0)).contains("input_calibration"));
        // CT に SUV を指定すれば断る
        assertThrows(IllegalArgumentException.class, () -> service.create(req(CT, "bw")));
    }

    @Test
    void anAlreadySuvSeriesIsNotCalibratedAgain() throws Exception {
        ingestAll();
        FilteredSeriesService.Created c = one(req(PET_SUV, null));
        List<Attributes> made = read(c.seriesInstanceUid());
        double tol = slope(made) / 2.0 * 1.001 + 1e-9;
        assertTrue(maxErr(made, reference(PET_SUV, 1.0, c.sigmaMm())) <= tol, "元の値のまま");
        assertEquals("1", unitCode(made.get(0)), "元が SUV かどうかの単位は断定しない");
        assertTrue(PmReadSupport.derivationDescription(made.get(0)).contains("input_calibration=already-suv"));
    }

    @Test
    void anInvalidCalibrationIsRefusedAtSubmitNotAsAFailedJob() throws Exception {
        ingestAll();
        assertThrows(IllegalArgumentException.class, () -> jobs.submit(req(PET, "suv")));
    }
}

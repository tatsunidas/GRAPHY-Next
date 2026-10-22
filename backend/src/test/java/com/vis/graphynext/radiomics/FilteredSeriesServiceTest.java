/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import static org.junit.jupiter.api.Assertions.*;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.nifti.FloatNiftiFixture;
import ij.ImagePlus;
import io.github.tatsunidas.radiomics.main.ImageFiltering;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
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
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.atomic.AtomicBoolean;

/** フィルタ画像（LoG の派生シリーズ）。元と同じ格子・値が直接の LoG と量子化の範囲で一致・記録の属性。 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.profiles.active=standalone",
                "spring.datasource.url=jdbc:h2:mem:filtered;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class FilteredSeriesServiceTest {

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
    FilteredSeriesService service;

    @Autowired
    RadiomicsMapEngine engine;

    private static final int N = 24;
    private static final int NZ = 10;
    private static final String STUDY = UIDUtils.createUID();

    /** 中心に明るい球状の塊（符号と空間スケールが出る）。 */
    private static float value(int i, int j, int k) {
        double dx = i - N / 2.0, dy = j - N / 2.0, dz = k - NZ / 2.0;
        return (float) (dx * dx + dy * dy + dz * dz < 30 ? 1000 : 0) + 3f * (i % 3);
    }

    private String ingest(double dxy, double dz) throws IOException {
        String series = UIDUtils.createUID();
        Path nii = FloatNiftiFixture.write(Files.createTempFile(tmp, "f", ".nii"), N, N, NZ, dxy, dxy, dz,
                FilteredSeriesServiceTest::value);
        for (Attributes ds : FloatNiftiFixture.toParametricMap(nii, "PM^F", "PM^F", STUDY, series, "HU")) {
            Path f = Files.createTempFile(tmp, "pm", ".dcm");
            try (DicomOutputStream out = new DicomOutputStream(f.toFile())) {
                out.writeDataset(ds.createFileMetaInformation(UID.ExplicitVRLittleEndian), ds);
            }
            storage.ingest(f);
        }
        return series;
    }

    private static FilteredSeriesRequest req(String series, List<Double> scales, String notation, String conversion,
                                             String dimension) {
        return new FilteredSeriesRequest(STUDY, series, 0, 0, scales, notation, conversion, null, dimension, null, null);
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

    /** Rescale を通した値（float 復元）。 */
    private static float[] decode(Attributes a) throws IOException {
        byte[] px = a.getBytes(Tag.PixelData);
        ByteBuffer bb = ByteBuffer.wrap(px).order(ByteOrder.LITTLE_ENDIAN);
        double slope = a.getDouble(Tag.RescaleSlope, 1), intercept = a.getDouble(Tag.RescaleIntercept, 0);
        float[] v = new float[px.length / 2];
        for (int i = 0; i < v.length; i++) {
            v[i] = (float) ((bb.getShort() & 0xFFFF) * slope + intercept);
        }
        return v;
    }

    /** 直接 RadiomicsJ の LoG を掛けた float（スライスごと）。 */
    private float[][] direct(String series, double sigma, boolean planar) throws Exception {
        RadiomicsMapEngine.LoadedVolume vol = engine.load(STUDY, series, 0, 0, null, 0, 1, new HashMap<>());
        ImagePlus f = RadiomicsLock.call(() -> ImageFiltering.laplacianOfGaussian(
                vol.image(), sigma, 4.0, ImageFiltering.Padding.MIRROR, planar));
        float[][] out = new float[NZ][];
        for (int z = 0; z < NZ; z++) {
            out[z] = (float[]) f.getStack().getProcessor(z + 1).convertToFloat().getPixels();
        }
        return out;
    }

    @Test
    void createsOneSeriesPerScaleOnTheSourceGridWithValuesMatchingTheDirectFilter() throws Exception {
        String src = ingest(0.7, 2.0);
        FilteredSeriesService.Result r = service.create(req(src, List.of(2.0, 4.0), null, null, null));
        assertEquals(2, r.series().size());
        assertEquals(2.0, r.series().get(0).scaleMm());
        assertEquals(1.4142, r.series().get(0).sigmaMm(), "2D の面内なので d=2: σ = r/√2");
        assertEquals(2.8284, r.series().get(1).sigmaMm());

        List<Attributes> source = read(src);
        for (FilteredSeriesService.Created c : r.series()) {
            List<Attributes> made = read(c.seriesInstanceUid());
            assertEquals(NZ, made.size());
            float[][] want = direct(src, c.sigmaMm(), true);
            for (int z = 0; z < NZ; z++) {
                Attributes a = made.get(z), s = source.get(z);
                // 幾何が元と同じ
                assertArrayEquals(s.getDoubles(Tag.ImagePositionPatient), a.getDoubles(Tag.ImagePositionPatient), 1e-9);
                assertArrayEquals(s.getDoubles(Tag.ImageOrientationPatient), a.getDoubles(Tag.ImageOrientationPatient), 1e-9);
                assertArrayEquals(s.getDoubles(Tag.PixelSpacing), a.getDoubles(Tag.PixelSpacing), 1e-9);
                assertEquals(s.getInt(Tag.Rows, 0), a.getInt(Tag.Rows, -1));
                assertEquals(s.getInt(Tag.Columns, 0), a.getInt(Tag.Columns, -1));
                // 値: 直接の LoG と量子化の刻み（RescaleSlope）の半分以内
                double tol = a.getDouble(Tag.RescaleSlope, 1) / 2.0 + 1e-6;
                float[] got = decode(a);
                assertEquals(want[z].length, got.length);
                for (int i = 0; i < got.length; i++) {
                    assertEquals(want[z][i], got[i], tol, "z=" + z + " i=" + i);
                }
                // 参照
                Sequence ref = a.getSequence(Tag.SourceImageSequence);
                assertNotNull(ref);
                assertEquals(s.getString(Tag.SOPInstanceUID), ref.get(0).getString(Tag.ReferencedSOPInstanceUID));
            }
            Attributes first = made.get(0);
            assertArrayEquals(new String[] {"DERIVED", "SECONDARY", "LOG"}, first.getStrings(Tag.ImageType));
            String d = first.getString(Tag.DerivationDescription);
            assertTrue(d.startsWith("filter=LoG; r_mm=" + FilterScale.settingValue(c.scaleMm())
                    + "; sigma_mm=" + FilterScale.settingValue(c.sigmaMm())
                    + "; scale_to_sigma=SQRT_D; dim=2D; truncate_sigma=4.0; boundary=MIRROR; radiomicsj="), d);
            assertEquals("LoG_r" + FilterScale.settingValue(c.scaleMm()), first.getString(Tag.RescaleType));
            assertEquals(0.0, first.getDouble(Tag.WindowCenter, 1), "0 が窓の中心（符号が見える）");
            assertTrue(first.getDouble(Tag.WindowWidth, 0) > 0);
        }
    }

    @Test
    void aDifferentConversionGivesDifferentValues() throws Exception {
        String src = ingest(0.7, 2.0);
        FilteredSeriesService.Result a = service.create(req(src, List.of(2.0), null, "SQRT_D", null));
        FilteredSeriesService.Result b = service.create(req(src, List.of(2.0), null, "IDENTITY", null));
        assertEquals(1.4142, a.series().get(0).sigmaMm());
        assertEquals(2.0, b.series().get(0).sigmaMm());
        float[] x = decode(read(a.series().get(0).seriesInstanceUid()).get(NZ / 2));
        float[] y = decode(read(b.series().get(0).seriesInstanceUid()).get(NZ / 2));
        double worst = 0;
        for (int i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
        assertTrue(worst > 1.0, "換算を σ=r にすると値が変わる（負例）: " + worst);
    }

    @Test
    void threeDimensionalFilterNeedsAnIsotropicGridAndIsRefusedInJapanese() throws Exception {
        String aniso = ingest(0.7, 2.0);
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> service.create(req(aniso, List.of(2.0), null, null, "3D")));
        assertTrue(e.getMessage().contains("リサンプリング"), e.getMessage());
        // 等方の格子なら 3D も作れて、直接の 3D の LoG と一致する（d=3: σ = r/√3）
        String iso = ingest(0.7, 0.7);
        FilteredSeriesService.Result r = service.create(req(iso, List.of(2.0), null, null, "3D"));
        assertEquals(1.1547, r.series().get(0).sigmaMm());
        assertTrue(read(r.series().get(0).seriesInstanceUid()).get(0).getString(Tag.DerivationDescription).contains("dim=3D"));
        float[][] want = direct(iso, 1.1547, false);
        List<Attributes> made = read(r.series().get(0).seriesInstanceUid());
        double tol = made.get(0).getDouble(Tag.RescaleSlope, 1) / 2.0 + 1e-6;
        float[] got = decode(made.get(NZ / 2));
        for (int i = 0; i < got.length; i++) assertEquals(want[NZ / 2][i], got[i], tol);
    }

    @Test
    void widthInPixelsIsConvertedWithTheSourcePixelSpacing() throws Exception {
        String src = ingest(0.7, 2.0);
        FilteredSeriesService.Result r = service.create(req(src, List.of(4.0), "WIDTH_PX", null, null));
        assertEquals(1.4, r.series().get(0).scaleMm(), 1e-12, "幅 4 画素 × 0.7 mm / 2");
        assertTrue(read(r.series().get(0).seriesInstanceUid()).get(0).getString(Tag.SeriesDescription).startsWith("LoG r1.4 "));
    }

    @Test
    void badInputIsRefused() throws Exception {
        String src = ingest(0.7, 2.0);
        assertThrows(IllegalArgumentException.class, () -> service.create(req(src, List.of(0.0), null, null, null)),
                "0 はフィルタなし");
        assertThrows(IllegalArgumentException.class, () -> service.create(req(src, List.of(-1.0), null, null, null)));
        assertThrows(IllegalArgumentException.class, () -> service.create(req(src, List.of(), null, null, null)));
        assertThrows(IllegalArgumentException.class, () -> service.create(req(src, List.of(2.0), null, "NOPE", null)));
        assertThrows(IllegalArgumentException.class, () -> service.create(req(src, List.of(2.0), null, null, "4D")));
        assertThrows(IllegalArgumentException.class,
                () -> service.create(new FilteredSeriesRequest(STUDY, src, 0, 0, List.of(2.0), null, null, null, null, 0.5, null)));
        assertThrows(IllegalArgumentException.class,
                () -> service.create(new FilteredSeriesRequest(STUDY, src, 0, 0, List.of(2.0), null, null, null, null, null, "WRAP")));
        assertThrows(IllegalArgumentException.class, () -> service.create(req("1.2.3", List.of(2.0), null, null, null)));
    }

    @Test
    void cancelStopsBeforeTheNextScaleAndKeepsTheFinishedOne() throws Exception {
        String src = ingest(0.7, 2.0);
        AtomicBoolean cancel = new AtomicBoolean();
        List<FilteredSeriesService.Created> made = new ArrayList<>();
        assertThrows(CancellationException.class, () -> service.create(req(src, List.of(2.0, 3.0, 4.0), null, null, null),
                (done, total, rMm) -> { }, cancel::get, c -> {
                    made.add(c);
                    cancel.set(true); // 1 本目を書き終えた直後に取り消す
                }));
        assertEquals(1, made.size(), "残りは始めない");
        assertEquals(NZ, read(made.get(0).seriesInstanceUid()).size(), "作り終えた分は保管庫に残る");
    }
}

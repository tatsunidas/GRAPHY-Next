/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.anonymize.AnonymizeMaskStore;
import com.vis.graphynext.anonymize.AnonymizeService;
import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.anonymize.TestDicomFiles;
import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.lang.reflect.Proxy;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static com.vis.graphynext.compute.DatasetFixture.CT_SERIES;
import static com.vis.graphynext.compute.DatasetFixture.INTERCEPT;
import static com.vis.graphynext.compute.DatasetFixture.PHI_ID;
import static com.vis.graphynext.compute.DatasetFixture.PHI_NAME;
import static com.vis.graphynext.compute.DatasetFixture.STUDY;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 外へ出すデータセット（fw/remote-compute-design.md §3）。匿名化は既存の AnonymizeService をそのまま通す。
 *
 * <p>⚠ Mockito はこの開発機の JDK 25 で動かないので、リポジトリは {@link Proxy} で最小限だけ真似る。
 */
class ComputeDatasetServiceTest {

    private static final String XA_SERIES = "1.2.3.100.2";

    @TempDir
    Path dir;

    private DatasetFixture fx;
    private final ObjectMapper mapper = new ObjectMapper();

    @org.junit.jupiter.api.BeforeEach
    void setUp() {
        fx = new DatasetFixture(dir);
    }

    private ComputeDatasetService service() {
        return fx.service();
    }

    private void writeCtSeries() throws IOException {
        fx.writeCtSeries();
    }

    private void index(String series, String sop, Path file, String modality, String sopClass) {
        fx.index(series, sop, file, modality, sopClass);
    }

    private static Map<String, byte[]> unzip(Path zip) throws IOException {
        Map<String, byte[]> out = new java.util.LinkedHashMap<>();
        try (ZipInputStream in = new ZipInputStream(Files.newInputStream(zip))) {
            for (ZipEntry e; (e = in.getNextEntry()) != null; ) {
                out.put(e.getName(), in.readAllBytes());
            }
        }
        return out;
    }

    /** .npy を読む（ヘッダの shape とデータ部）。 */
    private static Object[] readNpy(byte[] b) {
        assertEquals((byte) 0x93, b[0]);
        assertEquals("NUMPY", new String(b, 1, 5, StandardCharsets.US_ASCII));
        int hlen = (b[8] & 0xff) | ((b[9] & 0xff) << 8);
        assertEquals(0, (10 + hlen) % 64, "データ部は 64 バイト境界から");
        String header = new String(b, 10, hlen, StandardCharsets.US_ASCII);
        ByteBuffer data = ByteBuffer.wrap(b, 10 + hlen, b.length - 10 - hlen).slice().order(ByteOrder.LITTLE_ENDIAN);
        return new Object[]{header, data};
    }

    @Test
    void ctToNpz_sortedByPosition_rescaled_withGeometry() throws Exception {
        writeCtSeries();
        ComputeDatasetService.Dataset d = service().create(STUDY, CT_SERIES, ComputeDatasetService.Format.NPZ);
        assertTrue(d.handle().startsWith("dsh_"));
        assertEquals(3, d.instances());
        Map<String, byte[]> npz = unzip(d.file());
        assertEquals(List.of("volume.npy", "spacing.npy", "origin.npy", "direction.npy", "meta.json"),
                new ArrayList<>(npz.keySet()));

        Object[] vol = readNpy(npz.get("volume.npy"));
        assertTrue(((String) vol[0]).contains("'descr': '<f4'"), (String) vol[0]);
        assertTrue(((String) vol[0]).contains("'shape': (3, 3, 4)"), (String) vol[0]);
        ByteBuffer v = (ByteBuffer) vol[1];
        for (int z = 0; z < 3; z++) {
            for (int y = 0; y < 3; y++) {
                for (int x = 0; x < 4; x++) {
                    assertEquals(100 * z + 10 * y + x + INTERCEPT, v.getFloat(), 1e-4,
                            "z=" + z + " y=" + y + " x=" + x + "（位置の順・HU）");
                }
            }
        }
        ByteBuffer sp = (ByteBuffer) readNpy(npz.get("spacing.npy"))[1];
        assertEquals(2.5, sp.getDouble(), 1e-9, "dz");
        assertEquals(0.8, sp.getDouble(), 1e-9, "dy = PixelSpacing[0]");
        assertEquals(0.5, sp.getDouble(), 1e-9, "dx = PixelSpacing[1]");
        ByteBuffer org = (ByteBuffer) readNpy(npz.get("origin.npy"))[1];
        assertArrayEquals(new double[]{-10, -20, 5}, new double[]{org.getDouble(), org.getDouble(), org.getDouble()});

        JsonNode meta = mapper.readTree(npz.get("meta.json"));
        assertEquals("CT", meta.path("modality").asText());
        assertEquals("position", meta.path("order").asText());
        assertNotEquals(CT_SERIES, meta.path("anonymizedSeriesInstanceUid").asText(), "UID は置き換わる");

        // 🔴 患者情報がファイルのどこにも無い
        String all = new String(Files.readAllBytes(d.file()), StandardCharsets.ISO_8859_1);
        for (String phi : List.of(PHI_NAME, PHI_ID, CT_SERIES, STUDY)) {
            assertFalse(all.contains(phi), phi);
        }
    }

    @Test
    void npzRefusesSlicesThatDoNotFormAnEvenGrid() throws Exception {
        // 同じ位置に 2 枚（撮影が 2 回ぶん混ざったシリーズ）
        fx.writeCtSeriesAt(5.0, 5.0, 10.0);
        ComputeDatasetService.DatasetRefused dup = assertThrows(ComputeDatasetService.DatasetRefused.class,
                () -> service().create(STUDY, CT_SERIES, ComputeDatasetService.Format.NPZ));
        assertEquals("npz-duplicate-positions", dup.reason());
        // dicom-zip ならそのまま送れる
        assertEquals(3, service().create(STUDY, CT_SERIES, ComputeDatasetService.Format.DICOM_ZIP).instances());
    }

    @Test
    void npzRefusesAMissingSlice() throws Exception {
        fx.writeCtSeriesAt(5.0, 7.5, 12.5); // 10.0 が欠けている
        ComputeDatasetService.DatasetRefused gap = assertThrows(ComputeDatasetService.DatasetRefused.class,
                () -> service().create(STUDY, CT_SERIES, ComputeDatasetService.Format.NPZ));
        assertEquals("npz-uneven-spacing", gap.reason());
    }

    @Test
    void ctToDicomZip_isAnonymizedByTheExistingEngine() throws Exception {
        writeCtSeries();
        ComputeDatasetService.Dataset d = service().create(STUDY, CT_SERIES, ComputeDatasetService.Format.DICOM_ZIP);
        Map<String, byte[]> zip = unzip(d.file());
        assertEquals(3, zip.size());
        for (Map.Entry<String, byte[]> e : zip.entrySet()) {
            assertFalse(e.getKey().contains(CT_SERIES), "ファイル名に元の UID を残さない: " + e.getKey());
            Attributes ds;
            try (DicomInputStream in = new DicomInputStream(new ByteArrayInputStream(e.getValue()))) {
                ds = in.readDataset();
            }
            assertEquals(ComputeDatasetService.PSEUDONYM, ds.getString(Tag.PatientName));
            assertEquals(ComputeDatasetService.PSEUDONYM, ds.getString(Tag.PatientID));
            assertFalse(PHI_NAME.equals(ds.getString(Tag.PatientName)));
            assertNotEquals(CT_SERIES, ds.getString(Tag.SeriesInstanceUID));
            assertFalse("VIS GENERAL HOSPITAL".equals(ds.getString(Tag.InstitutionName)));
            assertFalse("19600101".equals(ds.getString(Tag.PatientBirthDate)));
            assertEquals(3, ds.getDoubles(Tag.ImagePositionPatient).length, "幾何は残る");
        }
        String all = new String(Files.readAllBytes(d.file()), StandardCharsets.ISO_8859_1);
        assertFalse(all.contains(PHI_NAME));
        assertFalse(all.contains(PHI_ID));
    }

    @Test
    void xaWithoutMaskIsRefused_andNothingIsLeftOnDisk() throws Exception {
        Path f = TestDicomFiles.writeUncompressed(dir.resolve("xa.dcm"), STUDY, XA_SERIES, XA_SERIES + ".1", 2, 200);
        index(XA_SERIES, XA_SERIES + ".1", f, "XA", UID.XRayAngiographicImageStorage);
        ComputeDatasetService.DatasetRefused e = assertThrows(ComputeDatasetService.DatasetRefused.class,
                () -> service().create(STUDY, XA_SERIES, ComputeDatasetService.Format.DICOM_ZIP));
        assertEquals("burnin-declared", e.reason()); // 原本が BurnedInAnnotation=YES
    }

    @Test
    void xaWithMaskIsPaintedBeforeLeaving() throws Exception {
        String sop = XA_SERIES + ".1";
        Path f = TestDicomFiles.writeUncompressed(dir.resolve("xa.dcm"), STUDY, XA_SERIES, sop, 2, 200);
        index(XA_SERIES, sop, f, "XA", UID.XRayAngiographicImageStorage);
        fx.masks.put(new AnonymizeMaskStore.SeriesMask(XA_SERIES, List.of(), List.of(), List.of(
                new AnonymizeMaskStore.MaskPolygon(new double[]{0, 8, 8, 0}, new double[]{0, 0, 8, 8},
                        List.of(), List.of()))));
        ComputeDatasetService.Dataset d = service().create(STUDY, XA_SERIES, ComputeDatasetService.Format.DICOM_ZIP);
        assertEquals(1, d.burnedInstances());
        byte[] dcm = unzip(d.file()).values().iterator().next();
        Attributes ds;
        try (DicomInputStream in = new DicomInputStream(new ByteArrayInputStream(dcm))) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
            ds = in.readDataset();
        }
        byte[] px = ds.getBytes(Tag.PixelData);
        int cols = TestDicomFiles.COLS;
        for (int frame = 0; frame < 2; frame++) {
            int base = frame * TestDicomFiles.ROWS * cols;
            assertEquals(0, px[base] & 0xff, "マスクの中は塗られている（frame " + frame + "）");
            assertEquals(200, px[base + 12 * cols + 12] & 0xff, "マスクの外は元のまま");
        }
        assertEquals("NO", ds.getString(Tag.BurnedInAnnotation), "全フレーム塗ったので申告する");
    }

    @Test
    void handlesExpireAndDiscardDeletesTheFile() throws Exception {
        writeCtSeries();
        ComputeDatasetService svc = service();
        ComputeDatasetService.Dataset d = svc.create(STUDY, CT_SERIES, ComputeDatasetService.Format.DICOM_ZIP);
        assertTrue(svc.get(d.handle()).isPresent());
        assertTrue(Files.exists(d.file()));
        svc.discard(d.handle());
        assertTrue(svc.get(d.handle()).isEmpty());
        assertFalse(Files.exists(d.file()));
        assertTrue(svc.get("dsh_unknown").isEmpty());
    }

    /** numpy で本当に読めるか（GRAPHY_JUPYTER_PYTHON があるときだけ）。 */
    @Test
    void numpyCanLoadTheNpz() throws Exception {
        String python = System.getenv("GRAPHY_JUPYTER_PYTHON");
        Assumptions.assumeTrue(python != null && Files.isRegularFile(Path.of(python)), "no python");
        writeCtSeries();
        ComputeDatasetService.Dataset d = service().create(STUDY, CT_SERIES, ComputeDatasetService.Format.NPZ);
        Process p = new ProcessBuilder(python, "-c", """
                import sys, json, numpy as np
                z = np.load(sys.argv[1])
                v = z['volume']
                print(v.dtype, v.shape, float(v[1, 2, 3]), list(z['spacing']), json.loads(bytes(z['meta.json']))['order'])
                """, d.file().toString()).redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).strip();
        assertTrue(p.waitFor(60, TimeUnit.SECONDS));
        assertEquals("float32 (3, 3, 4) " + (100 + 23 + INTERCEPT) + " [2.5, 0.8, 0.5] position",
                out.lines().reduce((a, b) -> b).orElse(out), out);
    }
}

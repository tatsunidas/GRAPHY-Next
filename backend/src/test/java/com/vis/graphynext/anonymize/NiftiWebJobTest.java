/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.compute.ComputeDatasetService;
import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import com.vis.graphynext.nifti.NiftiExportController;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.GZIPInputStream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * web の NIfTI 書き出し（PM-IO-901 段 2b）。偽の PACS から取った合成シリーズが、standalone（ローカルファイル）の
 * 書き出しとバイト単位で一致すること、断る種類は断ってファイルを残さないこと、受け取りは 1 回だけであることを確かめる。
 */
class NiftiWebJobTest {

    private static final String STUDY = "1.2.826.0.1.3680043.8.498.1";
    private static final String SERIES = "1.2.826.0.1.3680043.8.498.2";
    private static final int COLS = 8, ROWS = 6;

    @TempDir
    Path dir;

    private FakePacs pacs;
    private AnonymizeJobService jobs;

    @AfterEach
    void tearDown() {
        if (jobs != null) {
            jobs.shutdown();
        }
        if (pacs != null) {
            pacs.close();
        }
    }

    /** 合成 1 枚（軸位。IPP z = 2.5·k）。画素 = k*100 + 位置。 */
    private Path slice(int k, String sop, String modality, String burned) throws IOException {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, "CT".equals(modality) ? UID.CTImageStorage : UID.XRayAngiographicImageStorage);
        ds.setString(Tag.SOPInstanceUID, VR.UI, sop);
        ds.setString(Tag.StudyInstanceUID, VR.UI, STUDY);
        ds.setString(Tag.SeriesInstanceUID, VR.UI, SERIES);
        ds.setString(Tag.PatientID, VR.LO, "P1");
        ds.setString(Tag.PatientName, VR.PN, "TEST^PATIENT");
        ds.setString(Tag.Modality, VR.CS, modality);
        if (burned != null) {
            ds.setString(Tag.BurnedInAnnotation, VR.CS, burned);
        }
        ds.setInt(Tag.InstanceNumber, VR.IS, k + 1);
        ds.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        ds.setInt(Tag.Rows, VR.US, ROWS);
        ds.setInt(Tag.Columns, VR.US, COLS);
        ds.setInt(Tag.BitsAllocated, VR.US, 16);
        ds.setInt(Tag.BitsStored, VR.US, 16);
        ds.setInt(Tag.HighBit, VR.US, 15);
        ds.setInt(Tag.PixelRepresentation, VR.US, 0);
        ds.setInt(Tag.SamplesPerPixel, VR.US, 1);
        ds.setDouble(Tag.PixelSpacing, VR.DS, 0.6, 0.8);
        ds.setDouble(Tag.ImageOrientationPatient, VR.DS, 1, 0, 0, 0, 1, 0);
        ds.setDouble(Tag.ImagePositionPatient, VR.DS, -10, 20, 30 + 2.5 * k);
        ds.setDouble(Tag.RescaleSlope, VR.DS, 1);
        ds.setDouble(Tag.RescaleIntercept, VR.DS, -1024);
        ByteBuffer px = ByteBuffer.allocate(ROWS * COLS * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int p = 0; p < ROWS * COLS; p++) {
            px.putShort((short) (k * 100 + p));
        }
        ds.setBytes(Tag.PixelData, VR.OW, px.array());
        Path f = dir.resolve("s" + k + "-" + sop + ".dcm");
        Attributes fmi = ds.createFileMetaInformation(UID.ExplicitVRLittleEndian);
        try (OutputStream os = Files.newOutputStream(f);
                DicomOutputStream dos = new DicomOutputStream(os, UID.ExplicitVRLittleEndian)) {
            dos.writeDataset(fmi, ds);
        }
        return f;
    }

    private record Setup(ComputeDatasetService datasets, ComputeDatasetService standalone, List<Path> files) {
    }

    /** ks の順に PACS へ入れる（逆順保管など）。web 用とは別に、同じファイルを読む standalone の組も作る。 */
    @SuppressWarnings("unchecked")
    private Setup setUp(int[] ks, String modality, String burned) throws IOException {
        List<Path> files = new ArrayList<>();
        String[] sops = new String[ks.length];
        String[] series = new String[ks.length];
        List<DicomInstance> insts = new ArrayList<>();
        for (int i = 0; i < ks.length; i++) {
            sops[i] = "1.2.826.0.1.3680043.8.498.10" + ks[i];
            series[i] = SERIES;
            files.add(slice(ks[i], sops[i], modality, burned));
            DicomInstance in = new DicomInstance(sops[i]);
            in.setUri(files.get(i).toUri().toString());
            in.setStudyInstanceUid(STUDY);
            in.setSeriesInstanceUid(SERIES);
            in.setPatientId("P1");
            in.setModality(modality);
            in.setSopClassUid("CT".equals(modality) ? UID.CTImageStorage : UID.XRayAngiographicImageStorage);
            insts.add(in);
        }
        pacs = new FakePacs(STUDY, sops, series, files.toArray(new Path[0]));
        DicomInstanceRepository repo = Mockito.mock(DicomInstanceRepository.class);
        Mockito.when(repo.findBySeries(STUDY, SERIES)).thenReturn(insts);
        Mockito.when(repo.findByStudyInstanceUid(STUDY)).thenReturn(insts);
        ObjectProvider<WebDicomDataService> web = Mockito.mock(ObjectProvider.class);
        Mockito.when(web.getIfAvailable()).thenReturn(pacs.web);
        ObjectProvider<WebDicomDataService> none = Mockito.mock(ObjectProvider.class);
        Mockito.when(none.getIfAvailable()).thenReturn(null);
        PixelCodec codec = new PixelCodec(new DicomProperties());
        StorageLayout layout = new StorageLayout(Path.of("target", "no-storage-root"));
        AnonymizeService webSvc = new AnonymizeService(repo, new AnonymizeMaskStore(), web, codec, layout);
        AnonymizeService localSvc = new AnonymizeService(repo, new AnonymizeMaskStore(), none, codec, layout);
        ComputeDatasetService webDs = new ComputeDatasetService(webSvc, codec, new ObjectMapper());
        ComputeDatasetService localDs = new ComputeDatasetService(localSvc, codec, new ObjectMapper());
        jobs = new AnonymizeJobService(webSvc, webDs, pacs.web, dir.resolve("jobs"), 2, 60_000);
        return new Setup(webDs, localDs, files);
    }

    private AnonymizeJobService.Status await(String id) throws InterruptedException {
        AnonymizeJobService.Status st = null;
        for (int i = 0; i < 400; i++) {
            st = jobs.status(id);
            if (st != null && st.state() != AnonymizeJobService.State.QUEUED
                    && st.state() != AnonymizeJobService.State.RUNNING) {
                return st;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("ジョブが終わらない: " + st);
    }

    private static byte[] gunzip(Path f) throws IOException {
        try (GZIPInputStream in = new GZIPInputStream(Files.newInputStream(f))) {
            return in.readAllBytes();
        }
    }

    @Test
    void web_nifti_is_byte_identical_to_standalone_and_received_once() throws Exception {
        Setup s = setUp(new int[]{3, 0, 4, 1, 2}, "CT", "NO"); // 逆順・飛び飛びに保管
        String id = jobs.submitNifti(STUDY, SERIES).jobId();
        AnonymizeJobService.Status st = await(id);
        assertEquals(AnonymizeJobService.State.DONE, st.state(), String.valueOf(st.error()));
        assertEquals("nifti", st.output());
        assertEquals(5, st.slices());
        assertEquals(5, st.processed());

        Path web = jobs.niftiOf(id);
        assertNotNull(web);
        ComputeDatasetService.Dataset local = s.standalone().create(STUDY, SERIES, ComputeDatasetService.Format.NIFTI, true);
        byte[] localBytes = gunzip(local.file());
        byte[] webBytes = gunzip(web);
        assertArrayEquals(localBytes, webBytes, "web と standalone の NIfTI がバイト単位で一致する");

        // 手で確かめる: dim=[3,8,6,5]・float32・先頭スライス（k=0）の画素 = 0*100+p → HU = p-1024
        ByteBuffer b = ByteBuffer.wrap(webBytes).order(ByteOrder.LITTLE_ENDIAN);
        assertEquals(348, b.getInt(0));
        assertEquals(3, b.getShort(40));
        assertEquals(COLS, b.getShort(42));
        assertEquals(ROWS, b.getShort(44));
        assertEquals(5, b.getShort(46));
        assertEquals(16, b.getShort(70));
        assertEquals(-1024f, b.getFloat(352), 0f);
        assertEquals(-1023f, b.getFloat(356), 0f);
        // k=1 の先頭画素 = 100-1024
        assertEquals(100f - 1024f, b.getFloat(352 + 4 * COLS * ROWS), 0f);

        Path jobDir = web.getParent();
        jobs.discard(id);
        assertNull(jobs.status(id), "受け取り後は取れない");
        assertTrue(Files.notExists(jobDir), "一時フォルダも消える");
        assertNull(jobs.niftiOf(id));
        s.standalone().discard(local.handle());
    }

    @Test
    void zip_endpoint_does_not_hand_out_a_nifti_job() throws Exception {
        setUp(new int[]{0, 1, 2}, "CT", "NO");
        String id = jobs.submitNifti(STUDY, SERIES).jobId();
        assertEquals(AnonymizeJobService.State.DONE, await(id).state());
        assertNull(jobs.zipOf(id), "NIfTI のジョブは ZIP として渡さない");
    }

    @Test
    void a_series_declared_burned_in_is_refused_and_nothing_is_kept() throws Exception {
        // 同じ形で BurnedInAnnotation だけ違う正例が通ることを先に確かめる（負例だけで安心しない）
        setUp(new int[]{0, 1, 2}, "CT", "NO");
        assertEquals(AnonymizeJobService.State.DONE, await(jobs.submitNifti(STUDY, SERIES).jobId()).state());
        jobs.shutdown();
        pacs.close();

        setUp(new int[]{0, 1, 2}, "CT", "YES");
        String id = jobs.submitNifti(STUDY, SERIES).jobId();
        AnonymizeJobService.Status st = await(id);
        assertEquals(AnonymizeJobService.State.FAILED, st.state());
        assertEquals("burnin-declared", st.reason());
        assertNull(jobs.niftiOf(id));
        assertTrue(isEmpty(dir.resolve("jobs")), "ファイルを残さない");
    }

    @Test
    void a_risky_modality_is_refused_even_for_simple_xray_like_local_would_allow() throws Exception {
        // web は外へ出る扱い: XA はマスク無しでは断る
        setUp(new int[]{0, 1, 2}, "XA", "NO");
        String id = jobs.submitNifti(STUDY, SERIES).jobId();
        AnonymizeJobService.Status st = await(id);
        assertEquals(AnonymizeJobService.State.FAILED, st.state());
        assertEquals("burnin-risky-modality", st.reason());
        assertNull(jobs.niftiOf(id));
    }

    @Test
    void a_missing_slice_is_refused_with_the_standalone_reason() throws Exception {
        setUp(new int[]{0, 1, 3, 4}, "CT", "NO"); // k=2 が欠け
        String id = jobs.submitNifti(STUDY, SERIES).jobId();
        AnonymizeJobService.Status st = await(id);
        assertEquals(AnonymizeJobService.State.FAILED, st.state());
        assertEquals("npz-uneven-spacing", st.reason());
        assertNull(jobs.niftiOf(id));
    }

    @Test
    void one_failed_fetch_fails_the_job_without_a_file() throws Exception {
        Setup s = setUp(new int[]{0, 1, 2}, "CT", "NO");
        pacs.failSop = "1.2.826.0.1.3680043.8.498.101";
        String id = jobs.submitNifti(STUDY, SERIES).jobId();
        AnonymizeJobService.Status st = await(id);
        assertEquals(AnonymizeJobService.State.FAILED, st.state());
        assertEquals("anonymize-failed", st.reason());
        assertNull(jobs.niftiOf(id));
        assertEquals(3, s.files().size());
    }

    @Test
    void unknown_series_is_series_not_found() throws Exception {
        setUp(new int[]{0, 1, 2}, "CT", "NO");
        String id = jobs.submitNifti(STUDY, "9.9.9").jobId();
        AnonymizeJobService.Status st = await(id);
        assertEquals(AnonymizeJobService.State.FAILED, st.state());
        assertEquals("series-not-found", st.reason());
    }

    @Test
    @SuppressWarnings("unchecked")
    void controller_job_endpoint_is_501_outside_web_and_202_in_web() throws Exception {
        Setup s = setUp(new int[]{0, 1, 2}, "CT", "NO");
        ObjectProvider<AnonymizeJobService> absent = Mockito.mock(ObjectProvider.class);
        Mockito.when(absent.getIfAvailable()).thenReturn(null);
        var standalone = new NiftiExportController(s.standalone(), absent);
        var ex = org.junit.jupiter.api.Assertions.assertThrows(NiftiExportController.Refusal.class,
                () -> standalone.exportJob(new NiftiExportController.ExportRequest(STUDY, SERIES)));
        assertEquals(HttpStatus.NOT_IMPLEMENTED, ex.status());

        ObjectProvider<AnonymizeJobService> present = Mockito.mock(ObjectProvider.class);
        Mockito.when(present.getIfAvailable()).thenReturn(jobs);
        var web = new NiftiExportController(s.datasets(), present);
        var res = web.exportJob(new NiftiExportController.ExportRequest(STUDY, SERIES));
        assertEquals(HttpStatus.ACCEPTED, res.getStatusCode());
        String id = res.getBody().jobId();
        assertEquals(AnonymizeJobService.State.DONE, await(id).state());

        var file = web.webFile(id);
        assertEquals("3", file.getHeaders().getFirst("X-Graphy-Slices"));
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        file.getBody().writeTo(out);
        byte[] raw = out.toByteArray();
        assertEquals((byte) 0x1f, raw[0]);
        assertEquals((byte) 0x8b, raw[1]); // gzip
        assertNull(jobs.status(id), "渡し終えるとジョブごと消える");
        var gone = org.junit.jupiter.api.Assertions.assertThrows(NiftiExportController.Refusal.class, () -> web.webFile(id));
        assertEquals(HttpStatus.NOT_FOUND, gone.status());
    }

    private static boolean isEmpty(Path p) throws IOException {
        if (!Files.exists(p)) {
            return true;
        }
        try (var st = Files.list(p)) {
            return st.findAny().isEmpty();
        }
    }
}

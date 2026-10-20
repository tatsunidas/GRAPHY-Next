/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** web の匿名化ジョブ（偽 PACS から取り、ZIP を作る）。 */
class AnonymizeJobTest {

    private static final String STUDY = "1.2.826.0.1.3680043.10.1338.1";
    private static final String[] SOPS = {
            "1.2.826.0.1.3680043.10.1338.11", "1.2.826.0.1.3680043.10.1338.12", "1.2.826.0.1.3680043.10.1338.13" };
    private static final String[] SERIES = { "1.2.826.0.1.3680043.10.1338.2", "1.2.826.0.1.3680043.10.1338.2",
            "1.2.826.0.1.3680043.10.1338.3" };

    @TempDir
    Path dir;

    private final Path[] files = new Path[3];
    private FakePacs pacs;
    private AnonymizeMaskStore sharedStore;
    private AnonymizeService svc;
    private final List<AnonymizeJobService> created = new ArrayList<>();

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() throws IOException {
        for (int i = 0; i < SOPS.length; i++) {
            files[i] = TestDicomFiles.writeUncompressed(dir.resolve("in" + i + ".dcm"), STUDY, SERIES[i], SOPS[i], 3,
                    100 + 10 * i);
        }
        pacs = new FakePacs(STUDY, SOPS, SERIES, files);
        sharedStore = new AnonymizeMaskStore();
        List<DicomInstance> insts = new ArrayList<>();
        for (int i = 0; i < SOPS.length; i++) {
            DicomInstance in = new DicomInstance(SOPS[i]);
            in.setUri(files[i].toUri().toString());
            in.setStudyInstanceUid(STUDY);
            in.setSeriesInstanceUid(SERIES[i]);
            in.setPatientId("P1");
            insts.add(in);
        }
        DicomInstanceRepository repo = Mockito.mock(DicomInstanceRepository.class);
        Mockito.when(repo.findByStudyInstanceUid(STUDY)).thenReturn(insts);
        ObjectProvider<WebDicomDataService> provider = Mockito.mock(ObjectProvider.class);
        Mockito.when(provider.getIfAvailable()).thenReturn(pacs.web);
        svc = new AnonymizeService(repo, sharedStore, provider, new PixelCodec(new DicomProperties()),
                new StorageLayout(Path.of("target", "no-storage-root")));
    }

    @AfterEach
    void tearDown() {
        created.forEach(AnonymizeJobService::shutdown);
        pacs.close();
    }

    private Path root() {
        return dir.resolve("jobs");
    }

    private AnonymizeJobService jobs(int maxJobs, long ttlMillis) {
        AnonymizeJobService s = new AnonymizeJobService(svc, pacs.web, root(), maxJobs, ttlMillis);
        created.add(s);
        return s;
    }

    private static AnonymizeConfig cfg(boolean burn) {
        AnonymizeConfig c = new AnonymizeConfig();
        c.addOption(AnonymizeConfig.Option.RetainUIDs);
        if (burn) {
            c.addOption(AnonymizeConfig.Option.CleanPixelData);
        }
        c.setRandomSeed(42L);
        c.setBurnDilatePx(0);
        return c;
    }

    private static AnonymizeJobService.Status await(AnonymizeJobService s, String id,
            AnonymizeJobService.State want) throws InterruptedException {
        AnonymizeJobService.Status st = null;
        for (int i = 0; i < 200; i++) {
            st = s.status(id);
            if (st != null && st.state() == want) {
                return st;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("状態 " + want + " にならない: " + st);
    }

    private static Map<String, byte[]> unzip(Path zip) throws IOException {
        Map<String, byte[]> out = new LinkedHashMap<>();
        try (ZipInputStream in = new ZipInputStream(Files.newInputStream(zip))) {
            ZipEntry e;
            while ((e = in.getNextEntry()) != null) {
                out.put(e.getName(), in.readAllBytes());
            }
        }
        return out;
    }

    private static AnonymizeMaskStore.SeriesMask mask(String series, List<String> sops) {
        AnonymizeMaskStore.MaskPolygon p = new AnonymizeMaskStore.MaskPolygon(
                new double[] { 0, 8, 8, 0 }, new double[] { 0, 0, 8, 8 }, sops, List.of());
        return new AnonymizeMaskStore.SeriesMask(series, List.of(), List.of(), List.of(p));
    }

    @Test
    void done_job_zip_matches_standalone_output_and_is_received_once() throws Exception {
        AnonymizeJobService s = jobs(4, 60_000);
        String id = s.submit(List.of(STUDY), cfg(false), false, Map.of()).jobId();
        AnonymizeJobService.Status st = await(s, id, AnonymizeJobService.State.DONE);
        assertEquals(3, st.total());
        assertEquals(3, st.processed());
        assertEquals(0, st.errorCount());

        Map<String, byte[]> web = unzip(s.zipOf(id));
        assertEquals(3, web.size());

        // 同じ設定の standalone（ローカルファイル）の出力と、1枚ずつ一致する
        List<DicomInstance> insts = new ArrayList<>();
        Map<String, Path> byUri = new LinkedHashMap<>();
        for (int i = 0; i < SOPS.length; i++) {
            DicomInstance in = new DicomInstance(SOPS[i]);
            in.setStudyInstanceUid(STUDY);
            in.setSeriesInstanceUid(SERIES[i]);
            in.setPatientId("P1");
            insts.add(in);
            byUri.put(SOPS[i], files[i]);
        }
        Map<String, byte[]> local = new LinkedHashMap<>();
        svc.anonymize(new LocalAnonymizeSource(insts, in -> byUri.get(in.getSopInstanceUid())), cfg(false), false,
                (ds, ts) -> {
                    ByteArrayOutputStream b = new ByteArrayOutputStream();
                    AnonymizeService.writeDicom(ds, ts, b);
                    local.put(ds.getString(org.dcm4che3.data.Tag.StudyInstanceUID) + "/"
                            + ds.getString(org.dcm4che3.data.Tag.SeriesInstanceUID) + "/"
                            + ds.getString(org.dcm4che3.data.Tag.SOPInstanceUID) + ".dcm", b.toByteArray());
                });
        assertEquals(local.keySet(), web.keySet());
        for (String k : local.keySet()) {
            assertArrayEquals(local.get(k), web.get(k), k);
        }

        Path jobDir = s.zipOf(id).getParent();
        s.discard(id);
        assertNull(s.status(id), "受け取り後は取れない");
        assertTrue(Files.notExists(jobDir), "一時フォルダも消える");
    }

    @Test
    void one_failed_fetch_fails_the_job_and_no_zip_is_kept() throws Exception {
        pacs.failSop = SOPS[1];
        AnonymizeJobService s = jobs(4, 60_000);
        String id = s.submit(List.of(STUDY), cfg(false), false, Map.of()).jobId();
        AnonymizeJobService.Status st = await(s, id, AnonymizeJobService.State.FAILED);
        assertEquals(1, st.errorCount());
        assertTrue(st.errors().get(0).contains(SOPS[1]), st.errors().toString());
        assertNull(s.zipOf(id), "失敗した結果の ZIP は渡さない");
        assertTrue(isEmpty(root()), "一時ファイルが残らない");
    }

    @Test
    void cancel_stops_a_running_job_and_removes_everything() throws Exception {
        pacs.gate = new CountDownLatch(1);
        AnonymizeJobService s = jobs(4, 60_000);
        String id = s.submit(List.of(STUDY), cfg(false), false, Map.of()).jobId();
        await(s, id, AnonymizeJobService.State.RUNNING);
        assertTrue(s.cancel(id));
        assertNull(s.status(id));
        pacs.gate.countDown();
        Thread.sleep(300);
        assertTrue(isEmpty(root()), "中止後に一時ファイルが残らない");
        assertTrue(!s.cancel(id), "もう無い");
    }

    @Test
    void jobs_beyond_the_limit_wait_in_the_queue() throws Exception {
        pacs.gate = new CountDownLatch(1);
        AnonymizeJobService s = jobs(1, 60_000);
        String a = s.submit(List.of(STUDY), cfg(false), false, Map.of()).jobId();
        String b = s.submit(List.of(STUDY), cfg(false), false, Map.of()).jobId();
        await(s, a, AnonymizeJobService.State.RUNNING);
        assertEquals(AnonymizeJobService.State.QUEUED, s.status(b).state(), "同時数の上限を超えた分は待つ");
        pacs.gate.countDown();
        await(s, a, AnonymizeJobService.State.DONE);
        await(s, b, AnonymizeJobService.State.DONE);
    }

    @Test
    void finished_job_expires_after_ttl() throws Exception {
        AnonymizeJobService s = jobs(4, 1_000);
        String id = s.submit(List.of(STUDY), cfg(false), false, Map.of()).jobId();
        await(s, id, AnonymizeJobService.State.DONE);
        s.sweep(System.currentTimeMillis());
        assertNotNull(s.status(id), "期限前は残る");
        s.sweep(System.currentTimeMillis() + 5_000);
        assertNull(s.status(id), "期限切れで消える");
        assertTrue(isEmpty(root()));
    }

    @Test
    void masks_are_per_job_and_never_touch_the_shared_store() throws Exception {
        AnonymizeJobService s = jobs(4, 60_000);
        String painted = s.submit(List.of(STUDY), cfg(true), true,
                Map.of(SERIES[0], mask(SERIES[0], List.of()), SERIES[2], mask(SERIES[2], List.of()))).jobId();
        String unmasked = s.submit(List.of(STUDY), cfg(true), true, Map.of()).jobId();
        AnonymizeJobService.Status a = await(s, painted, AnonymizeJobService.State.DONE);
        AnonymizeJobService.Status b = await(s, unmasked, AnonymizeJobService.State.DONE);
        assertEquals(3, a.burnedInstances(), "このジョブのマスクで3枚とも塗れる");
        assertEquals(0, b.burnedInstances(), "別のジョブのマスクは混ざらない");
        assertEquals(3, b.notBurnedInstances());
        assertTrue(sharedStore.get(SERIES[0]) == null && sharedStore.get(SERIES[2]) == null, "共有の表は空のまま");
    }

    @Test
    void a_mask_that_cannot_paint_an_image_fails_the_job() throws Exception {
        AnonymizeJobService s = jobs(4, 60_000);
        // 別の SOP にだけ適用されるマスク＝この画像には塗れない（standalone の事前検査と同じ判定）
        String id = s.submit(List.of(STUDY), cfg(true), true, Map.of(SERIES[2], mask(SERIES[2], List.of("9.9.9"))))
                .jobId();
        AnonymizeJobService.Status st = await(s, id, AnonymizeJobService.State.FAILED);
        assertTrue(st.errors().get(0).contains("焼き込めません"), st.errors().toString());
        assertNull(s.zipOf(id));
    }

    // ── web のマスク API は共有の表を使わない ──

    @Test
    void web_mask_api_is_closed() {
        AnonymizeController c = new AnonymizeController(svc, sharedStore);
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> c.registerMask(mask(SERIES[0], List.of())));
        assertEquals(HttpStatus.NOT_IMPLEMENTED, e.getStatusCode());
        assertThrows(ResponseStatusException.class, () -> c.clearMask(null));
        assertTrue(c.masks(SERIES[0]).isEmpty());
        assertTrue(sharedStore.get(SERIES[0]) == null);
    }

    private static boolean isEmpty(Path p) throws IOException {
        if (!Files.exists(p)) {
            return true;
        }
        try (Stream<Path> s = Files.list(p)) {
            return s.findAny().isEmpty();
        }
    }
}

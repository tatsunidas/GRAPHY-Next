/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** PACS への保存（STOW）: 応答の検査（問題 1）、STOW 出力のジョブ、取り込み許可。 */
class AnonymizeStowTest {

    private static final String STUDY = "1.2.826.0.1.3680043.10.1338.1";
    private static final String[] SOPS = {
            "1.2.826.0.1.3680043.10.1338.11", "1.2.826.0.1.3680043.10.1338.12", "1.2.826.0.1.3680043.10.1338.13" };
    private static final String[] SERIES = { "1.2.826.0.1.3680043.10.1338.2", "1.2.826.0.1.3680043.10.1338.2",
            "1.2.826.0.1.3680043.10.1338.3" };

    @TempDir
    Path dir;

    private FakePacs pacs;
    private AnonymizeService svc;
    private final List<AnonymizeJobService> created = new ArrayList<>();

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() throws IOException {
        Path[] files = new Path[3];
        for (int i = 0; i < SOPS.length; i++) {
            files[i] = TestDicomFiles.writeUncompressed(dir.resolve("in" + i + ".dcm"), STUDY, SERIES[i], SOPS[i], 3,
                    100 + 10 * i);
        }
        pacs = new FakePacs(STUDY, SOPS, SERIES, files);
        ObjectProvider<WebDicomDataService> provider = Mockito.mock(ObjectProvider.class);
        Mockito.when(provider.getIfAvailable()).thenReturn(pacs.web);
        svc = new AnonymizeService(Mockito.mock(DicomInstanceRepository.class), new AnonymizeMaskStore(), provider,
                new PixelCodec(new DicomProperties()), new StorageLayout(Path.of("target", "no-storage-root")));
    }

    @AfterEach
    void tearDown() {
        created.forEach(AnonymizeJobService::shutdown);
        pacs.close();
    }

    private AnonymizeJobService jobs() {
        AnonymizeJobService s = new AnonymizeJobService(svc, pacs.web, dir.resolve("jobs"), 4, 60_000);
        created.add(s);
        return s;
    }

    private static AnonymizeConfig cfg() {
        AnonymizeConfig c = new AnonymizeConfig();
        c.setRandomSeed(42L);
        return c;
    }

    private static AnonymizeJobService.Status awaitEnd(AnonymizeJobService s, String id) throws InterruptedException {
        AnonymizeJobService.Status st = null;
        for (int i = 0; i < 200; i++) {
            st = s.status(id);
            if (st != null && (st.state() == AnonymizeJobService.State.DONE
                    || st.state() == AnonymizeJobService.State.FAILED)) {
                return st;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("終わらない: " + st);
    }

    private static boolean isEmpty(Path p) throws IOException {
        if (!Files.exists(p)) {
            return true;
        }
        try (Stream<Path> s = Files.list(p)) {
            return s.findAny().isEmpty();
        }
    }

    private static List<Attributes> sample() {
        List<Attributes> l = new ArrayList<>();
        for (int i = 0; i < 2; i++) {
            Attributes a = new Attributes();
            a.setString(Tag.SOPClassUID, org.dcm4che3.data.VR.UI, "1.2.840.10008.5.1.4.1.1.7");
            a.setString(Tag.SOPInstanceUID, org.dcm4che3.data.VR.UI, "1.2.3." + i);
            l.add(a);
        }
        return l;
    }

    // ---- 問題 1: STOW 応答の検査 ----

    @Test
    void a_rejected_instance_in_the_stow_response_is_an_error() {
        pacs.rejectPost = 0;
        IllegalStateException e = assertThrows(IllegalStateException.class, () -> pacs.web.storeDatasets(sample()));
        assertTrue(e.getMessage().contains("9.9.9"), e.getMessage());
        assertEquals(2, pacs.stowParts.get(), "送ってはいる");
    }

    @Test
    void an_accepted_stow_passes() {
        pacs.web.storeDatasets(sample());
        assertEquals(1, pacs.stowPosts.get());
    }

    // ---- STOW 出力のジョブ ----

    @Test
    void stow_job_sends_all_anonymized_instances_and_keeps_no_files() throws Exception {
        AnonymizeJobService s = jobs();
        String id = s.submit(List.of(STUDY), cfg(), false, Map.of(), true).jobId();
        AnonymizeJobService.Status st = awaitEnd(s, id);
        assertEquals(AnonymizeJobService.State.DONE, st.state(), st.toString());
        assertEquals("stow", st.output());
        assertEquals(3, st.stored());
        assertEquals(3, pacs.stowParts.get());
        assertNull(s.zipOf(id), "STOW のジョブに ZIP は無い");
        s.discard(id);
        assertTrue(isEmpty(dir.resolve("jobs")), "一時ファイルが残らない");
    }

    @Test
    void stow_job_sends_nothing_when_an_image_cannot_be_anonymized() throws Exception {
        pacs.failSop = SOPS[1];
        AnonymizeJobService s = jobs();
        String id = s.submit(List.of(STUDY), cfg(), false, Map.of(), true).jobId();
        AnonymizeJobService.Status st = awaitEnd(s, id);
        assertEquals(AnonymizeJobService.State.FAILED, st.state());
        assertEquals(0, pacs.stowPosts.get(), "1 枚でも失敗したら PACS には何も送らない");
        assertEquals(0, st.stored());
    }

    @Test
    void stow_job_reports_how_many_were_stored_when_a_later_batch_is_rejected() throws Exception {
        pacs.rejectPost = 1; // 2 回目の POST
        AnonymizeJobService s = jobs();
        s.stowBatch = 2;
        String id = s.submit(List.of(STUDY), cfg(), false, Map.of(), true).jobId();
        AnonymizeJobService.Status st = awaitEnd(s, id);
        assertEquals(AnonymizeJobService.State.FAILED, st.state());
        assertEquals(2, st.stored(), "最初のバッチ 2 枚は保存済み（取り消せない）");
        assertTrue(st.error().contains("保存済み 2 枚"), st.error());
        assertEquals(2, pacs.stowPosts.get(), "拒否されたバッチで止まる");
    }

    // ---- 取り込み許可・検査 ----

    private static AnonymizeJobController.JobRequest req(String output, List<String> options) {
        return new AnonymizeJobController.JobRequest(List.of(STUDY), options, null, null, 7L, null, null, false,
                output, null);
    }

    private static HttpStatus statusOf(ResponseStatusException e) {
        return HttpStatus.valueOf(e.getStatusCode().value());
    }

    @Test
    void stow_is_forbidden_unless_import_is_enabled() {
        AnonymizeJobController off = new AnonymizeJobController(jobs(), false);
        assertEquals(HttpStatus.FORBIDDEN,
                statusOf(assertThrows(ResponseStatusException.class, () -> off.submit(req("stow", List.of())))));
        assertEquals(false, off.config().importEnabled());
        AnonymizeJobController on = new AnonymizeJobController(jobs(), true);
        assertEquals(true, on.config().importEnabled());
        assertEquals("stow", on.submit(req("stow", List.of())).output());
    }

    @Test
    void stow_with_retained_uids_is_refused() {
        AnonymizeJobController on = new AnonymizeJobController(jobs(), true);
        assertEquals(HttpStatus.BAD_REQUEST, statusOf(assertThrows(ResponseStatusException.class,
                () -> on.submit(req("stow", List.of("RetainUIDs"))))));
        assertEquals(0, pacs.stowPosts.get());
    }

    @Test
    void zip_is_always_allowed() {
        AnonymizeJobController off = new AnonymizeJobController(jobs(), false);
        assertEquals("zip", off.submit(req("zip", List.of())).output());
    }
}

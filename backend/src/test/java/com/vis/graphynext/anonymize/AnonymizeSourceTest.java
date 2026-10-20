/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.sun.net.httpserver.HttpServer;
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
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 匿名化の読み元（standalone のローカルファイル / web の PACS）を差し替えても、出力が同じであること。
 * PACS は JDK の HttpServer で立てた偽物（QIDO-RS / WADO-RS）。
 */
class AnonymizeSourceTest {

    private static final String STUDY = "1.2.826.0.1.3680043.10.1338.1";
    private static final String[] SERIES = { "1.2.826.0.1.3680043.10.1338.2", "1.2.826.0.1.3680043.10.1338.3" };
    private static final String[] SOPS = {
            "1.2.826.0.1.3680043.10.1338.11", "1.2.826.0.1.3680043.10.1338.12", "1.2.826.0.1.3680043.10.1338.13" };
    /** SOPS[i] の所属シリーズ（2 シリーズ・3 枚）。 */
    private static final String[] SOP_SERIES = { SERIES[0], SERIES[0], SERIES[1] };
    private static final int FRAMES = 3;

    @TempDir
    Path dir;

    private final Path[] files = new Path[3];
    private HttpServer server;
    private final AtomicInteger wadoHits = new AtomicInteger();
    private volatile String failSop;
    private WebDicomDataService web;

    @BeforeEach
    void setUp() throws IOException {
        for (int i = 0; i < SOPS.length; i++) {
            files[i] = TestDicomFiles.writeUncompressed(dir.resolve("in" + i + ".dcm"), STUDY, SOP_SERIES[i], SOPS[i],
                    FRAMES, 100 + 10 * i);
        }
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/studies", ex -> {
            String path = ex.getRequestURI().getPath();
            String q = ex.getRequestURI().getQuery();
            if (path.equals("/studies")) {
                json(ex, "[{\"0020000D\":{\"vr\":\"UI\",\"Value\":[\"" + STUDY + "\"]},"
                        + "\"00100020\":{\"vr\":\"LO\",\"Value\":[\"P1\"]}}]");
            } else if (path.equals("/studies/" + STUDY + "/instances")) {
                StringBuilder sb = new StringBuilder("[");
                for (int i = 0; i < SOPS.length; i++) {
                    sb.append(i == 0 ? "" : ",").append("{\"00080018\":{\"vr\":\"UI\",\"Value\":[\"").append(SOPS[i])
                            .append("\"]},\"0020000E\":{\"vr\":\"UI\",\"Value\":[\"").append(SOP_SERIES[i])
                            .append("\"]}}");
                }
                json(ex, sb.append("]").toString());
            } else if (path.contains("/instances/")) {
                wadoHits.incrementAndGet();
                String sop = path.substring(path.lastIndexOf('/') + 1);
                int idx = List.of(SOPS).indexOf(sop);
                if (idx < 0 || sop.equals(failSop)) {
                    ex.sendResponseHeaders(500, -1);
                    ex.close();
                    return;
                }
                byte[] part = Files.readAllBytes(files[idx]);
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                bos.write("--b\r\nContent-Type: application/dicom\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                bos.write(part);
                bos.write("\r\n--b--\r\n".getBytes(StandardCharsets.US_ASCII));
                byte[] body = bos.toByteArray();
                ex.getResponseHeaders().add("Content-Type", "multipart/related; type=\"application/dicom\"; boundary=b");
                ex.sendResponseHeaders(200, body.length);
                try (var os = ex.getResponseBody()) {
                    os.write(body);
                }
            } else {
                ex.sendResponseHeaders(404, -1);
                ex.close();
            }
        });
        server.start();
        DicomProperties props = new DicomProperties();
        props.getDicomweb().setBaseUrl("http://127.0.0.1:" + server.getAddress().getPort());
        web = new WebDicomDataService(props);
    }

    @AfterEach
    void tearDown() {
        server.stop(0);
    }

    private static void json(com.sun.net.httpserver.HttpExchange ex, String s) throws IOException {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/dicom+json");
        ex.sendResponseHeaders(200, b.length);
        try (var os = ex.getResponseBody()) {
            os.write(b);
        }
    }

    @SuppressWarnings("unchecked")
    private AnonymizeService localService(AnonymizeMaskStore masks) {
        List<DicomInstance> insts = new ArrayList<>();
        for (int i = 0; i < SOPS.length; i++) {
            DicomInstance in = new DicomInstance(SOPS[i]);
            in.setUri(files[i].toUri().toString());
            in.setStudyInstanceUid(STUDY);
            in.setSeriesInstanceUid(SOP_SERIES[i]);
            in.setPatientId("P1");
            insts.add(in);
        }
        DicomInstanceRepository repo = Mockito.mock(DicomInstanceRepository.class);
        Mockito.when(repo.findByStudyInstanceUid(STUDY)).thenReturn(insts);
        ObjectProvider<WebDicomDataService> provider = Mockito.mock(ObjectProvider.class);
        Mockito.when(provider.getIfAvailable()).thenReturn(null);
        return new AnonymizeService(repo, masks, provider, new PixelCodec(new DicomProperties()),
                new StorageLayout(Path.of("target", "no-storage-root")));
    }

    private static AnonymizeConfig cfg(boolean burn) {
        AnonymizeConfig c = new AnonymizeConfig();
        c.addOption(AnonymizeConfig.Option.RetainUIDs); // SOP UID をそろえて、対応する 1 枚どうしを比べる
        if (burn) {
            c.addOption(AnonymizeConfig.Option.CleanPixelData);
        }
        c.setRandomSeed(42L);
        c.setBurnDilatePx(0);
        return c;
    }

    private static Map<String, byte[]> collect(AnonymizeService svc, AnonymizeSource src, AnonymizeConfig cfg,
            boolean burn, AnonymizeService.Result[] out) {
        Map<String, byte[]> bySop = new LinkedHashMap<>();
        AnonymizeService.Sink sink = (ds, ts) -> {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            AnonymizeService.writeDicom(ds, ts, b);
            bySop.put(ds.getString(org.dcm4che3.data.Tag.SOPInstanceUID), b.toByteArray());
        };
        out[0] = svc.anonymize(src, cfg, burn, sink);
        return bySop;
    }

    private static AnonymizeMaskStore maskForFirstSeries() {
        AnonymizeMaskStore store = new AnonymizeMaskStore();
        AnonymizeMaskStore.MaskPolygon p = new AnonymizeMaskStore.MaskPolygon(
                new double[] { 0, 8, 8, 0 }, new double[] { 0, 0, 8, 8 }, List.of(), List.of());
        store.put(new AnonymizeMaskStore.SeriesMask(SERIES[0], List.of(), List.of(), List.of(p)));
        return store;
    }

    private Path tempDir() {
        return dir.resolve("web-tmp");
    }

    @Test
    void web_and_local_produce_identical_output() throws Exception {
        for (boolean burn : new boolean[] { false, true }) {
            AnonymizeMaskStore masks = maskForFirstSeries();
            AnonymizeService svc = localService(masks);
            // 同じ AnonymizeService に Local / Web の読み元を渡して比べる（読み元以外は同一）
            AnonymizeService.Result[] rl = new AnonymizeService.Result[1];
            AnonymizeService.Result[] rw = new AnonymizeService.Result[1];
            Map<String, byte[]> local = collect(svc, localSource(), cfg(burn), burn, rl);
            Map<String, byte[]> webOut = collect(svc, new WebAnonymizeSource(web, List.of(STUDY), tempDir()), cfg(burn),
                    burn, rw);

            assertEquals(0, rl[0].errors().size(), rl[0].errors().toString());
            assertEquals(0, rw[0].errors().size(), rw[0].errors().toString());
            assertEquals(3, local.size());
            assertEquals(local.keySet(), webOut.keySet());
            for (String sop : local.keySet()) {
                assertArrayEquals(local.get(sop), webOut.get(sop), "burn=" + burn + " sop=" + sop);
            }
            if (burn) {
                assertEquals(2, rw[0].burnedInstances(), "マスクのあるシリーズ（2 枚）だけ塗れる");
                assertEquals(1, rw[0].notBurnedInstances());
            }
            assertTrue(isEmpty(tempDir()), "web の一時ファイルが残っていない");
        }
    }

    /** ローカルの読み元（standalone と同じ経路）。 */
    private AnonymizeSource localSource() {
        List<DicomInstance> insts = new ArrayList<>();
        Map<String, Path> byUri = new LinkedHashMap<>();
        for (int i = 0; i < SOPS.length; i++) {
            DicomInstance in = new DicomInstance(SOPS[i]);
            in.setStudyInstanceUid(STUDY);
            in.setSeriesInstanceUid(SOP_SERIES[i]);
            in.setPatientId("P1");
            in.setUri(files[i].toUri().toString());
            insts.add(in);
            byUri.put(SOPS[i], files[i]);
        }
        return new LocalAnonymizeSource(insts, in -> byUri.get(in.getSopInstanceUid()));
    }

    @Test
    void one_failed_fetch_is_reported_and_leaves_no_temp_files() throws Exception {
        failSop = SOPS[1];
        AnonymizeService svc = localService(new AnonymizeMaskStore());
        AnonymizeService.Result[] r = new AnonymizeService.Result[1];
        Map<String, byte[]> out = collect(svc, new WebAnonymizeSource(web, List.of(STUDY), tempDir()), cfg(false),
                false, r);
        assertEquals(1, r[0].errors().size(), r[0].errors().toString());
        assertTrue(r[0].errors().get(0).contains(SOPS[1]), r[0].errors().get(0));
        assertEquals(2, out.size());
        assertEquals(Set.of(SOPS[0], SOPS[2]), out.keySet());
        assertTrue(isEmpty(tempDir()), "失敗があっても一時ファイルは消える");
    }

    @Test
    void fetchInstanceUncached_does_not_use_the_viewer_cache() {
        web.fetchInstanceUncached(STUDY, SOP_SERIES[0], SOPS[0]);
        web.fetchInstanceUncached(STUDY, SOP_SERIES[0], SOPS[0]);
        assertEquals(2, wadoHits.get(), "キャッシュを読まない（2 回とも PACS へ取りに行く）");
        web.retrieveInstance(STUDY, SOP_SERIES[0], SOPS[0]);
        assertEquals(3, wadoHits.get(), "uncached の取得はキャッシュに入れていない");
        web.retrieveInstance(STUDY, SOP_SERIES[0], SOPS[0]);
        assertEquals(3, wadoHits.get(), "対照: 従来の取得はキャッシュから返る");
    }

    @Test
    void fetchInstanceUncached_throws_on_failure() {
        failSop = SOPS[0];
        assertThrows(RuntimeException.class, () -> web.fetchInstanceUncached(STUDY, SOP_SERIES[0], SOPS[0]));
    }

    // ── 問題 2: standalone の ZIP は、1 枚でも匿名化できなければ渡さない ──

    @Test
    void zip_with_an_unreadable_image_is_refused_not_silently_truncated() throws Exception {
        Files.writeString(files[1], "not a dicom file"); // 索引にはあるが読めない
        AnonymizeService svc = localService(new AnonymizeMaskStore());
        AnonymizeController c = new AnonymizeController(svc, new AnonymizeMaskStore());
        ResponseStatusException e = assertThrows(ResponseStatusException.class, () -> c.zip(request()));
        assertEquals(HttpStatus.CONFLICT, e.getStatusCode());
        assertTrue(e.getReason().contains(SOPS[1]), e.getReason());
    }

    @Test
    void zip_with_all_images_readable_contains_all_of_them() throws Exception {
        AnonymizeService svc = localService(new AnonymizeMaskStore());
        AnonymizeController c = new AnonymizeController(svc, new AnonymizeMaskStore());
        var resp = c.zip(request());
        assertEquals(200, resp.getStatusCode().value());
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        resp.getBody().writeTo(bos);
        int entries = 0;
        try (ZipInputStream zin = new ZipInputStream(new java.io.ByteArrayInputStream(bos.toByteArray()))) {
            while (zin.getNextEntry() != null) {
                entries++;
            }
        }
        assertEquals(3, entries);
    }

    private static AnonymizeController.AnonRequest request() {
        return new AnonymizeController.AnonRequest(List.of(STUDY), List.of("RetainUIDs"), null, null, 42L, null, null,
                false, null);
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

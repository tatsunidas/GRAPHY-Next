/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.UID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:pathjobit;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class PathImportJobTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    ImportService importService;
    @Autowired
    DicomStorageService storage;

    /** {@code limit} 回目の問い合わせから「中止された」と答える（件数ごとの判定が効いているかを決定的に試す）。 */
    private static final class CancelAfterChecks extends ImportService.Progress {
        private final int limit;
        private final AtomicInteger calls = new AtomicInteger();

        CancelAfterChecks(int limit) {
            this.limit = limit;
        }

        @Override
        public boolean isCancelled() {
            return calls.incrementAndGet() > limit;
        }
    }

    private Path folderOf(String name, int n, String study) throws IOException {
        Path dir = Files.createDirectories(tmp.resolve(name));
        for (int i = 0; i < n; i++) {
            Attributes ds = DicomPhantomFactory.scImage("PJ", study, study + ".ser", study + "." + i);
            DicomPhantomFactory.writeFile(dir.resolve("f" + i + ".dcm"), ds, UID.ExplicitVRLittleEndian);
        }
        Files.writeString(dir.resolve("note.txt"), "x");
        return dir;
    }

    private Path zipOf(String name, int n, String study) throws IOException {
        Path w = Files.createDirectories(tmp.resolve(name + "-w"));
        Path z = tmp.resolve(name);
        try (OutputStream o = Files.newOutputStream(z); ZipOutputStream zo = new ZipOutputStream(o)) {
            zo.putNextEntry(new ZipEntry("S/")); // ディレクトリエントリは数えない
            zo.closeEntry();
            for (int i = 0; i < n; i++) {
                Attributes ds = DicomPhantomFactory.scImage("PJ", study, study + ".ser", study + "." + i);
                byte[] b = Files.readAllBytes(DicomPhantomFactory.writeFile(w.resolve("f" + i), ds, UID.ExplicitVRLittleEndian));
                zo.putNextEntry(new ZipEntry("S/f" + i + ".dcm"));
                zo.write(b);
                zo.closeEntry();
            }
        }
        return z;
    }

    private long importTempFiles() throws IOException {
        Path d = storage.importTempDir();
        if (!Files.isDirectory(d)) {
            return 0;
        }
        try (Stream<Path> s = Files.list(d)) {
            return s.count();
        }
    }

    private PathImportJobService.Status await(PathImportJobService svc, String id) throws Exception {
        long end = System.currentTimeMillis() + 60_000;
        while (System.currentTimeMillis() < end) {
            PathImportJobService.Status s = svc.get(id);
            if (s.state() == PathImportJobService.State.DONE || s.state() == PathImportJobService.State.CANCELLED
                    || s.state() == PathImportJobService.State.FAILED) {
                return s;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("ジョブが終わりません: " + svc.get(id));
    }

    @Test
    void countFiles_foldersCountFiles_zipsCountEntriesWithoutDirectories() throws Exception {
        Path dir = folderOf("c-folder", 5, "1.2.pj.c1"); // 5 DICOM + 1 txt
        Path z = zipOf("c.zip", 4, "1.2.pj.c2"); // 4 エントリ（ディレクトリ除く）
        assertEquals(6, importService.countFiles(List.of(dir.toString()), new ImportService.Progress()));
        assertEquals(4, importService.countFiles(List.of(z.toString()), new ImportService.Progress()));
        assertEquals(10, importService.countFiles(List.of(dir.toString(), z.toString()), new ImportService.Progress()));
    }

    @Test
    void job_folderAndZip_reportTotalAndProcessedThatMeet() throws Exception {
        Path dir = folderOf("j-folder", 6, "1.2.pj.j1");
        Path z = zipOf("j.zip", 5, "1.2.pj.j2");
        PathImportJobService svc = new PathImportJobService(importService);

        PathImportJobService.Status s = await(svc, svc.submit(List.of(dir.toString(), z.toString())).jobId());

        assertEquals(PathImportJobService.State.DONE, s.state(), String.valueOf(s.error()));
        assertEquals(12, s.total()); // 6 + 1 txt + 5
        assertEquals(s.total(), s.processed(), "終わったら処理数が総数に届く");
        assertEquals(11, s.imported());
        assertEquals(1, s.skipped());
        assertEquals(0, s.failed());
        assertNotNull(s.result());
        assertEquals(11, s.result().imported());
        assertEquals(0, importTempFiles());
    }

    @Test
    void cancel_folder_stopsBetweenFiles_keepsImported() throws Exception {
        Path dir = folderOf("x-folder", 20, "1.2.pj.x1");
        ImportService.Progress p = new CancelAfterChecks(9); // 1 件につき 2 回問い合わせるので 4 件ほどで止まる

        ImportService.ImportResult r = importService.importPaths(List.of(dir.toString()), p);

        assertTrue(r.imported() >= 1 && r.imported() < 20, "途中で止まる: " + r.imported());
        assertEquals(r.imported(), storage.findMatches(null, "1.2.pj.x1", null, null).size(), "取り込んだ分は残る");
        assertEquals(r.imported(), p.imported());
        assertEquals(0, importTempFiles());
    }

    @Test
    void cancel_zip_stopsBetweenEntries() throws Exception {
        Path z = zipOf("x.zip", 20, "1.2.pj.x2");
        ImportService.Progress p = new CancelAfterChecks(5);

        ImportService.ImportResult r = importService.importPaths(List.of(z.toString()), p);

        assertTrue(r.imported() >= 1 && r.imported() < 20, "途中で止まる: " + r.imported());
        assertEquals(r.imported(), storage.findMatches(null, "1.2.pj.x2", null, null).size());
        assertEquals(0, importTempFiles());
    }

    @Test
    void notCancelled_importsEverything_negativeControl() throws Exception {
        Path z = zipOf("n.zip", 20, "1.2.pj.n1");
        ImportService.ImportResult r = importService.importPaths(List.of(z.toString()), new ImportService.Progress());
        assertEquals(20, r.imported(), "中止しなければ全部入る（上の中止テストが効いている裏づけ）");
    }

    @Test
    void job_cancelBeforeRun_importsNothing_stateCancelled() throws Exception {
        Path z = zipOf("pre.zip", 10, "1.2.pj.p1");
        PathImportJobService svc = new PathImportJobService(importService);
        // 先行ジョブで worker を塞がなくても、投入直後の中止が QUEUED/SCANNING のうちに効くよう、
        // 大きめの先行ジョブを 1 つ流してから 2 つ目を中止する。
        PathImportJobService.Status first = svc.submit(List.of(zipOf("pre-first.zip", 30, "1.2.pj.p0").toString()));
        PathImportJobService.Status second = svc.submit(List.of(z.toString()));
        svc.cancel(second.jobId());

        PathImportJobService.Status s2 = await(svc, second.jobId());
        PathImportJobService.Status s1 = await(svc, first.jobId());

        assertEquals(PathImportJobService.State.CANCELLED, s2.state());
        assertEquals(0, s2.imported());
        assertEquals(0, storage.findMatches(null, "1.2.pj.p1", null, null).size());
        assertEquals(PathImportJobService.State.DONE, s1.state(), "先行ジョブは影響を受けない");
        assertEquals(30, s1.imported());
    }

    @Test
    void job_unknownId_isNull_andCancelIsIdempotent() throws Exception {
        PathImportJobService svc = new PathImportJobService(importService);
        assertEquals(null, svc.get("nope"));
        assertEquals(null, svc.cancel("nope"));
        Path z = zipOf("idem.zip", 2, "1.2.pj.i1");
        PathImportJobService.Status s = await(svc, svc.submit(List.of(z.toString())).jobId());
        assertEquals(PathImportJobService.State.DONE, svc.cancel(s.jobId()).state(), "終わったジョブの中止は何も変えない");
    }
}

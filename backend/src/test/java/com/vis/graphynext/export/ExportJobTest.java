/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.importer.ImportService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.UID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:exportjobit;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class ExportJobTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    ImportService importService;
    @Autowired
    ExportService exportService;

    private static final class CancelAfterChecks extends ExportService.Progress {
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

    /** 1 患者・1 シリーズ・n 画像を取り込み、選択を返す。 */
    private List<ExportService.Selection> seed(String pid, String study, int n) throws IOException {
        Path dir = Files.createDirectories(tmp.resolve("src-" + study));
        String series = study + ".ser";
        for (int i = 0; i < n; i++) {
            Attributes ds = DicomPhantomFactory.scImage(pid, study, series, study + "." + i);
            DicomPhantomFactory.writeFile(dir.resolve("f" + i + ".dcm"), ds, UID.ExplicitVRLittleEndian);
        }
        importService.importPaths(List.of(dir.toString()));
        return List.of(new ExportService.Selection(study, List.of(series)));
    }

    private static Set<String> listRelative(Path root) throws IOException {
        try (Stream<Path> s = Files.walk(root)) {
            Set<String> out = new TreeSet<>();
            s.filter(Files::isRegularFile).forEach(p -> out.add(root.relativize(p).toString().replace('\\', '/')));
            return out;
        }
    }

    private static Set<String> listZip(Path zip) throws IOException {
        Set<String> out = new TreeSet<>();
        try (ZipFile z = new ZipFile(zip.toFile())) {
            z.stream().filter(e -> !e.isDirectory()).map(ZipEntry::getName).forEach(out::add);
        }
        return out;
    }

    private ExportJobService.Status await(ExportJobService svc, String id) throws Exception {
        long end = System.currentTimeMillis() + 60_000;
        while (System.currentTimeMillis() < end) {
            ExportJobService.Status s = svc.get(id);
            if (s.state() == ExportJobService.State.DONE || s.state() == ExportJobService.State.CANCELLED
                    || s.state() == ExportJobService.State.FAILED) {
                return s;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("ジョブが終わりません: " + svc.get(id));
    }

    @Test
    void folderAndZip_haveSameContents_namedByPatientId() throws Exception {
        List<ExportService.Selection> sel = seed("EXP-1", "1.2.ex.a", 5);
        Path dest = Files.createDirectories(tmp.resolve("dest-a"));
        ExportJobService svc = new ExportJobService(exportService);

        ExportJobService.Status f = await(svc, svc.submit(sel, false, false, dest.toString()).jobId());
        ExportJobService.Status z = await(svc, svc.submit(sel, false, true, dest.toString()).jobId());

        assertEquals(ExportJobService.State.DONE, f.state(), String.valueOf(f.error()));
        assertEquals(ExportJobService.State.DONE, z.state(), String.valueOf(z.error()));
        assertEquals(dest.resolve("EXP-1").toString(), f.outputPath(), "単一患者のフォルダ名は患者 ID");
        assertEquals(dest.resolve("EXP-1.zip").toString(), z.outputPath());
        Set<String> inFolder = listRelative(dest.resolve("EXP-1"));
        assertEquals(5, inFolder.size(), "Viewer なしは DICOM だけ: " + inFolder);
        assertTrue(inFolder.stream().allMatch(p -> p.startsWith("DICOM/")));
        assertEquals(inFolder, listZip(dest.resolve("EXP-1.zip")), "ZIP の中身はフォルダと同じ");
        assertEquals(f.total(), f.processed());
        assertEquals(5, f.total());
    }

    @Test
    void viewerOn_addsDicomDirAndReadmeAndViewer_andSecondRunDoesNotOverwrite() throws Exception {
        List<ExportService.Selection> sel = seed("EXP-2", "1.2.ex.b", 3);
        Path dest = Files.createDirectories(tmp.resolve("dest-b"));
        ExportJobService svc = new ExportJobService(exportService);

        ExportJobService.Status a = await(svc, svc.submit(sel, true, false, dest.toString()).jobId());
        ExportJobService.Status b = await(svc, svc.submit(sel, true, false, dest.toString()).jobId());

        Set<String> files = listRelative(dest.resolve("EXP-2"));
        assertTrue(files.contains("DICOMDIR"), files.toString());
        assertTrue(files.contains("README.txt"), files.toString());
        assertTrue(files.stream().anyMatch(p -> p.startsWith("VIEWER/")), files.toString());
        assertEquals(dest.resolve("EXP-2 (2)").toString(), b.outputPath(), "同名があれば (2)");
        assertEquals(ExportJobService.State.DONE, a.state());
    }

    @Test
    void multiplePatients_keepLegacyName() throws Exception {
        List<ExportService.Selection> s1 = seed("EXP-3", "1.2.ex.c", 2);
        List<ExportService.Selection> s2 = seed("EXP-4", "1.2.ex.d", 2);
        Path dest = Files.createDirectories(tmp.resolve("dest-c"));
        ExportJobService svc = new ExportJobService(exportService);

        ExportJobService.Status s = await(svc, svc.submit(List.of(s1.get(0), s2.get(0)), false, false, dest.toString()).jobId());

        assertEquals(dest.resolve("graphy-export_EXP-3_+1").toString(), s.outputPath());
    }

    @Test
    void cancel_removesPartialOutput_andNegativeControlCompletes() throws Exception {
        List<ExportService.Selection> sel = seed("EXP-5", "1.2.ex.e", 20);
        Path dest = Files.createDirectories(tmp.resolve("dest-d"));

        // 中止: 書きかけのフォルダ／ZIP を残さない
        for (boolean zip : new boolean[]{false, true}) {
            Path out = dest.resolve(zip ? "x.zip" : "x");
            ExportService.Progress p = new CancelAfterChecks(5);
            assertThrows(ExportService.CancelledException.class, () -> {
                try (ExportService.Sink sink = zip
                        ? new ExportService.ZipSink(new java.util.zip.ZipOutputStream(Files.newOutputStream(out)))
                        : new ExportService.DirSink(out)) {
                    exportService.write(sel, ExportService.Options.forViewer(false), sink, p);
                }
            });
            assertTrue(p.processed() >= 1 && p.processed() < 20, "途中で止まる: " + p.processed());
        }

        // ジョブ経由: 投入直後の中止で出力が残らない
        ExportJobService svc = new ExportJobService(exportService);
        ExportJobService.Status first = svc.submit(sel, false, false, dest.toString());
        ExportJobService.Status second = svc.submit(sel, false, true, dest.toString());
        svc.cancel(second.jobId());
        ExportJobService.Status s2 = await(svc, second.jobId());
        await(svc, first.jobId());
        assertEquals(ExportJobService.State.CANCELLED, s2.state());
        assertFalse(Files.exists(dest.resolve("EXP-5.zip")), "中止したジョブの ZIP は残らない");

        // 負例: 中止しなければ最後まで書ける（上の中止テストが効いている裏づけ）
        Path ok = dest.resolve("ok");
        ExportService.Progress p = new ExportService.Progress();
        try (ExportService.Sink sink = new ExportService.DirSink(ok)) {
            exportService.write(sel, ExportService.Options.forViewer(false), sink, p);
        }
        assertEquals(20, listRelative(ok).size());
    }

    @Test
    void submit_rejectsMissingDestination() {
        ExportJobService svc = new ExportJobService(exportService);
        assertThrows(IllegalArgumentException.class,
                () -> svc.submit(List.of(new ExportService.Selection("s", List.of("x"))), false, false, tmp.resolve("nope").toString()));
        assertThrows(IllegalArgumentException.class,
                () -> svc.submit(List.of(new ExportService.Selection("s", List.of("x"))), false, false, ""));
    }

    @Test
    void dirSink_rejectsEscapingNames() throws Exception {
        try (ExportService.DirSink sink = new ExportService.DirSink(tmp.resolve("sink"))) {
            assertThrows(IOException.class, () -> sink.put("../evil.txt", new byte[]{1}));
        }
    }
}

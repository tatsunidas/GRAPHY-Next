/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomInstance;
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
import java.nio.file.attribute.FileTime;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:zipimportit;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class ZipImportTest {

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

    private static class Rec implements ZipDicomImporter.Sink {
        int imported;
        int skipped;
        final List<String> failed = new ArrayList<>();
        int cancelAfterImported = -1;

        @Override
        public boolean cancelled() {
            return cancelAfterImported >= 0 && imported >= cancelAfterImported;
        }

        @Override
        public void imported(DicomInstance saved) {
            imported++;
        }

        @Override
        public void skipped() {
            skipped++;
        }

        @Override
        public void failed(String what, Exception e) {
            failed.add(what + ": " + e.getMessage());
        }
    }

    private interface ZipWriter {
        void write(ZipOutputStream z) throws IOException;
    }

    private static byte[] dcm(Path dir, String name, String study, String sop) throws IOException {
        Attributes ds = DicomPhantomFactory.scImage("ZP", study, study + ".ser", sop);
        return Files.readAllBytes(DicomPhantomFactory.writeFile(dir.resolve(name), ds, UID.ExplicitVRLittleEndian));
    }

    private static void entry(ZipOutputStream z, String name, byte[] data) throws IOException {
        z.putNextEntry(new ZipEntry(name));
        z.write(data);
        z.closeEntry();
    }

    private Path zip(String name, ZipWriter w) throws IOException {
        Path p = tmp.resolve(name);
        try (OutputStream o = Files.newOutputStream(p); ZipOutputStream z = new ZipOutputStream(o)) {
            w.write(z);
        }
        return p;
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

    @Test
    void zipDroppedAsPath_importsNestedDicom_skipsNonDicom_keepsZip_noTempLeft() throws Exception {
        Path w = Files.createDirectories(tmp.resolve("w1"));
        byte[] a = dcm(w, "a.dcm", "1.2.zip.s1", "1.2.zip.s1.a");
        byte[] b = dcm(w, "b.dcm", "1.2.zip.s1", "1.2.zip.s1.b");
        Path z = zip("ok.zip", o -> {
            entry(o, "P01/ST01/SE01/IM000001", a); // 拡張子なし
            entry(o, "P01/ST01/SE01/IM000002.dcm", b);
            entry(o, "readme.txt", "x".getBytes());
            entry(o, "__MACOSX/._IM000001", "x".getBytes());
        });
        long size = Files.size(z);

        ImportService.ImportResult r = importService.importPaths(List.of(z.toString()));

        assertEquals(2, r.imported());
        assertEquals(2, r.skipped());
        assertEquals(0, r.failed(), r.errors().toString());
        assertEquals(List.of("1.2.zip.s1"), r.studyInstanceUids());
        assertEquals(2, storage.findMatches(null, "1.2.zip.s1", null, null).size());
        assertTrue(Files.exists(z));
        assertEquals(size, Files.size(z), "元の ZIP は変わらない");
        assertEquals(0, importTempFiles(), ".import に一時ファイルが残らない");
    }

    @Test
    void unsafeEntryName_isFailed_othersStillImported() throws Exception {
        Path w = Files.createDirectories(tmp.resolve("w2"));
        byte[] a = dcm(w, "a.dcm", "1.2.zip.s2", "1.2.zip.s2.a");
        byte[] b = dcm(w, "b.dcm", "1.2.zip.s2", "1.2.zip.s2.b");
        Path z = zip("slip.zip", o -> {
            entry(o, "../evil.dcm", a);
            entry(o, "C:/evil2.dcm", a);
            entry(o, "good.dcm", b);
        });
        Rec rec = new Rec();
        new ZipDicomImporter(storage).importZip(z, rec);

        assertEquals(1, rec.imported);
        assertEquals(2, rec.failed.size(), rec.failed.toString());
        assertFalse(Files.exists(tmp.resolve("evil.dcm")));
    }

    @Test
    void oversizedEntry_isFailed_andTempRemoved() throws Exception {
        Path w = Files.createDirectories(tmp.resolve("w3"));
        byte[] a = dcm(w, "a.dcm", "1.2.zip.s3", "1.2.zip.s3.a");
        byte[] big = new byte[a.length * 4];
        System.arraycopy(a, 0, big, 0, a.length); // 先頭は有効な DICOM、後ろは水増し
        Path z = zip("bomb.zip", o -> entry(o, "big.dcm", big));
        Rec rec = new Rec();
        new ZipDicomImporter(storage, new ZipDicomImporter.Limits(100, a.length * 2L, 1L << 40, 0), null)
                .importZip(z, rec);

        assertEquals(0, rec.imported);
        assertEquals(1, rec.failed.size(), rec.failed.toString());
        assertEquals(0, importTempFiles());
    }

    @Test
    void lyingHeaderSize_isStillCappedByActualBytes() throws Exception {
        // ヘッダの宣言サイズが小さくても、実際に書いたバイト数で打ち切る（ストリームの上限は別経路）。
        Path w = Files.createDirectories(tmp.resolve("w3b"));
        byte[] a = dcm(w, "a.dcm", "1.2.zip.s3b", "1.2.zip.s3b.a");
        Path z = zip("total.zip", o -> {
            entry(o, "a1.dcm", a);
            entry(o, "a2.dcm", a);
        });
        Rec rec = new Rec();
        // 累積上限は 1 枚ぶんちょうど: 1 枚目は通り、2 枚目で打ち切り
        new ZipDicomImporter(storage, new ZipDicomImporter.Limits(100, 1L << 30, a.length, 0), null)
                .importZip(z, rec);

        assertEquals(1, rec.imported);
        assertEquals(1, rec.failed.size(), rec.failed.toString());
        assertEquals(0, importTempFiles());
    }

    @Test
    void notEnoughFreeSpace_isFailed_andNothingWritten() throws Exception {
        Path w = Files.createDirectories(tmp.resolve("w4"));
        byte[] a = dcm(w, "a.dcm", "1.2.zip.s4", "1.2.zip.s4.a");
        Path z = zip("space.zip", o -> entry(o, "a.dcm", a));
        Rec rec = new Rec();
        new ZipDicomImporter(storage, ZipDicomImporter.Limits.DEFAULT, () -> 1024L).importZip(z, rec);

        assertEquals(0, rec.imported);
        assertEquals(1, rec.failed.size());
        assertEquals(0, importTempFiles());
    }

    @Test
    void tooManyEntries_isFailed() throws Exception {
        Path z = zip("many.zip", o -> {
            for (int i = 0; i < 5; i++) {
                entry(o, "f" + i, new byte[] { 1 });
            }
        });
        Rec rec = new Rec();
        new ZipDicomImporter(storage, new ZipDicomImporter.Limits(3, 1 << 20, 1 << 30, 0), null).importZip(z, rec);
        assertEquals(1, rec.failed.size());
        assertEquals(0, rec.skipped);
    }

    @Test
    void corruptZip_isFailed_notThrown() throws Exception {
        Path z = tmp.resolve("corrupt.zip");
        Files.write(z, new byte[] { 'P', 'K', 3, 4, 1, 2, 3, 4, 5 });
        ImportService.ImportResult r = importService.importPaths(List.of(z.toString()));
        assertEquals(1, r.failed());
        assertEquals(0, r.imported());
    }

    @Test
    void manyEntries_neverHoldMoreThanOneTempFile() throws Exception {
        Path w = Files.createDirectories(tmp.resolve("w5"));
        List<byte[]> files = new ArrayList<>();
        for (int i = 0; i < 20; i++) {
            files.add(dcm(w, "f" + i + ".dcm", "1.2.zip.s5", "1.2.zip.s5." + i));
        }
        Path z = zip("peak.zip", o -> {
            for (int i = 0; i < files.size(); i++) {
                entry(o, "S/f" + i + ".dcm", files.get(i));
            }
        });
        long[] peak = { 0 };
        Rec rec = new Rec() {
            @Override
            public void imported(DicomInstance saved) {
                super.imported(saved);
                try {
                    peak[0] = Math.max(peak[0], importTempFiles());
                } catch (IOException e) {
                    throw new IllegalStateException(e);
                }
            }
        };
        new ZipDicomImporter(storage).importZip(z, rec);

        assertEquals(20, rec.imported);
        assertEquals(0, peak[0], "取り込みが済んだ時点で一時ファイルは残っていない（同時に載るのは 1 ファイル分だけ）");
        assertEquals(0, importTempFiles());
    }

    @Test
    void sweep_removesOnlyOldImpFiles() throws Exception {
        Path f1 = storage.newImportTempFile();
        Path f2 = storage.newImportTempFile();
        Files.setLastModifiedTime(f1, FileTime.from(Instant.now().minus(Duration.ofDays(3))));

        assertEquals(1, storage.sweepImportTemp(Duration.ofHours(24)));
        assertFalse(Files.exists(f1));
        assertTrue(Files.exists(f2), "新しいものは取り込み中かもしれないので残す");
        Files.delete(f2);
    }
}

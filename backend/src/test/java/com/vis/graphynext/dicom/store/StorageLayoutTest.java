/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * 索引の uri ⇔ 実ファイルの解決。保管フォルダを複製して開いたとき、複製元を読み書きしないことが要点。
 */
class StorageLayoutTest {

    private static DicomInstance inst(String uri) {
        DicomInstance i = new DicomInstance("1.2.3");
        i.setStudyInstanceUid("9.1");
        i.setSeriesInstanceUid("9.2");
        i.setUri(uri);
        return i;
    }

    private static Path touch(Path p) throws IOException {
        Files.createDirectories(p.getParent());
        Files.writeString(p, "x");
        return p;
    }

    @Test
    void 相対パスで保存しルートに結んで読む(@TempDir Path dir) throws IOException {
        StorageLayout layout = new StorageLayout(dir.resolve("日本語 フォルダ/dicom"));
        Path f = touch(layout.instancePath("9.1", "9.2", "1.2.3"));

        assertEquals("9.1/9.2/1.2.3.dcm", layout.toStored(f));
        assertEquals(f, layout.resolveForRead(inst("9.1/9.2/1.2.3.dcm")));
        assertEquals(f, layout.resolveForWrite(inst("9.1/9.2/1.2.3.dcm")));
    }

    @Test
    void 相対ルートとドット付きの旧来URIも同じファイルに解決する(@TempDir Path dir) throws IOException {
        StorageLayout layout = new StorageLayout(dir.resolve("./data/../data/dicom"));
        Path f = touch(dir.resolve("data/dicom/9.1/9.2/1.2.3.dcm"));
        String legacyWithDot = dir.resolve("./data/dicom/9.1/9.2/1.2.3.dcm").toUri().toString();

        assertEquals(f, layout.resolveForRead(inst(legacyWithDot)));
        assertEquals(f, layout.resolveForWrite(inst(legacyWithDot)));
    }

    @Test
    void 複製元を指す旧来URIは複製先の規約パスで読み書きする(@TempDir Path dir) throws IOException {
        Path original = touch(dir.resolve("old/dicom/9.1/9.2/1.2.3.dcm"));
        StorageLayout copied = new StorageLayout(dir.resolve("new/dicom"));
        Path copy = touch(dir.resolve("new/dicom/9.1/9.2/1.2.3.dcm"));
        DicomInstance row = inst(original.toUri().toString());

        assertEquals(copy, copied.resolveForRead(row));
        assertEquals(copy, copied.resolveForWrite(row), "削除・書換は複製元に作用させない");
    }

    @Test
    void ルート外の旧来URIは規約パスが無ければ読み取りだけ許す(@TempDir Path dir) throws IOException {
        Path outside = touch(dir.resolve("elsewhere/a.dcm"));
        StorageLayout layout = new StorageLayout(dir.resolve("db/dicom"));
        DicomInstance row = inst(outside.toUri().toString());

        assertEquals(outside, layout.resolveForRead(row));
        assertEquals(dir.resolve("db/dicom/9.1/9.2/1.2.3.dcm"), layout.resolveForWrite(row));
    }

    @Test
    void 実在しなければ読み取りはnull(@TempDir Path dir) {
        StorageLayout layout = new StorageLayout(dir);
        assertNull(layout.resolveForRead(inst("9.1/9.2/1.2.3.dcm")));
        assertNull(layout.resolveForRead(inst(dir.resolve("gone.dcm").toUri().toString())));
        assertNull(layout.resolveForRead(inst(null)));
    }

    @Test
    void ルートの外へ出る相対値は解決しない(@TempDir Path dir) throws IOException {
        StorageLayout layout = new StorageLayout(dir.resolve("db"));
        touch(dir.resolve("secret.dcm"));
        for (String bad : new String[]{"../secret.dcm", "9.1/../../secret.dcm", "/etc/passwd",
                "C:/x.dcm", "9.1\\9.2\\x.dcm", "", "9.1//x.dcm", "./x.dcm"}) {
            assertNull(layout.resolveForRead(inst(bad)), bad);
            assertNull(layout.resolveForWrite(inst(bad)), bad);
        }
    }

    @Test
    void 区切りやドットを含むUIDは保管パスにしない(@TempDir Path dir) {
        StorageLayout layout = new StorageLayout(dir);
        assertThrows(IllegalArgumentException.class, () -> layout.instancePath("..", "9.2", "1"));
        assertThrows(IllegalArgumentException.class, () -> layout.instancePath("9.1", "a/b", "1"));
        assertThrows(IllegalArgumentException.class, () -> layout.instancePath("9.1", "9.2", "x\\y"));
        assertThrows(IllegalArgumentException.class, () -> layout.instancePath(null, "9.2", "1"));
        assertThrows(IllegalArgumentException.class, () -> layout.toStored(dir.resolveSibling("x.dcm")));
    }
}

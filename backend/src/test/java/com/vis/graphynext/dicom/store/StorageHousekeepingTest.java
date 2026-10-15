/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import com.vis.graphynext.dbadmin.DbAdminService;
import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.importer.ImportService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;

/**
 * 保管庫の後始末: 取り込みの失敗で元のファイルを失わない・走査で作業用フォルダを拾わない・
 * 消したあとに空のフォルダを残さない。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:housekeeping;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class StorageHousekeepingTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("db/dicom").toString());
    }

    @Autowired
    DicomStorageService storage;
    @Autowired
    StorageLayout layout;
    @Autowired
    ImportService importer;
    @Autowired
    DbAdminService dbAdmin;
    @SpyBean
    DicomInstanceRepository repo;

    private Path phantom(String pid, String name, String study, String series, String sop) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage(pid, study, series, sop);
        ds.setString(Tag.PatientName, VR.PN, name);
        return DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian);
    }

    @Test
    void 再受信で索引の保存に失敗しても_元のファイルを失わない() throws Exception {
        storage.ingest(phantom("RB1", "OLD", "rb.st", "rb.se", "rb.1"));
        Path file = layout.resolveForRead(repo.findById("rb.1").orElseThrow());
        byte[] before = Files.readAllBytes(file);

        doThrow(new IllegalStateException("simulated")).when(repo).save(any(DicomInstance.class));
        try {
            assertThrows(IllegalStateException.class, () -> storage.ingest(phantom("RB1", "NEW", "rb.st", "rb.se", "rb.1")));
        } finally {
            org.mockito.Mockito.reset(repo);
        }
        assertTrue(Files.exists(file), "元のファイルが残る");
        assertArrayEquals(before, Files.readAllBytes(file), "中身も元のまま");
        try (Stream<Path> s = Files.list(file.getParent())) {
            assertEquals(List.of(file.getFileName().toString()), s.map(p -> p.getFileName().toString()).toList(),
                    "退避したファイルを残さない");
        }
    }

    @Test
    void 保管庫ごと取り込んでも_作業用フォルダと受け取り箱は拾わない() throws Exception {
        Path root = layout.root();
        Path dbFolder = root.getParent();
        for (String d : new String[]{"incoming", ".import", ".cache"}) {
            Files.createDirectories(root.resolve(d));
            Files.copy(phantom("WK1", "W", "wk." + d, "wk.se", "wk." + d + ".1"), root.resolve(d).resolve("x.dcm"));
        }
        Files.createDirectories(dbFolder.resolve("inbox/pkg/dicom"));
        Files.copy(phantom("WK1", "W", "wk.inbox", "wk.se", "wk.inbox.1"), dbFolder.resolve("inbox/pkg/dicom/x.dcm"));
        Path body = Files.createDirectories(root.resolve("wk.body/wk.se"));
        Files.copy(phantom("WK1", "W", "wk.body", "wk.se", "wk.body.1"), body.resolve("wk.body.1.dcm"));

        importer.importPaths(List.of(dbFolder.toString()));
        assertTrue(repo.existsById("wk.body.1"), "保管庫の本体は取り込める（索引の作り直し）");
        for (String sop : new String[]{"wk.incoming.1", "wk..import.1", "wk..cache.1", "wk.inbox.1"}) {
            assertFalse(repo.existsById(sop), sop);
        }
    }

    @Test
    void 消したあとに空の検査とシリーズのフォルダを残さない() throws Exception {
        storage.ingest(phantom("PR1", "P", "pr.a", "pr.a.se", "pr.a.1"));
        storage.ingest(phantom("PR1", "P", "pr.b", "pr.b.se1", "pr.b.1"));
        storage.ingest(phantom("PR1", "P", "pr.b", "pr.b.se2", "pr.b.2"));
        Path root = layout.root();

        dbAdmin.deleteStudy("pr.a");
        assertFalse(Files.exists(root.resolve("pr.a")), "空の検査フォルダを消す");

        dbAdmin.deleteSeries("pr.b", "pr.b.se1");
        assertFalse(Files.exists(root.resolve("pr.b/pr.b.se1")), "空のシリーズフォルダを消す");
        assertTrue(Files.exists(root.resolve("pr.b/pr.b.se2")), "ほかのシリーズは残す");

        dbAdmin.mergeSeries("pr.b", List.of("pr.b.se2"), "pr.b.merged", 9, "M");
        assertFalse(Files.exists(root.resolve("pr.b/pr.b.se2")), "統合で空になった元のシリーズを消す");
        assertTrue(Files.exists(root.resolve("pr.b/pr.b.merged")));
        assertTrue(Files.isDirectory(root), "ルートは消さない");
    }

    @Test
    void 新しい検査の取り込みに失敗しても_空のフォルダを残さない() throws Exception {
        Path tmpFile = phantom("NF1", "N", "nf.st", "nf.se", "nf.1");
        doThrow(new IllegalStateException("simulated")).when(repo).save(any(DicomInstance.class));
        try {
            assertThrows(IllegalStateException.class, () -> storage.ingest(tmpFile));
        } finally {
            org.mockito.Mockito.reset(repo);
        }
        assertFalse(Files.exists(layout.root().resolve("nf.st")), "新しく作った検査のフォルダを消す");
        assertTrue(Files.isDirectory(layout.root()), "ルートは消さない");
    }

    @Test
    void 移し先のフォルダが消えていたら作り直して移す_移す元が無ければ失敗() throws Exception {
        Path src = Files.writeString(tmp.resolve("move-src.dcm"), "x");
        Path dest = tmp.resolve("gone/series/a.dcm");
        DicomStorageService.moveIntoPlace(src, dest);
        assertTrue(Files.exists(dest));
        assertFalse(Files.exists(src));

        Path missing = tmp.resolve("no-such-src.dcm");
        assertThrows(java.nio.file.NoSuchFileException.class,
                () -> DicomStorageService.moveIntoPlace(missing, tmp.resolve("gone2/series/b.dcm")));
    }
}

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

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:importit;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class ImportServiceTest {

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

    @Test
    void importFolder_ingestsDicom_keepsOriginal_skipsNonDicom() throws Exception {
        Path src = Files.createDirectories(tmp.resolve("src"));
        Attributes ds = DicomPhantomFactory.scImage("IMP1", "1.2.imp.study", "1.2.imp.series", "1.2.imp.sop");
        Path dcm = DicomPhantomFactory.writeFile(src.resolve("image.dcm"), ds, UID.ExplicitVRLittleEndian);
        Files.writeString(src.resolve("readme.txt"), "not dicom");

        ImportService.ImportResult r = importService.importPaths(List.of(src.toString()));

        assertEquals(1, r.imported(), "DICOM 1 件取り込み");
        assertTrue(r.skipped() >= 1, "非 DICOM はスキップ");
        assertEquals(0, r.failed());
        assertTrue(Files.exists(dcm), "原本は保持される（移動しない）");
        assertEquals(1, storage.findMatches(null, "1.2.imp.study", null, null).size(), "索引に載る");
    }
}

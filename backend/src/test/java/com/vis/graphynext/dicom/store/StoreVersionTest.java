/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.gdrive.StorageChanged;
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
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 保管庫の変更の通し番号: 取り込みで増え、何もなければ増えない。実際の取り込み経路（イベントの配線）で確かめる。 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:storeversion;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class StoreVersionTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    StoreVersion storeVersion;
    @Autowired
    DicomStorageService storage;

    @Test
    void 何もしなければ番号は動かない() throws Exception {
        long v = storeVersion.snapshot().version();
        Thread.sleep(200);
        assertEquals(v, storeVersion.snapshot().version());
    }

    @Test
    void 実際の取り込みで番号が増え_時刻も入る() throws Exception {
        long before = storeVersion.snapshot().version();
        Attributes ds = DicomPhantomFactory.scImage("PSV1", "1.2.826.0.1.sv.study", "1.2.826.0.1.sv.series", "1.2.826.0.1.sv.sop");
        Path f = DicomPhantomFactory.writeFile(Files.createTempFile(tmp, "sv", ".dcm"), ds, UID.ExplicitVRLittleEndian);
        storage.ingest(f);
        var s = storeVersion.snapshot();
        assertTrue(s.version() > before, "取り込みで番号が増える");
        assertTrue(s.changedAt() > 0);
    }

    @Test
    void イベントの数だけ増える_時計を差し替えた単体() {
        var sv = new StoreVersion(Clock.fixed(Instant.parse("2026-11-09T00:00:00Z"), ZoneOffset.UTC));
        assertEquals(0, sv.snapshot().version());
        sv.onStorageChanged(new StorageChanged("a"));
        sv.onStorageChanged(new StorageChanged("b"));
        assertEquals(2, sv.snapshot().version());
        assertEquals(Instant.parse("2026-11-09T00:00:00Z").toEpochMilli(), sv.snapshot().changedAt());
    }
}

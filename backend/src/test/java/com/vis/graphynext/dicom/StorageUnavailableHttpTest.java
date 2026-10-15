/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.StorageBackend;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.dicom.store.StorageUnavailableException;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collection;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * モード A: 追い出された画像を、ビューアが使う HTTP の口（{@code /api/instances/{sop}/file}）で開いたときの応答。
 * 取り寄せられれば 200 とその内容、取り寄せられなければ 503＋理由コード、そもそも無ければ 404。
 * 「取れなかった」を 404（その画像は無い）にしない。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=standalone",
        "spring.datasource.url=jdbc:h2:mem:storageunavail;DB_CLOSE_DELAY=-1",
        "graphy.dicom.scp.enabled=false"
})
@AutoConfigureMockMvc
class StorageUnavailableHttpTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("dicom").toString());
        r.add("graphy.plugins.dir", () -> tmp.resolve("plugins").toString());
    }

    @Autowired
    MockMvc mvc;
    @Autowired
    DicomStorageService storage;
    @Autowired
    DicomInstanceRepository repo;
    @Autowired
    StorageLayout layout;

    /** 追い出し済みを再現する取り寄せ口: 保存しておいた内容を書き戻す／失敗させる。 */
    private static final class Backend implements StorageBackend {
        final java.util.Map<String, byte[]> remote = new java.util.HashMap<>();
        final Path root;
        String failWith;

        Backend(Path root) {
            this.root = root;
        }

        @Override public boolean cacheMode() { return true; }

        @Override public Path ensureLocal(String rel) {
            byte[] b = remote.get(rel);
            if (b == null) {
                return null;
            }
            if (failWith != null) {
                throw new StorageUnavailableException(failWith);
            }
            try {
                Path p = root.resolve(rel);
                Files.createDirectories(p.getParent());
                Files.write(p, b);
                return p;
            } catch (java.io.IOException e) {
                throw new java.io.UncheckedIOException(e);
            }
        }

        @Override public void prefetch(Collection<String> rels, BooleanSupplier cancelled) { rels.forEach(this::ensureLocal); }

        @Override public void touch(String rel) { }
    }

    private byte[] ingestAndEvict(Backend be, String sop) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage("PHTTP", "http.study", "http.series", sop);
        ds.setString(Tag.PatientName, VR.PN, "X");
        Path f = DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian);
        storage.ingest(f);
        DicomInstance row = repo.findById(sop).orElseThrow();
        Path local = layout.resolveForRead(row);
        byte[] bytes = Files.readAllBytes(local);
        be.remote.put(layout.toStored(local), bytes);
        Files.delete(local);
        return bytes;
    }

    @Test
    void 追い出された画像は取り寄せて200で返し_取れなければ503_存在しなければ404() throws Exception {
        Backend be = new Backend(layout.root());
        byte[] original = ingestAndEvict(be, "http.sop.1");
        layout.setBackend(be);
        try {
            // 取り寄せに失敗 → 503＋理由（「無い」の 404 にしない）
            be.failWith = "offline";
            mvc.perform(get("/api/instances/http.sop.1/file"))
                    .andExpect(status().isServiceUnavailable())
                    .andExpect(jsonPath("$.status").value(503))
                    .andExpect(jsonPath("$.message").value("offline"));
            // 直ったら取り寄せて 200・内容が元と一致
            be.failWith = null;
            byte[] body = mvc.perform(get("/api/instances/http.sop.1/file"))
                    .andExpect(status().isOk())
                    .andReturn().getResponse().getContentAsByteArray();
            assertArrayEquals(original, body);
            // 索引にも台帳にも無い SOP は、従来どおり 404
            mvc.perform(get("/api/instances/no.such.sop/file")).andExpect(status().isNotFound());
        } finally {
            layout.setBackend(null);
        }
    }

    @Test
    void モードBでは手元に無い画像は従来どおり404() throws Exception {
        Backend be = new Backend(layout.root());
        ingestAndEvict(be, "http.sop.2"); // 手元から消えた（backend は登録しない＝モード B）
        assertEquals(false, layout.cacheMode());
        mvc.perform(get("/api/instances/http.sop.2/file")).andExpect(status().isNotFound());
    }
}

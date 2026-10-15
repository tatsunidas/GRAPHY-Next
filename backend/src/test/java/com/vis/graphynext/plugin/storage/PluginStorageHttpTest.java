/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.storage;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.dicom.DicomPhantomFactory;
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
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collection;
import java.util.HashMap;
import java.util.Map;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** H62: 実際の HTTP・ジョブ・プラグイン登録を通して、手元への確保を確かめる。 */
@SpringBootTest(properties = {
        "spring.profiles.active=standalone",
        "spring.datasource.url=jdbc:h2:mem:pluginstorage;DB_CLOSE_DELAY=-1",
        "graphy.dicom.scp.enabled=false"
})
@AutoConfigureMockMvc
class PluginStorageHttpTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) throws IOException {
        Path plugins = tmp.resolve("plugins");
        Path p = plugins.resolve("ptest");
        Files.createDirectories(p);
        Files.writeString(p.resolve("plugin.json"), "{\"id\":\"ptest\",\"name\":\"Storage test\",\"version\":\"1.0.0\"}");
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
        r.add("graphy.plugins.dir", plugins::toString);
    }

    @Autowired
    MockMvc mvc;
    @Autowired
    DicomStorageService storage;
    @Autowired
    DicomInstanceRepository repo;
    @Autowired
    StorageLayout layout;

    private final ObjectMapper om = new ObjectMapper();

    private static final class Backend implements StorageBackend {
        final Map<String, byte[]> remote = new HashMap<>();
        final Path root;
        volatile String failWith;

        Backend(Path root) {
            this.root = root;
        }

        @Override public boolean cacheMode() { return true; }

        @Override public Path ensureLocal(String rel) {
            byte[] b = remote.get(rel);
            if (b == null) return null;
            if (failWith != null) throw new StorageUnavailableException(failWith);
            try {
                Path p = root.resolve(rel);
                Files.createDirectories(p.getParent());
                Files.write(p, b);
                return p;
            } catch (IOException e) {
                throw new java.io.UncheckedIOException(e);
            }
        }

        @Override public void prefetch(Collection<String> rels, BooleanSupplier c) { rels.forEach(this::ensureLocal); }

        @Override public void touch(String rel) { }
    }

    private Backend ingestAndEvict(String study, String... sops) throws Exception {
        Backend be = new Backend(layout.root());
        for (String sop : sops) {
            Attributes ds = DicomPhantomFactory.scImage("PH-" + study, study, study + ".se", sop);
            ds.setString(Tag.PatientName, VR.PN, "X");
            storage.ingest(DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian));
            DicomInstance row = repo.findById(sop).orElseThrow();
            Path local = layout.resolveForRead(row);
            be.remote.put(layout.toStored(local), Files.readAllBytes(local));
            Files.delete(local);
        }
        return be;
    }

    private JsonNode runJob(String plugin, String body) throws Exception {
        String started = mvc.perform(post("/api/plugins/" + plugin + "/storage/ensure").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        String jobId = om.readTree(started).path("jobId").asText();
        for (int i = 0; i < 300; i++) {
            JsonNode st = om.readTree(mvc.perform(get("/api/plugin-jobs/" + jobId)).andExpect(status().isOk()).andReturn().getResponse().getContentAsString());
            if (List_of("DONE", "FAILED", "CANCELLED").contains(st.path("state").asText())) return st;
            Thread.sleep(20);
        }
        throw new AssertionError("job did not finish");
    }

    private static java.util.List<String> List_of(String... s) {
        return java.util.List.of(s);
    }

    @Test
    void 追い出された検査を確保するジョブ_状態は読み取りのみでパスを含まない() throws Exception {
        Backend be = ingestAndEvict("hs1", "hs1.a", "hs1.b", "hs1.c");
        layout.setBackend(be);
        try {
            JsonNode st = runJob("ptest", "{\"studyUid\":\"hs1\"}");
            assertEquals("DONE", st.path("state").asText(), st.toString());
            JsonNode r = st.path("result");
            assertTrue(r.path("ok").asBoolean(), r.toString());
            assertEquals(3, r.path("total").asInt());
            assertEquals(3, r.path("fetched").asInt());
            for (String sop : List_of("hs1.a", "hs1.b", "hs1.c")) {
                assertTrue(Files.exists(layout.resolveForRead(repo.findById(sop).orElseThrow())), sop);
            }
            assertFalse(st.toString().contains(layout.root().toString()), "応答にパスは含めない");
            String stat = mvc.perform(get("/api/plugins/ptest/storage/status")).andExpect(status().isOk())
                    .andExpect(jsonPath("$.cacheMode").value(false)) // Drive が設定されていないテスト環境
                    .andReturn().getResponse().getContentAsString();
            assertFalse(stat.contains(layout.root().toString()));
        } finally {
            layout.setBackend(null);
        }
    }

    @Test
    void 取り寄せに失敗したら_ジョブは終わり_結果に理由コード() throws Exception {
        Backend be = ingestAndEvict("hs2", "hs2.a");
        be.failWith = "offline";
        layout.setBackend(be);
        try {
            JsonNode st = runJob("ptest", "{\"studyUid\":\"hs2\"}");
            assertEquals("DONE", st.path("state").asText());
            assertFalse(st.path("result").path("ok").asBoolean());
            assertEquals("offline", st.path("result").path("error").asText());
        } finally {
            layout.setBackend(null);
        }
    }

    @Test
    void 存在しない検査は_not_found_を結果で返す() throws Exception {
        JsonNode st = runJob("ptest", "{\"studyUid\":\"no-such-study\"}");
        assertEquals("not-found", st.path("result").path("error").asText());
    }

    // ── 負例: 入口で弾く ──

    @Test
    void 知らないプラグインは404_形の誤りは400() throws Exception {
        mvc.perform(post("/api/plugins/nobody/storage/ensure").contentType(MediaType.APPLICATION_JSON).content("{\"studyUid\":\"x\"}"))
                .andExpect(status().isNotFound());
        mvc.perform(get("/api/plugins/nobody/storage/status")).andExpect(status().isNotFound());
        for (String bad : List_of("{}", "{\"studyUid\":\"\"}", "{\"studyUid\":\"" + "9".repeat(65) + "\"}",
                "{\"studyUid\":\"x\",\"seriesUids\":[\"\"]}")) {
            mvc.perform(post("/api/plugins/ptest/storage/ensure").contentType(MediaType.APPLICATION_JSON).content(bad))
                    .andExpect(status().isBadRequest());
        }
    }
}

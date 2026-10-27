/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.album;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.UID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * アルバム API。主眼は 2 つ:
 * ① アルバムを消す・所属を外す・スタディを消す、のどれでも<b>相手側は無傷</b>（スタディ本体は残り、
 *    スタディを消してもアルバムは壊れない）
 * ② 不正な入力は<b>1 件も入れずに</b>拒否する
 */
@SpringBootTest(properties = {
        "spring.profiles.active=standalone",
        "spring.datasource.url=jdbc:h2:mem:albumapi;DB_CLOSE_DELAY=-1",
        "graphy.dicom.scp.enabled=false"
})
@AutoConfigureMockMvc
class AlbumApiTest {

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
    AlbumStudyRepository members;

    private final ObjectMapper om = new ObjectMapper();

    private JsonNode json(MvcResult r) throws Exception {
        return om.readTree(r.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8));
    }

    private long createAlbum(String name) throws Exception {
        MvcResult r = mvc.perform(post("/api/albums").contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"" + name + "\"}")).andExpect(status().isCreated()).andReturn();
        return json(r).get("id").asLong();
    }

    private MvcResult add(long id, String... uids) throws Exception {
        return mvc.perform(post("/api/albums/" + id + "/studies").contentType(MediaType.APPLICATION_JSON)
                .content(uidsBody(uids))).andReturn();
    }

    private static String uidsBody(String... uids) {
        List<String> q = new ArrayList<>();
        for (String u : uids) {
            q.add(u == null ? "null" : "\"" + u + "\"");
        }
        return "{\"studyUids\":[" + String.join(",", q) + "]}";
    }

    private List<String> uids(long id) throws Exception {
        MvcResult r = mvc.perform(get("/api/albums/" + id + "/studies")).andExpect(status().isOk()).andReturn();
        List<String> out = new ArrayList<>();
        json(r).forEach(n -> out.add(n.asText()));
        return out;
    }

    private void ingest(String study, String sop) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage("ALB-" + study, study, study + ".1", sop);
        Path f = DicomPhantomFactory.writeFile(Files.createTempFile("alb", ".dcm"), ds, UID.ExplicitVRLittleEndian);
        storage.ingest(f);
    }

    /** 一覧に出るスタディの UID（standalone。StudyInstanceUID 指定の取得）。 */
    private List<String> listedStudies(String... uids) throws Exception {
        MvcResult r = mvc.perform(get("/api/studies").param("studyInstanceUid", String.join(",", uids)))
                .andExpect(status().isOk()).andReturn();
        List<String> out = new ArrayList<>();
        json(r).forEach(n -> out.add(n.get("studyInstanceUid").asText()));
        return out;
    }

    @Test
    void 作成_一覧_名前変更_削除の往復() throws Exception {
        long id = createAlbum("  研究A  ");
        MvcResult list = mvc.perform(get("/api/albums")).andExpect(status().isOk()).andReturn();
        JsonNode mine = null;
        for (JsonNode n : json(list)) {
            if (n.get("id").asLong() == id) {
                mine = n;
            }
        }
        assertTrue(mine != null, "作ったアルバムが一覧に出る");
        assertEquals("研究A", mine.get("name").asText(), "前後の空白は除く");
        assertEquals(0, mine.get("count").asInt());

        mvc.perform(put("/api/albums/" + id).contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"研究B\"}"))
                .andExpect(status().isOk());
        mvc.perform(delete("/api/albums/" + id)).andExpect(status().isOk());
        mvc.perform(get("/api/albums/" + id + "/studies")).andExpect(status().isNotFound());
    }

    @Test
    void 追加は追加順で返り_重複は増えない() throws Exception {
        long id = createAlbum("order");
        JsonNode first = json(add(id, "1.2.30", "1.2.10", "1.2.20"));
        assertEquals(3, first.get("added").asInt());
        assertEquals(List.of("1.2.30", "1.2.10", "1.2.20"), uids(id), "UID 順ではなく追加順");

        JsonNode again = json(add(id, "1.2.10", "1.2.40", "1.2.40"));
        assertEquals(1, again.get("added").asInt(), "同じ要求の中の重複も 1 件");
        assertEquals(1, again.get("alreadyIn").asInt());
        assertEquals(List.of("1.2.30", "1.2.10", "1.2.20", "1.2.40"), uids(id));
    }

    @Test
    void 外すと減り_元から無いものは数えない() throws Exception {
        long id = createAlbum("remove");
        add(id, "1.3.1", "1.3.2");
        MvcResult r = mvc.perform(post("/api/albums/" + id + "/studies/remove")
                .contentType(MediaType.APPLICATION_JSON).content(uidsBody("1.3.1", "1.3.99")))
                .andExpect(status().isOk()).andReturn();
        assertEquals(1, json(r).get("removed").asInt());
        assertEquals(List.of("1.3.2"), uids(id));
    }

    @Test
    void 外してもアルバムを消してもスタディ本体は残る() throws Exception {
        ingest("1.4.1", "1.4.1.1");
        ingest("1.4.2", "1.4.2.1");
        assertEquals(2, listedStudies("1.4.1", "1.4.2").size(), "前提: 取り込んだスタディが一覧に出る");
        long id = createAlbum("keep");
        add(id, "1.4.1", "1.4.2");

        mvc.perform(post("/api/albums/" + id + "/studies/remove").contentType(MediaType.APPLICATION_JSON)
                .content(uidsBody("1.4.1"))).andExpect(status().isOk());
        assertEquals(2, listedStudies("1.4.1", "1.4.2").size(), "外してもスタディは残る");

        mvc.perform(delete("/api/albums/" + id)).andExpect(status().isOk());
        assertEquals(2, listedStudies("1.4.1", "1.4.2").size(), "アルバムを消してもスタディは残る");
        assertEquals(0, members.countByIdAlbumId(id), "アルバム削除後に所属の行が残らない（孤児行なし）");
    }

    @Test
    void スタディを削除してもアルバムは壊れず_ほかのメンバーも読める() throws Exception {
        ingest("1.5.1", "1.5.1.1");
        ingest("1.5.2", "1.5.2.1");
        long id = createAlbum("dangling");
        add(id, "1.5.1", "1.5.2");

        mvc.perform(delete("/api/studies/1.5.1")).andExpect(status().isOk());
        assertEquals(List.of("1.5.2"), listedStudies("1.5.1", "1.5.2"), "前提: 消したスタディは一覧から消えた");
        assertEquals(List.of("1.5.1", "1.5.2"), uids(id), "アルバムは宙ぶらりんの UID も返し続ける");
        mvc.perform(get("/api/albums")).andExpect(status().isOk());
    }

    @Test
    void 名前が不正なら400_重複は409() throws Exception {
        for (String body : new String[] {"{\"name\":\"\"}", "{\"name\":\"   \"}", "{}",
                "{\"name\":\"" + "あ".repeat(101) + "\"}"}) {
            mvc.perform(post("/api/albums").contentType(MediaType.APPLICATION_JSON).content(body))
                    .andExpect(status().isBadRequest());
        }
        mvc.perform(post("/api/albums").contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"" + "あ".repeat(100) + "\"}")).andExpect(status().isCreated());

        createAlbum("dup");
        mvc.perform(post("/api/albums").contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"dup\"}"))
                .andExpect(status().isConflict());
        long other = createAlbum("dup2");
        mvc.perform(put("/api/albums/" + other).contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"dup\"}"))
                .andExpect(status().isConflict());
        mvc.perform(put("/api/albums/" + other).contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"dup2\"}"))
                .andExpect(status().isOk());
    }

    @Test
    void 不在のアルバムは404() throws Exception {
        long gone = createAlbum("gone");
        mvc.perform(delete("/api/albums/" + gone)).andExpect(status().isOk());
        mvc.perform(put("/api/albums/" + gone).contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"x\"}"))
                .andExpect(status().isNotFound());
        mvc.perform(delete("/api/albums/" + gone)).andExpect(status().isNotFound());
        mvc.perform(post("/api/albums/" + gone + "/studies").contentType(MediaType.APPLICATION_JSON)
                .content(uidsBody("1.6.1"))).andExpect(status().isNotFound());
        mvc.perform(post("/api/albums/" + gone + "/studies/remove").contentType(MediaType.APPLICATION_JSON)
                .content(uidsBody("1.6.1"))).andExpect(status().isNotFound());
    }

    @Test
    void 不正なUIDが1つでもあれば1件も入れない() throws Exception {
        long id = createAlbum("atomic");
        String tooLong = "1." + "2".repeat(63); // 65 字
        for (String bad : new String[] {"", "abc", "1.2.x", tooLong, " 1.2", null}) {
            mvc.perform(post("/api/albums/" + id + "/studies").contentType(MediaType.APPLICATION_JSON)
                    .content(uidsBody("1.7.1", bad))).andExpect(status().isBadRequest());
        }
        assertEquals(List.of(), uids(id), "有効な UID が混ざっていても 1 件も入らない");

        List<String> many = new ArrayList<>();
        for (int i = 0; i < 1001; i++) {
            many.add("1.8." + i);
        }
        mvc.perform(post("/api/albums/" + id + "/studies").contentType(MediaType.APPLICATION_JSON)
                .content(uidsBody(many.toArray(String[]::new)))).andExpect(status().isBadRequest());
        mvc.perform(post("/api/albums/" + id + "/studies").contentType(MediaType.APPLICATION_JSON)
                .content("{\"studyUids\":[]}")).andExpect(status().isBadRequest());
        assertEquals(List.of(), uids(id));

        // 正例: 64 字ちょうどと 1000 件は通る
        String exact = "1." + "2".repeat(62);
        assertEquals(64, exact.length());
        assertEquals(1, json(add(id, exact)).get("added").asInt());
        assertFalse(uids(id).isEmpty());
        mvc.perform(post("/api/albums/" + id + "/studies/remove").contentType(MediaType.APPLICATION_JSON)
                .content(uidsBody(many.subList(0, 1000).toArray(String[]::new)))).andExpect(status().isOk());
    }
}

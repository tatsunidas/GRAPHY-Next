/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.cache;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Random;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.head;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** H69: 実際の HTTP・プラグイン登録を通して、置き場のバイナリの往復・分離・上限を確かめる。 */
@SpringBootTest(properties = {
        "spring.profiles.active=standalone",
        "spring.datasource.url=jdbc:h2:mem:plugincache;DB_CLOSE_DELAY=-1",
        "graphy.dicom.scp.enabled=false",
        "graphy.plugin.cache.max-item-bytes=4194304"
})
@AutoConfigureMockMvc
class PluginCacheHttpTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) throws IOException {
        Path plugins = tmp.resolve("plugins");
        for (String id : new String[] {"pa", "pb"}) {
            Path p = plugins.resolve(id);
            Files.createDirectories(p);
            Files.writeString(p.resolve("plugin.json"), "{\"id\":\"" + id + "\",\"name\":\"Cache test " + id + "\",\"version\":\"1.0.0\"}");
        }
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
        r.add("graphy.plugins.dir", plugins::toString);
    }

    @Autowired
    MockMvc mvc;

    private static String enc(String key) {
        return URLEncoder.encode(key, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static byte[] random(int n, long seed) {
        byte[] b = new byte[n];
        new Random(seed).nextBytes(b);
        return b;
    }

    private MockHttpServletRequestBuilder withKey(MockHttpServletRequestBuilder b, String key) {
        return b.header(PluginCacheController.KEY_HEADER, enc(key));
    }

    @Test
    void バイナリが往復してバイト一致する_3MiB_と日本語の鍵() throws Exception {
        byte[] data = random(3 * 1024 * 1024, 42);
        mvc.perform(withKey(put("/api/plugins/pa/cache/item"), "再構成/患者 A+B").contentType(MediaType.APPLICATION_OCTET_STREAM).content(data))
                .andExpect(status().isOk()).andExpect(jsonPath("$.ok").value(true));
        byte[] back = mvc.perform(withKey(get("/api/plugins/pa/cache/item"), "再構成/患者 A+B"))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray();
        assertArrayEquals(data, back);
        mvc.perform(withKey(head("/api/plugins/pa/cache/item"), "再構成/患者 A+B")).andExpect(status().isOk());
        mvc.perform(withKey(head("/api/plugins/pa/cache/item"), "再構成/患者 A B")).andExpect(status().isNotFound());
    }

    @Test
    void 別のプラグインの_id_では同じ鍵でも見えず_消せもしない() throws Exception {
        mvc.perform(withKey(put("/api/plugins/pa/cache/item"), "shared").contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[] {1, 2, 3}))
                .andExpect(status().isOk());
        mvc.perform(withKey(get("/api/plugins/pb/cache/item"), "shared")).andExpect(status().isNotFound()).andExpect(jsonPath("$.error").value("not-found"));
        mvc.perform(withKey(delete("/api/plugins/pb/cache/item"), "shared")).andExpect(status().isOk());
        mvc.perform(withKey(head("/api/plugins/pa/cache/item"), "shared")).andExpect(status().isOk());
        mvc.perform(withKey(delete("/api/plugins/pa/cache/item"), "shared")).andExpect(status().isOk());
        mvc.perform(withKey(head("/api/plugins/pa/cache/item"), "shared")).andExpect(status().isNotFound());
    }

    @Test
    void 知らないプラグイン_id_は404() throws Exception {
        mvc.perform(withKey(put("/api/plugins/nobody/cache/item"), "k").contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[] {1}))
                .andExpect(status().isNotFound());
        mvc.perform(withKey(get("/api/plugins/nobody/cache/item"), "k")).andExpect(status().isNotFound());
    }

    @Test
    void 鍵が無い_長すぎる_制御文字は400() throws Exception {
        mvc.perform(put("/api/plugins/pa/cache/item").contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[] {1}))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error").value("invalid-key"));
        mvc.perform(withKey(put("/api/plugins/pa/cache/item"), "x".repeat(257)).contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[] {1}))
                .andExpect(status().isBadRequest());
        mvc.perform(put("/api/plugins/pa/cache/item").header(PluginCacheController.KEY_HEADER, "a%0Ab").contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[] {1}))
                .andExpect(status().isBadRequest());
        mvc.perform(put("/api/plugins/pa/cache/item").header(PluginCacheController.KEY_HEADER, "%ZZ").contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[] {1}))
                .andExpect(status().isBadRequest());
    }

    @Test
    void 上限を超える本体は413で何も残らない() throws Exception {
        mvc.perform(withKey(put("/api/plugins/pa/cache/item"), "big").contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[4 * 1024 * 1024 + 1]))
                .andExpect(status().isPayloadTooLarge()).andExpect(jsonPath("$.error").value("too-large"));
        mvc.perform(withKey(head("/api/plugins/pa/cache/item"), "big")).andExpect(status().isNotFound());
        // ちょうど上限は通る
        mvc.perform(withKey(put("/api/plugins/pa/cache/item"), "exact").contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[4 * 1024 * 1024]))
                .andExpect(status().isOk());
    }

    @Test
    void チェックポイントの保存_読み出し_範囲外の添字_全消去() throws Exception {
        for (int i = 0; i < 3; i++) {
            mvc.perform(withKey(put("/api/plugins/pa/cache/checkpoint/" + i), "job-1").contentType(MediaType.APPLICATION_OCTET_STREAM).content(random(1000, i)))
                    .andExpect(status().isOk());
        }
        assertArrayEquals(random(1000, 1), mvc.perform(withKey(get("/api/plugins/pa/cache/checkpoint/1"), "job-1"))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray());
        mvc.perform(withKey(get("/api/plugins/pb/cache/checkpoint/1"), "job-1")).andExpect(status().isNotFound());
        mvc.perform(withKey(put("/api/plugins/pa/cache/checkpoint/-1"), "job-1").contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[1]))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error").value("invalid-index"));
        mvc.perform(withKey(put("/api/plugins/pa/cache/checkpoint/1000000"), "job-1").contentType(MediaType.APPLICATION_OCTET_STREAM).content(new byte[1]))
                .andExpect(status().isBadRequest());

        mvc.perform(withKey(delete("/api/plugins/pa/cache/checkpoint"), "job-1")).andExpect(status().isOk());
        for (int i = 0; i < 3; i++) {
            mvc.perform(withKey(get("/api/plugins/pa/cache/checkpoint/" + i), "job-1")).andExpect(status().isNotFound());
        }
    }
}

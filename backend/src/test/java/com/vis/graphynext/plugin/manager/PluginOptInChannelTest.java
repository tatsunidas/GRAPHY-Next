/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.vis.graphynext.settings.SettingsService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * プラグイン導入の同意は Electron main だけが変えられる。一般の設定の API（レンダラ・プラグインが
 * 自由に呼べる）から書けると、利用者の了承なしに導入を開けてしまう。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=standalone",
        "spring.datasource.url=jdbc:h2:mem:optin;DB_CLOSE_DELAY=-1",
        "graphy.dicom.scp.enabled=false",
        "GRAPHY_MAIN_SECRET=" + PluginOptInChannelTest.SECRET
})
@AutoConfigureMockMvc
class PluginOptInChannelTest {

    static final String SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

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
    SettingsService settings;

    private String optIn() {
        return settings.getAll().get(SettingsService.PLUGIN_INSTALL_ENABLED_KEY);
    }

    @Test
    void 一般の設定の_API_からは同意を変えられない() throws Exception {
        String before = optIn();
        mvc.perform(put("/api/settings").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"plugins.installEnabled\":\"true\"}"))
                .andExpect(status().isBadRequest());
        assertEquals(before, optIn());
        // ほかのキーは従来どおり書ける
        mvc.perform(put("/api/settings").contentType(MediaType.APPLICATION_JSON).content("{\"ui.test\":\"1\"}"))
                .andExpect(status().isOk());
    }

    @Test
    void main_の口は秘密があれば変えられ_無ければ口ごと見えない() throws Exception {
        mvc.perform(put("/api/internal/plugin-manager/opt-in").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":true}"))
                .andExpect(status().isNotFound());
        mvc.perform(put("/api/internal/plugin-manager/opt-in").contentType(MediaType.APPLICATION_JSON)
                        .header("Authorization", "Bearer " + SECRET).header("Origin", "file://")
                        .content("{\"enabled\":true}"))
                .andExpect(status().isNotFound());

        mvc.perform(put("/api/internal/plugin-manager/opt-in").contentType(MediaType.APPLICATION_JSON)
                        .header("Authorization", "Bearer " + SECRET).content("{\"enabled\":true}"))
                .andExpect(status().isOk());
        assertEquals("true", optIn());
        mvc.perform(put("/api/internal/plugin-manager/opt-in").contentType(MediaType.APPLICATION_JSON)
                        .header("Authorization", "Bearer " + SECRET).content("{\"enabled\":false}"))
                .andExpect(status().isOk());
        assertEquals("false", optIn());
    }

    @Test
    void localhost_以外の_Host_は弾く_転送ヘッダの偽装も効かない() throws Exception {
        mvc.perform(put("/api/settings").contentType(MediaType.APPLICATION_JSON).content("{\"ui.test\":\"2\"}")
                        .header("Host", "evil.example:8080"))
                .andExpect(status().isForbidden());
        mvc.perform(put("/api/settings").contentType(MediaType.APPLICATION_JSON).content("{\"ui.test\":\"2\"}")
                        .header("Host", "evil.example:8080").header("X-Forwarded-Host", "localhost"))
                .andExpect(status().isForbidden());
        for (String h : new String[]{"localhost:8080", "127.0.0.1:1", "[::1]:8080", "LOCALHOST"}) {
            mvc.perform(put("/api/settings").contentType(MediaType.APPLICATION_JSON).content("{\"ui.test\":\"3\"}")
                            .header("Host", h))
                    .andExpect(status().isOk());
        }
    }
}

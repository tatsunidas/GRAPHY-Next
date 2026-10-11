/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.settings.Setting;
import com.vis.graphynext.settings.SettingRepository;
import com.vis.graphynext.settings.SettingsService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * DIMSE TLS のパスワードは API で返さず、standalone では main（OS のキーチェーン）から渡す。
 * 共通の設定ファイルを使い、DB にも旧来の行が残っている（段 2 の移行のまま）状態で確かめる。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=standalone",
        "spring.datasource.url=jdbc:h2:mem:tlspw;DB_CLOSE_DELAY=-1",
        "graphy.dicom.scp.enabled=false",
        "GRAPHY_MAIN_SECRET=" + DicomTlsPasswordTest.SECRET,
        "GRAPHY_TLS_KEY_STORE_PASSWORD=from-keychain-ks"
})
@AutoConfigureMockMvc
class DicomTlsPasswordTest {

    static final String SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
    private static final String LEGACY = "{\"enabled\":true,\"port\":2762,\"keyStore\":\"/k.p12\","
            + "\"keyStorePassword\":\"legacy-ks-pw\",\"trustStore\":\"/t.p12\",\"trustStorePassword\":\"legacy-ts-pw\","
            + "\"needClientAuth\":true}";

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("dicom").toString());
        r.add("graphy.plugins.dir", () -> tmp.resolve("plugins").toString());
        r.add("graphy.settings.global-file", () -> tmp.resolve("settings.json").toString());
    }

    @Autowired
    MockMvc mvc;
    @Autowired
    SettingsService settings;
    @Autowired
    SettingRepository repo;
    @Autowired
    DicomTlsService tls;
    @Autowired
    DicomTlsSecrets secrets;

    @BeforeEach
    void legacyPlaintext() {
        settings.putAll(Map.of(DicomTlsService.TLS_KEY, LEGACY));       // 共通ファイル
        Setting row = repo.findById(DicomTlsService.TLS_KEY).orElseGet(() -> new Setting(DicomTlsService.TLS_KEY));
        row.setValue(LEGACY);                                            // DB の旧来の行
        repo.save(row);
        secrets.update(null, "");
    }

    @Test
    void API_はパスワードを返さず_設定済みかどうかだけ返す() throws Exception {
        String all = mvc.perform(get("/api/settings")).andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
        assertFalse(all.contains("legacy-ks-pw") || all.contains("legacy-ts-pw"), all);
        assertTrue(all.contains("keyStorePasswordSet\\\":true"), all);

        String cfg = mvc.perform(get("/api/dicom/tls-config")).andExpect(status().isOk())
                .andExpect(jsonPath("$.keyStorePasswordSet").value(true))
                .andExpect(jsonPath("$.trustStorePasswordSet").value(true))
                .andReturn().getResponse().getContentAsString();
        assertFalse(cfg.contains("legacy-ks-pw") || cfg.contains("from-keychain-ks"), cfg);
        assertTrue(cfg.contains("\"keyStorePassword\":null"), cfg);
    }

    @Test
    void 一般の設定の_API_からは_dicom_tls_を書けない() throws Exception {
        mvc.perform(put("/api/settings").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"dicom.tls\":\"{}\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void main_から起動したときは_REST_でパスワードを受けず_null_なら今の値を保つ() throws Exception {
        mvc.perform(post("/api/dicom/tls-config").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":true,\"port\":2762,\"keyStorePassword\":\"typed\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/api/dicom/tls-config").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"enabled\":true,\"port\":2763,\"keyStore\":\"/k2.p12\",\"keyStorePassword\":null}"))
                .andExpect(status().isOk());
        assertEquals(2763, tls.effective().getPort());
        assertEquals("legacy-ts-pw", tls.effective().getTrustStorePassword(), "null は今の値を保つ");
    }

    @Test
    void キーチェーンから渡した値が優先され_main_の口でだけ入れ直せる() throws Exception {
        assertEquals("from-keychain-ks", tls.effective().getKeyStorePassword(), "起動時の環境変数（main）が優先");
        assertEquals("legacy-ts-pw", tls.effective().getTrustStorePassword(), "渡されていない方は保存値");

        mvc.perform(put("/api/internal/dicom/tls-secrets").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"trustStorePassword\":\"x\"}"))
                .andExpect(status().isNotFound());
        mvc.perform(put("/api/internal/dicom/tls-secrets").contentType(MediaType.APPLICATION_JSON)
                        .header("Authorization", "Bearer " + SECRET).content("{\"trustStorePassword\":\"new-ts\"}"))
                .andExpect(status().isOk());
        assertEquals("new-ts", tls.effective().getTrustStorePassword());
        assertEquals("from-keychain-ks", tls.effective().getKeyStorePassword(), "null の方は変えない");
        assertFalse(settings.getAll().get(DicomTlsService.TLS_KEY).contains("new-ts"), "メモリにだけ持つ");
    }

    @Test
    void 旧来の平文を移したあと_設定ファイルと_DB_の行の両方から消す() throws Exception {
        mvc.perform(get("/api/internal/dicom/tls-legacy-secrets").header("Authorization", "Bearer " + SECRET))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.keyStorePassword").value("legacy-ks-pw"))
                .andExpect(jsonPath("$.trustStorePassword").value("legacy-ts-pw"));
        mvc.perform(post("/api/internal/dicom/tls-legacy-secrets/clear").header("Authorization", "Bearer " + SECRET))
                .andExpect(status().isOk());

        String file = Files.readString(tmp.resolve("settings.json"));
        String row = repo.findById(DicomTlsService.TLS_KEY).orElseThrow().getValue();
        for (String s : new String[]{file, row}) {
            assertFalse(s.contains("legacy-ks-pw") || s.contains("legacy-ts-pw"), s);
        }
        assertTrue(row.contains("/k.p12"), "パスワード以外は残す");
        assertEquals("/k.p12", tls.effective().getKeyStore());
    }

    @Test
    void キーチェーンが無い環境の代わりの経路は設定に保存する() throws Exception {
        mvc.perform(put("/api/internal/dicom/tls-secrets").contentType(MediaType.APPLICATION_JSON)
                        .header("Authorization", "Bearer " + SECRET)
                        .content("{\"trustStorePassword\":\"plain-ts\",\"persistPlaintext\":true}"))
                .andExpect(status().isOk());
        assertTrue(settings.getAll().get(DicomTlsService.TLS_KEY).contains("plain-ts"));
    }
}

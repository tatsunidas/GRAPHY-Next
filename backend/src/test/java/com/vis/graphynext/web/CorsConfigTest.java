/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * {@code graphy.cors.allowed-origin-patterns} の回帰テスト。
 *
 * <p>🔴 2026-08-24 の実機不具合の再発防止。Electron のレンダラ（{@code file://}）は
 * <b>{@code Origin: file://}</b> を送る（{@code "null"} ではない）。しかも Origin を送るのは
 * <b>module script の取得（動的 import）だけ</b>で、通常の fetch/XHR は Origin を送らないため
 * CORS フィルタを素通りする。結果として「アプリ本体は全部動くのに、プラグインの
 * {@code ui.js} だけ 403」という、原因が見えにくい形で現れた
 * （ブラウザ側の表示は {@code TypeError: Failed to fetch dynamically imported module} のみ）。
 */
@WebMvcTest(StatusController.class)
@ActiveProfiles("standalone")
class CorsConfigTest {

    @Autowired
    MockMvc mockMvc;

    @Test
    void allowsElectronFileOrigin() throws Exception {
        // ★これが落ちるとパッケージ版でプラグインの動的 import が 403 になる
        mockMvc.perform(get("/api/status").header("Origin", "file://"))
                .andExpect(status().isOk());
    }

    @Test
    void allowsOpaqueNullOrigin() throws Exception {
        mockMvc.perform(get("/api/status").header("Origin", "null"))
                .andExpect(status().isOk());
    }

    @Test
    void allowsLocalhostDevServer() throws Exception {
        mockMvc.perform(get("/api/status").header("Origin", "http://localhost:5173"))
                .andExpect(status().isOk());
    }

    @Test
    void rejectsForeignOrigin() throws Exception {
        // file:// を足したことで外部サイトまで通るようになっていないこと
        mockMvc.perform(get("/api/status").header("Origin", "https://evil.example.com"))
                .andExpect(status().isForbidden());
    }
}

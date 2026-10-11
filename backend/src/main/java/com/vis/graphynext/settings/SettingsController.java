/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.settings;

import com.vis.graphynext.dicom.DicomTlsService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * アプリ設定 REST。値は文字列の KV。型解釈はフロントの項目定義が持つ。
 *
 * <ul>
 *   <li>{@code GET /api/settings} … 全設定（key→value）</li>
 *   <li>{@code PUT /api/settings} … 部分更新（送ったキーのみ上書き）、更新後の全設定を返す</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/settings")
public class SettingsController {

    private final SettingsService service;
    private final DicomTlsService tls;

    public SettingsController(SettingsService service, DicomTlsService tls) {
        this.service = service;
        this.tls = tls;
    }

    /** 🔴 {@code dicom.tls} のパスワードは返さない（画面と同じ場所で動くプラグインからも読めるため）。 */
    @GetMapping
    public Map<String, String> getAll() {
        return redacted(service.getAll());
    }

    /**
     * 🔴 プラグイン導入の同意（{@link SettingsService#PLUGIN_INSTALL_ENABLED_KEY}）はここでは変えさせない。
     * この口はレンダラ（同じ realm で動くプラグインも）から自由に呼べるので、同意を書けると
     * 利用者の了承なしに導入を開けてしまう。変えるのは Electron main が確認ダイアログのあとに
     * 呼ぶ {@code /api/internal/plugin-manager/opt-in} だけ。
     */
    @PutMapping
    public Map<String, String> update(@RequestBody Map<String, String> updates) {
        if (updates != null && updates.containsKey(SettingsService.PLUGIN_INSTALL_ENABLED_KEY)) {
            throw new IllegalArgumentException("プラグイン導入の許可は、環境設定のプラグイン画面から変えてください（デスクトップ版のみ）");
        }
        if (updates != null && updates.containsKey(DicomTlsService.TLS_KEY)) {
            // ここから書けると、伏せて返した JSON をそのまま書き戻してパスワードを消してしまう
            throw new IllegalArgumentException("TLS の設定は環境設定の DICOM 通信の画面から変えてください");
        }
        return redacted(service.putAll(updates));
    }

    private Map<String, String> redacted(Map<String, String> all) {
        if (all.containsKey(DicomTlsService.TLS_KEY)) {
            all.put(DicomTlsService.TLS_KEY, tls.redact(all.get(DicomTlsService.TLS_KEY)));
        }
        return all;
    }
}

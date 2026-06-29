/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.settings;

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

    public SettingsController(SettingsService service) {
        this.service = service;
    }

    @GetMapping
    public Map<String, String> getAll() {
        return service.getAll();
    }

    @PutMapping
    public Map<String, String> update(@RequestBody Map<String, String> updates) {
        return service.putAll(updates);
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.store;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * プラグイン保存領域の REST（host API の H8）。
 *
 * <ul>
 *   <li>{@code GET /api/plugin-store/{pluginId}/{patientKey}} … 読み出し（未保存でも 200・空）</li>
 *   <li>{@code PUT /api/plugin-store/{pluginId}/{patientKey}} … 保存（楽観ロック。版が古ければ 409）</li>
 *   <li>{@code DELETE /api/plugin-store/{pluginId}/{patientKey}} … 削除</li>
 * </ul>
 *
 * <p>プラグイン配信（{@code /api/plugins/...}）とは**別の経路**にしてある。配信は読み取り専用の
 * 静的配布で、こちらは患者データの読み書き。混ぜると権限の話がややこしくなる。
 *
 * <p>{@code patientKey} は PatientID 由来で {@code /} 等が入り得るので、
 * 呼び出し側は必ず URL エンコードして渡す。
 */
@RestController
@RequestMapping("/api/plugin-store")
public class PluginDocumentController {

    private final PluginDocumentService service;

    public PluginDocumentController(PluginDocumentService service) {
        this.service = service;
    }

    @GetMapping("/{pluginId}/{patientKey}")
    public PluginDocumentDto get(@PathVariable String pluginId, @PathVariable String patientKey) {
        return service.get(pluginId, patientKey);
    }

    @PutMapping("/{pluginId}/{patientKey}")
    public PluginDocumentDto save(
            @PathVariable String pluginId,
            @PathVariable String patientKey,
            @RequestBody SavePluginDocumentRequest req) {
        return service.save(pluginId, patientKey, req);
    }

    @DeleteMapping("/{pluginId}/{patientKey}")
    public void delete(@PathVariable String pluginId, @PathVariable String patientKey) {
        service.delete(pluginId, patientKey);
    }
}

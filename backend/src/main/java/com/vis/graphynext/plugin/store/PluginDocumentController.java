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
import org.springframework.web.bind.annotation.RequestParam;
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
 * <h3>🔴 キーはパスではなくクエリで渡す（{@code ?patientKey=...}）</h3>
 * PatientID には {@code /} が普通に入る。URL エンコードして {@code %2F} にしても
 * <b>Tomcat が経路の段で 400 を返す</b>（既定で符号化スラッシュを拒否する）ので、
 * <b>その患者だけプラグインの保存領域が使えない</b>——しかも Spring まで届かないため
 * CORS ヘッダも付かず、ブラウザには「CORS エラー」に見える（実測・2026-08-26）。
 * パス版は互換のために残すが、{@code /} を含むキーは表現できない。
 */
@RestController
@RequestMapping("/api/plugin-store")
public class PluginDocumentController {

    private final PluginDocumentService service;

    public PluginDocumentController(PluginDocumentService service) {
        this.service = service;
    }

    /** 正。キーはクエリで渡す（{@code /} を含むキーはこちらでしか表現できない）。 */
    @GetMapping("/{pluginId}")
    public PluginDocumentDto getByQuery(@PathVariable String pluginId, @RequestParam String patientKey) {
        return service.get(pluginId, patientKey);
    }

    @PutMapping("/{pluginId}")
    public PluginDocumentDto saveByQuery(
            @PathVariable String pluginId,
            @RequestParam String patientKey,
            @RequestBody SavePluginDocumentRequest req) {
        return service.save(pluginId, patientKey, req);
    }

    @DeleteMapping("/{pluginId}")
    public void deleteByQuery(@PathVariable String pluginId, @RequestParam String patientKey) {
        service.delete(pluginId, patientKey);
    }

    /** 互換のためのパス版。**{@code /} を含むキーには使えない**。 */
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

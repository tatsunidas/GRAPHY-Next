/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * インストール台帳（{@code <pluginsDir>/installed.json}）の 1 エントリ。
 *
 * <p>実行レイヤの folder 走査だけでは分からない「どこから来たか・完全性・有効か」を保持し、
 * 一覧／更新／再インストール／有効無効の根拠にする。設計: fw/plugin-manager-design.md。
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record InstalledPlugin(
        String id,
        String name,
        String version,
        /** 取得元。 */
        Source source,
        /** 導入した zip の SHA-256（完全性の再検証に使う）。 */
        String sha256,
        /** 有効か（{@code .disabled} マーカーの有無と同期）。 */
        boolean enabled,
        /** 自動更新の対象外にするか。 */
        boolean pinned,
        /** 導入日時（ISO-8601 文字列）。 */
        String installedAt,
        /** 信頼ティア: verified / community / local。 */
        String trust) {

    /**
     * 取得元。
     *
     * @param type {@code github} / {@code file} / {@code index}
     * @param ref  github なら {@code owner/repo}、file ならアップロード時のファイル名
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Source(String type, String ref) {}
}

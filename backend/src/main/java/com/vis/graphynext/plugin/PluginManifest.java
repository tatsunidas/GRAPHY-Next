/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * {@code GET /api/plugins} が返すマニフェスト（フロントとの契約）。
 * standalone / web 両モードで同一形。設計は fw/plugin-architecture.md。
 *
 * <p>フロントの {@code frontend/src/plugins/pluginTypes.ts} の {@code PluginManifest} と対応。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PluginManifest(
        String id,
        String name,
        String version,
        Frontend frontend,
        Backend backend,
        /**
         * 要求権限。**JAR の有無に関わらず常に載せる。**
         *
         * <p>かつては {@code Backend.permissions} にしか載らず、{@code entrypoint} を持たない
         * UI 完結プラグインでは値がフロントへ届かなかった。外部送信のように実行時に
         * 強制したい権限（{@code ai-egress}）は UI 完結プラグインこそが要求するため、
         * それでは強制のしようが無い。フロントの実行時チェックはこの項目を見る。
         */
        List<String> permissions) {

    /** フロント面（UI バンドル）。UI を持たないプラグインでは null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Frontend(String bundleUrl, List<String> contributes) {}

    /** バックエンド面（Java 実装）。UI 完結プラグインでは null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Backend(String entrypoint, List<String> permissions) {}
}

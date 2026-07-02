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
        Backend backend) {

    /** フロント面（UI バンドル）。UI を持たないプラグインでは null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Frontend(String bundleUrl, List<String> contributes) {}

    /** バックエンド面（Java 実装）。UI 完結プラグインでは null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Backend(String entrypoint, List<String> permissions) {}
}

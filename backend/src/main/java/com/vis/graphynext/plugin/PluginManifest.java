/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Set;

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
        List<String> permissions,
        /**
         * メニューでの束ね先。{@link #KNOWN_CATEGORIES} に無い値は null にして配る
         * （フロントは未知の値を見ずに済み、今までどおり平置きになる）。
         */
        String category,
        /** AI アシスタントに渡すツール（検査済み。無ければ null）。 */
        List<AiToolSpec> aiTools,
        /** AI アシスタントに渡すスキル（backend が形・大きさを検査済み。無ければ null）。手順の中身は main とアシスタント窓が検査する。 */
        List<java.util.Map<String, Object>> skills) {

    /** skills を持たないマニフェスト（既存の呼び出し側・テスト用）。 */
    public PluginManifest(String id, String name, String version, Frontend frontend, Backend backend,
                          List<String> permissions, String category, List<AiToolSpec> aiTools) {
        this(id, name, version, frontend, backend, permissions, category, aiTools, null);
    }

    /** aiTools を持たないマニフェスト（既存の呼び出し側・テスト用）。 */
    public PluginManifest(String id, String name, String version, Frontend frontend, Backend backend,
                          List<String> permissions, String category) {
        this(id, name, version, frontend, backend, permissions, category, null, null);
    }

    /** 本体が束ね方を知っている category。足すときはフロントの {@code PluginCategory} も足す。 */
    public static final Set<String> KNOWN_CATEGORIES = Set.of("ai");

    /** フロント面（UI バンドル）。UI を持たないプラグインでは null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Frontend(String bundleUrl, List<String> contributes) {}

    /** バックエンド面（Java 実装）。UI 完結プラグインでは null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Backend(String entrypoint, List<String> permissions) {}
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.List;

/**
 * 各プラグインフォルダ直下の {@code plugin.json}（ディスク上の記述）。
 * これを {@link PluginManifest}（配信形）へ変換する。
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record PluginDescriptor(
        String id,
        String name,
        String version,
        /** 出す先サーフェス（viewer2d.menu / viewer2d.toolbar / mainscreen.menu）。 */
        List<String> contributes,
        /** UI バンドルのファイル名（フォルダ直下）。UI が無ければ null。 */
        String ui,
        /** バックエンド実装クラスの完全修飾名（GraphyPlugin 実装）。無ければ null。 */
        String entrypoint,
        /** 要求権限（情報用）。 */
        List<String> permissions) {
}

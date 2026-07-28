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
 *
 * <p>末尾のフィールド（{@code engines} 以降）はプラグインマネージャ用の加算（すべて任意）。
 * 既存プラグインは未指定でよく、{@code @JsonIgnoreProperties(ignoreUnknown=true)} で前方互換。
 * 設計: fw/plugin-manager-design.md。
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
        List<String> permissions,
        /** 互換宣言。例 {@code {"graphy": ">=0.2.0 <0.3.0", "os": ["win32","linux"]}}。 */
        Engines engines,
        /** 説明（マネージャ一覧の表示用）。 */
        String description,
        /** 作者（表示用）。 */
        String author,
        /** ホームページ URL（表示用）。 */
        String homepage,
        /** ライセンス識別子（SPDX 等、表示・法務用）。 */
        String license) {

    /**
     * 互換宣言。
     *
     * <p>GRAPHY-Next は OS ごとにリリースを分けて配布しており、プラグインも JNI/ネイティブ
     * バイナリを含めば OS 専用になる。{@code os} で対応 OS を宣言させ、導入前に実行中の OS と
     * 突き合わせる（未宣言＝OS 非依存とみなし全 OS 可）。トークンは Node 互換の
     * {@code win32} / {@code darwin} / {@code linux}（{@code windows} / {@code mac} 等の別名も受理）。
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Engines(
            /** コア互換範囲。例 {@code ">=0.2.0 <0.3.0"}。未指定は常に互換。 */
            String graphy,
            /** 対応 OS。未指定/空は OS 非依存。 */
            List<String> os) {
    }
}

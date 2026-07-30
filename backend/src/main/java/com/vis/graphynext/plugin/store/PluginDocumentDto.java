/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.store;

/**
 * プラグイン保存領域の読み出し結果（H8）。
 *
 * <p>未保存でも 200 で {@code json = null} を返す（フロントに「404 なら空」という分岐を
 * 書かせない）。{@code version} は保存時にそのまま返してもらうための札。
 */
public record PluginDocumentDto(
        String pluginId,
        String patientKey,
        String json,
        String updatedAt,
        Long version) {
}

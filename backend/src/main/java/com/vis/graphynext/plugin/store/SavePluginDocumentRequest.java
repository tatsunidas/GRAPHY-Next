/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.store;

/**
 * プラグイン保存領域への保存要求（H8）。
 *
 * @param json    保存する JSON（中身は解釈しない）
 * @param version 読み出し時に受け取った版。**初回保存では null**。
 *                既に保存があるのに null を送るのは「読まずに上書き」なので拒否する。
 */
public record SavePluginDocumentRequest(String json, Long version) {
}

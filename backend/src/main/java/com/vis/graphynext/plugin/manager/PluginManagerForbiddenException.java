/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

/**
 * このモード/設定では導入系操作が許可されていない（web モード、またはマネージャ無効）ことを表す。
 * コントローラは 403 に写像する。web は共有サーバーのため運営キュレーション前提
 * （fw/plugin-architecture.md §3）。
 */
public class PluginManagerForbiddenException extends RuntimeException {
    public PluginManagerForbiddenException(String message) {
        super(message);
    }
}

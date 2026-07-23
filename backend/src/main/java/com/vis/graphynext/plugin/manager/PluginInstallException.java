/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

/**
 * プラグイン導入が検証で弾かれた（sha256 不一致・非互換・不正 zip・不正 id など）ことを表す。
 * コントローラは 422 系に写像する。
 */
public class PluginInstallException extends RuntimeException {
    public PluginInstallException(String message) {
        super(message);
    }
}

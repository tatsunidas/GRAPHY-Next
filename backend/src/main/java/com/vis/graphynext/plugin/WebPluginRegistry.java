/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import java.util.Map;

/**
 * web モードのプラグインレジストリ。
 *
 * <p>共有サーバーのため、ユーザーによる任意 JAR ロードは行わない。運営が配備した
 * フォルダのマニフェスト一覧と UI バンドルを配信するのみ（フロント面は standalone と同じ契約）。
 *
 * <p>バックエンド面の実行は、共有 JVM への任意コードロードを避けるため本スケルトンでは無効。
 * 将来は別プロセス / コンテナ（gVisor 等）/ サイドカーで隔離実行する（fw/plugin-architecture.md §3）。
 * UI 完結（フロント面のみ）のプラグインは web でもそのまま動作する。
 */
@Service
@Profile("web")
public class WebPluginRegistry extends FileSystemPluginRegistry {

    public WebPluginRegistry(ObjectMapper mapper, PluginProperties props) {
        super(mapper, props.isEnabled(), props.getDir());
    }

    @Override
    protected String modeName() {
        return "web";
    }

    @Override
    public Object run(String id, Map<String, Object> payload) {
        // 存在確認だけ行い、実行はサンドボックス実装まで拒否する。
        discover(id).orElseThrow(() -> new java.util.NoSuchElementException("plugin not found: " + id));
        throw new UnsupportedOperationException(
                "web mode: backend plugin execution is disabled (sandbox pending)");
    }
}

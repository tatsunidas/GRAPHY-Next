/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 最小構成の動作確認用エンドポイント。
 *
 * <p>{@code GET /api/status} は現在アクティブなプロファイル（web / standalone）と
 * バージョンを返す。フロントエンド（ブラウザ / Electron）はこの値を表示することで、
 * どのモードで起動したかを画面上で確認できる。
 */
@RestController
@RequestMapping("/api")
public class StatusController {

    private final Environment env;
    private final String version;

    public StatusController(Environment env,
                            @Value("${graphy.version:dev}") String version) {
        this.env = env;
        this.version = version;
    }

    @GetMapping("/status")
    public Map<String, Object> status() {
        List<String> profiles = List.of(env.getActiveProfiles());
        String mode = profiles.isEmpty() ? "web" : profiles.get(0);
        return Map.of(
                "app", "GRAPHY-Next",
                "version", version,
                "mode", mode,
                "activeProfiles", profiles,
                "javaVersion", System.getProperty("java.version")
        );
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext;

import com.vis.graphynext.startup.StartupProgressListener;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * GRAPHY-Next バックエンドのエントリポイント。
 *
 * <p>起動モードは Spring プロファイルで切り替える。
 * <ul>
 *   <li>{@code web}        … ブラウザ向け Web アプリ（将来: 外部 dcm4chee と連携）</li>
 *   <li>{@code standalone} … Electron デスクトップ（将来: 組み込み DICOM / Derby）</li>
 * </ul>
 * プロファイル未指定時は {@code application.yml} の既定（web）で起動する。
 */
@SpringBootApplication
public class GraphyNextApplication {

    public static void main(String[] args) {
        SpringApplication app = new SpringApplication(GraphyNextApplication.class);
        // ImageJ ブリッジ（GUI 表示）用: ディスプレイがあれば AWT headless を無効化する。
        // Spring Boot は既定で java.awt.headless=true を強制するため、これをしないと
        // GraphicsEnvironment.isHeadless() が常に true になり ImageJ を起動できない
        // （standalone/Electron でも "requires a display" になる）。実ディスプレイが無い
        // サーバ（web デプロイ等）では headless=true のままにして誤起動を防ぐ。
        app.setHeadless(!hasDisplay());
        // standalone のスプラッシュ向けに起動進捗を stdout へ出すリスナー（早い段階のイベントを拾う）
        app.addListeners(new StartupProgressListener());
        app.run(args);
    }

    /** GUI 表示可能な環境か（Linux は DISPLAY/WAYLAND、mac/win はデスクトップ前提で true）。 */
    private static boolean hasDisplay() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("linux") || os.contains("nix") || os.contains("nux")) {
            return notBlank(System.getenv("DISPLAY")) || notBlank(System.getenv("WAYLAND_DISPLAY"));
        }
        return true; // macOS / Windows はデスクトップ前提
    }

    private static boolean notBlank(String s) {
        return s != null && !s.isBlank();
    }
}

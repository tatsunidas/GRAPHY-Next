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
        // standalone のスプラッシュ向けに起動進捗を stdout へ出すリスナー（早い段階のイベントを拾う）
        app.addListeners(new StartupProgressListener());
        app.run(args);
    }
}

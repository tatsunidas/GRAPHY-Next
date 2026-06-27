package com.vis.graphynext;

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
        SpringApplication.run(GraphyNextApplication.class, args);
    }
}

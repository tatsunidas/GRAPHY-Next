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
        preventDnsLookupOnDatabaseOpen();
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

    /**
     * H2 の自動サーバーモードが DB を開くたびに行う名前解決を止める。
     *
     * <p>接続 URL の {@code AUTO_SERVER=TRUE}（{@code application.yml} / 登録者 DB）は、DB を開くとき
     * {@code org.h2.engine.Database#startServer} から
     * <ol>
     *   <li>{@code NetUtils.getLocalAddress()} → {@code InetAddress.getLocalHost()}（自ホスト名の<b>正引き</b>）</li>
     *   <li>{@code NetUtils.getHostName(...)} → その IP の<b>逆引き</b>（PTR）</li>
     * </ol>
     * を必ず呼ぶ。DNS サーバーが設定されているのに到達できない環境
     * （＝LAN には繋がっているがインターネットが無い・captive portal・持ち出し PC など）では、
     * この 2 回がどちらも OS のリゾルバのタイムアウトまでブロックし、
     * Windows では合計 30〜60 秒 起動が伸びる。スプラッシュが「データベース」の段階で固まり、
     * Electron 側のヘルスチェックがタイムアウトして「起動に失敗しました」と出る症状の正体がこれ。
     *
     * <p>バインドアドレスを明示すると H2 は {@code getLocalHost()} を呼ばず、逆引きも
     * {@code "localhost"}（hosts で即決）になるため、名前解決そのものが発生しなくなる。
     * {@code AUTO_SERVER} は有効なままなので、同一マシンからの後付け接続
     * （{@code deploy/demo/lib-h2.sh} など）は従来どおり動く。ついでに自動サーバーの待ち受けが
     * ループバックに限定され、LAN へ H2 が晒されなくなる。
     *
     * <p>明示的に {@code -Dh2.bindAddress=...} を渡した場合はそちらを尊重する。
     */
    private static void preventDnsLookupOnDatabaseOpen() {
        if (System.getProperty("h2.bindAddress") == null) {
            System.setProperty("h2.bindAddress", "127.0.0.1");
        }
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

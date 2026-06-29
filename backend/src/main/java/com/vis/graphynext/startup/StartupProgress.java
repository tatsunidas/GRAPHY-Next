/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.startup;

/**
 * 起動進捗を stdout に構造化行として出力する。Electron(スプラッシュ)がこの行を読んで表示する。
 *
 * <p>形式: 1 行に {@code __GRAPHY_PROGRESS__{"step":"..","state":"..","message":".."}}。
 * HTTP サーバが立ち上がる前の早い段階（フォルダ確認・DB マイグレーション）から使えるよう、
 * あえて stdout を使う（Electron が子プロセスの stdout を読む）。
 */
public final class StartupProgress {

    public static final String PREFIX = "__GRAPHY_PROGRESS__";

    private StartupProgress() {
    }

    /**
     * @param step    段階の識別子（folders / database / plugins / scp / ready など）
     * @param state   running | ok | error
     * @param message 画面表示用メッセージ
     */
    public static void report(String step, String state, String message) {
        String json = "{\"step\":\"" + esc(step) + "\",\"state\":\"" + esc(state)
                + "\",\"message\":\"" + esc(message) + "\"}";
        System.out.println(PREFIX + json);
        System.out.flush();
    }

    private static String esc(String s) {
        if (s == null) {
            return "";
        }
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

/**
 * 外へ送るコードの検査。設計: fw/remote-compute-design.md §5.1。
 *
 * <p>🔴 <b>これは完全な防御ではない。</b> プラグインの JS は生の画素を読める（H3）ので、それを
 * コードの文字列に埋め込めば匿名化を通らずに外へ出せてしまう。ここで弾くのは<b>大きなデータを
 * 埋め込んだと思われるコード</b>だけで、残りは「同意画面にコードの全文を出す」「監査ログ」
 * 「信頼したプラグインだけに許す」で抑える。
 *
 * <p>見るもの: 長さ・base64 らしい長い連なり・数字の長い並び（画素を数値の配列で書いたもの）。
 */
final class CodeInspector {

    /** ジョブ型の上限（文字数）。 */
    static final int MAX_JOB_CHARS = 64 * 1024;
    /** 埋め込みとみなす連なりの合計の上限（文字数）。 */
    static final int MAX_EMBEDDED_CHARS = 4096;
    /** base64 の字だけの連なりがこれ以上なら「埋め込み」に数える。 */
    static final int BASE64_RUN = 200;
    /** 数字と区切り（{@code , . - 空白}）だけの連なりがこれ以上なら「埋め込み」に数える。 */
    static final int NUMERIC_RUN = 400;

    private CodeInspector() {
    }

    /** 拒否の理由（コード）。問題なければ null。 */
    static String inspect(String code, int maxChars) {
        if (code == null || code.isBlank()) {
            return "code-empty";
        }
        if (code.length() > maxChars) {
            return "code-too-large";
        }
        if (embeddedChars(code) > MAX_EMBEDDED_CHARS) {
            return "code-embedded-data";
        }
        return null;
    }

    /** 埋め込みに見える連なり（base64 らしいもの・数字の並び）の長さの合計。 */
    static int embeddedChars(String code) {
        return runs(code, BASE64_RUN, true) + runs(code, NUMERIC_RUN, false);
    }

    private static int runs(String code, int min, boolean base64) {
        int total = 0;
        int run = 0;
        for (int i = 0; i < code.length(); i++) {
            char c = code.charAt(i);
            boolean in = base64 ? isBase64(c) : isNumeric(c);
            if (in) {
                run++;
            } else {
                total += run >= min ? run : 0;
                run = 0;
            }
        }
        return total + (run >= min ? run : 0);
    }

    private static boolean isBase64(char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                || c == '+' || c == '/' || c == '=' || c == '-' || c == '_';
    }

    private static boolean isNumeric(char c) {
        return (c >= '0' && c <= '9') || c == ',' || c == '.' || c == '-' || c == ' ';
    }
}

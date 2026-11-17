/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.emr;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 電子カルテ連携の設定（保存値 {@code emr.watch.*} から読む）。<b>取得元の既定値は置かない</b>（施設の運用で決まる）。
 * 有効なのに必須の項目が空・不正なら、{@link #errors} にコードを入れる（動かさない。黙って別の意味にしない）。
 *
 * <p>電子カルテが「いま開いている患者の ID」を書き出すファイル（CSV か bat）を読む設定と、ID が変わったときに
 * PACS から過去検査を取り込む設定をまとめる。端末ごとの設定なので、DB フォルダごとではなく共通の設定ファイルに置く。
 *
 * @param path       ファイル、またはフォルダ（フォルダなら更新が最も新しい許可拡張子のファイル）
 * @param format     {@code csv}／{@code bat}／{@code auto}（拡張子で決める: .bat・.cmd は bat、それ以外は csv）
 * @param charset    {@code UTF-8}／{@code Shift_JIS}
 * @param csvColumn  CSV の患者 ID の列（見出しの名前、または 1 から数えた番号）
 * @param csvHeader  CSV の 1 行目が見出しか
 * @param batVar     bat の変数名（{@code set 変数名=ID} の最後の出現を読む）
 * @param autoOpen   ID が変わったら 2D ビューアまで自動で開くか
 * @param retrieve   {@code move}／{@code get}
 * @param years      過去検査を遡る年数（null=制限なし）
 */
public record EmrConfig(
        boolean enabled, String path, String format, String charset, String csvColumn, boolean csvHeader,
        String batVar, boolean autoOpen, String pacsAe, String retrieve, Integer years, Integer timeoutSec,
        List<String> errors) {

    public static final String P = "emr.watch.";
    public static final String KEY_ENABLED = P + "enabled";
    public static final String KEY_PATH = P + "path";
    public static final String KEY_FORMAT = P + "format";
    public static final String KEY_CHARSET = P + "charset";
    public static final String KEY_CSV_COLUMN = P + "csv.column";
    public static final String KEY_CSV_HEADER = P + "csv.header";
    public static final String KEY_BAT_VAR = P + "bat.var";
    public static final String KEY_AUTO_OPEN = P + "autoOpen";
    public static final String KEY_PACS_AE = P + "pacs.ae";
    public static final String KEY_RETRIEVE = P + "retrieve";
    public static final String KEY_YEARS = P + "years";
    public static final String KEY_TIMEOUT = P + "timeoutSec";

    public boolean valid() {
        return errors.isEmpty();
    }

    public static EmrConfig from(Map<String, String> all) {
        List<String> err = new ArrayList<>();
        boolean enabled = "true".equals(str(all, KEY_ENABLED));
        Integer years = intOrNull(all, KEY_YEARS, "years-invalid", err);
        Integer timeout = intOrNull(all, KEY_TIMEOUT, "timeout-invalid", err);
        EmrConfig c = new EmrConfig(enabled, str(all, KEY_PATH), str(all, KEY_FORMAT), str(all, KEY_CHARSET),
                str(all, KEY_CSV_COLUMN), !"false".equals(str(all, KEY_CSV_HEADER)), str(all, KEY_BAT_VAR),
                "true".equals(str(all, KEY_AUTO_OPEN)), str(all, KEY_PACS_AE), str(all, KEY_RETRIEVE), years, timeout,
                err);
        if (enabled) {
            c.requireInto(err);
        }
        return c;
    }

    private void requireInto(List<String> err) {
        if (path == null) {
            err.add("path-required");
        }
        if (format == null || !List.of("csv", "bat", "auto").contains(format)) {
            err.add("format-required");
        }
        if (!"UTF-8".equals(charset) && !"Shift_JIS".equals(charset)) {
            err.add("charset-required");
        }
        boolean needColumn = "csv".equals(format);
        boolean needVar = "bat".equals(format);
        if ("auto".equals(format)) {
            needColumn = csvColumn == null && batVar == null; // どちらか 1 つは要る
            needVar = false;
            if (needColumn) {
                err.add("column-or-var-required");
                needColumn = false;
            }
        }
        if (needColumn && csvColumn == null) {
            err.add("csv-column-required");
        }
        if (needVar && batVar == null) {
            err.add("bat-var-required");
        }
        if (pacsAe == null) {
            err.add("pacs-ae-required");
        }
        if (!"move".equals(retrieve) && !"get".equals(retrieve)) {
            err.add("retrieve-required");
        }
        if (timeoutSec == null) {
            err.add("timeout-required");
        }
    }

    private static String str(Map<String, String> m, String k) {
        String v = m.get(k);
        return v == null || v.isBlank() ? null : v.trim();
    }

    private static Integer intOrNull(Map<String, String> m, String k, String code, List<String> err) {
        String v = str(m, k);
        if (v == null) {
            return null;
        }
        try {
            int n = Integer.parseInt(v);
            if (n < 1) {
                err.add(code);
                return null;
            }
            return n;
        } catch (NumberFormatException e) {
            err.add(code);
            return null;
        }
    }
}

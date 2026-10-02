/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import java.util.List;
import java.util.Map;

/**
 * 1 回の {@code execute_request} の結果。
 *
 * @param status         {@code ok} / {@code error} / {@code aborted}
 * @param stdout         stdout に流れた全文
 * @param stderr         stderr に流れた全文
 * @param outputs        {@code execute_result} と {@code display_data} の data（MIME → 値）。届いた順
 * @param errorName      {@code error} のとき例外名（{@code ename}）
 * @param errorValue     {@code error} のとき例外の値（{@code evalue}）
 * @param traceback      {@code error} のときのトレースバック（ANSI の色指定は除いたもの）
 * @param executionCount カーネルの実行番号（無ければ null）
 */
public record ExecutionResult(String status, String stdout, String stderr, List<Map<String, String>> outputs,
                              String errorName, String errorValue, List<String> traceback,
                              Integer executionCount) {

    public boolean ok() {
        return "ok".equals(status);
    }

    /** 最初の出力の {@code text/plain}（式の値など）。無ければ null。 */
    public String textPlain() {
        for (Map<String, String> o : outputs) {
            String t = o.get("text/plain");
            if (t != null) {
                return t;
            }
        }
        return null;
    }
}

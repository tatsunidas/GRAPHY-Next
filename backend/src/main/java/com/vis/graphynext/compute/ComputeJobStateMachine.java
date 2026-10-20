/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import java.util.EnumSet;
import java.util.Map;
import java.util.Set;

/**
 * 計算ジョブ 1 件の状態遷移と失敗理由の分類（台帳 {@link ComputeJobRecord} の状態）。純関数だけ。
 *
 * <p>表に無い遷移は {@link IllegalStateException}（呼び出し側の取り違えを黙って通さない）。
 * 終わった状態（DONE / FAILED / CANCELLED / INTERRUPTED）からは出られない——再実行は別の試行として新しい行にする。
 */
final class ComputeJobStateMachine {

    private ComputeJobStateMachine() {
    }

    enum State {
        /** 承認済みで計算機の列の順番待ち。 */
        QUEUED,
        /** 実行中（段は phase で持つ）。 */
        RUNNING,
        /** 計算機へは渡したが、実行は利用者が別の画面で行う（外部ノートブック。段 2 以降で使う）。 */
        AWAITING_USER,
        DONE,
        FAILED,
        CANCELLED,
        /** アプリの再起動・異常終了で途中のまま終わった。 */
        INTERRUPTED;

        boolean ended() {
            return this == DONE || this == FAILED || this == CANCELLED || this == INTERRUPTED;
        }
    }

    /** 失敗の理由（画面で訳すコード）。 */
    enum Reason {
        /** Python の例外（名前と値を別に持つ）。 */
        CODE_ERROR("code-error"),
        TIMEOUT("timeout"),
        /** 計算機に届かない（接続・WebSocket・登録の解除）。入力のせいではない。 */
        ENDPOINT_UNREACHABLE("endpoint-unreachable"),
        /** 承認のあとで中身が違う。 */
        DATASET_CHANGED("dataset-changed"),
        DATASET_EXPIRED("dataset-expired"),
        OUTPUTS_TOO_LARGE("outputs-too-large"),
        /** 再起動で中断。 */
        INTERRUPTED("interrupted"),
        INTERNAL("internal");

        final String code;

        Reason(String code) {
            this.code = code;
        }
    }

    private static final Map<State, Set<State>> NEXT = Map.of(
            State.QUEUED, EnumSet.of(State.RUNNING, State.CANCELLED, State.INTERRUPTED),
            State.RUNNING, EnumSet.of(State.DONE, State.FAILED, State.CANCELLED, State.AWAITING_USER, State.INTERRUPTED),
            State.AWAITING_USER, EnumSet.of(State.RUNNING, State.DONE, State.FAILED, State.CANCELLED, State.INTERRUPTED),
            State.DONE, EnumSet.noneOf(State.class),
            State.FAILED, EnumSet.noneOf(State.class),
            State.CANCELLED, EnumSet.noneOf(State.class),
            State.INTERRUPTED, EnumSet.noneOf(State.class));

    static boolean allowed(State from, State to) {
        return NEXT.get(from).contains(to);
    }

    /** {@code from} から {@code to} へ移る。表に無ければ例外。 */
    static State move(State from, State to) {
        if (!allowed(from, to)) {
            throw new IllegalStateException("illegal compute job transition: " + from + " -> " + to);
        }
        return to;
    }

    /**
     * 実行の途中で投げられた例外を理由に分類する。メッセージは {@link ComputeJobRunner} が投げるもの
     * （{@code timeout after Ns} など）に合わせる。接続の失敗は {@code JupyterException} と入出力の例外。
     */
    static Reason classify(Throwable e) {
        Throwable t = e;
        while (t.getCause() != null && t.getCause() != t) {
            t = t.getCause();
        }
        String m = String.valueOf(e.getMessage());
        if (m.startsWith("timeout after")) {
            return Reason.TIMEOUT;
        }
        if (m.startsWith("dataset changed after approval")) {
            return Reason.DATASET_CHANGED;
        }
        if (m.startsWith("dataset expired")) {
            return Reason.DATASET_EXPIRED;
        }
        if (m.startsWith("too many output files") || m.startsWith("outputs too large")) {
            return Reason.OUTPUTS_TOO_LARGE;
        }
        if (m.startsWith("endpoint no longer registered") || m.startsWith("destination-changed")
                || e instanceof JupyterException || t instanceof java.io.IOException
                || t instanceof java.util.concurrent.TimeoutException) {
            return Reason.ENDPOINT_UNREACHABLE;
        }
        return Reason.INTERNAL;
    }
}

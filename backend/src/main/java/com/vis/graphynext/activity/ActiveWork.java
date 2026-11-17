/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.activity;

/**
 * 「いま走っている・待っている処理」を持つ Service が実装する。アプリを終わらせる前に
 * （Electron main が {@code /api/internal/activity} で）一覧を出し、利用者が「中止して終了」を選んだら
 * {@link #cancelAll()} で止める。
 *
 * <p>実装は軽く（ロックを長く取らず、Map を数えるだけ）、例外を投げないこと。
 */
public interface ActiveWork {

    /** 種類のキー（画面の文言の引き当てに使う。例 {@code "import"}、{@code "export"}）。 */
    String kind();

    /** 実行中・待ちの件数。終わった（完了・失敗・中止）ものは数えない。 */
    int activeCount();

    /** 実行中・待ちを全部中止する。既存の cancel をそのまま呼ぶ（書きかけの削除などの後始末も既存のまま）。 */
    void cancelAll();

    /** 中止の口があるか。無いもの（QR の取得など）は件数を出すだけで、終了時は終わるのを待たず止める。 */
    default boolean cancellable() {
        return true;
    }
}

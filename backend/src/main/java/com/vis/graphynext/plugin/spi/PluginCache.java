/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.spi;

/**
 * JAR プラグインが使える、<b>消えてもよい</b>派生データの置き場（H68）。
 *
 * <p>{@link GraphyPlugin#run} の {@code args} の {@code "__cache"} に入る（非同期ジョブのときだけ。
 * 同期の {@code run} では入らないので、無ければ何もしない書き方にすること）。プラグインの id に束縛済みで、
 * 他のプラグインの項目は見えない。JDK の型だけで作ってある。
 *
 * <p>🔴 <b>いつでも消える</b>: 上限・再起動・アプリの更新・利用者の操作で消える。唯一のコピーを置かないこと。
 * 失敗は例外でなく戻り値（{@code null}/{@code false}）で返る。
 */
public interface PluginCache {

    /** 保存した値。無い・壊れている・消えたときは null。 */
    byte[] get(String key);

    /** 保存する。大きすぎる（1 件の上限）・鍵が不正・書けなかったときは false。 */
    boolean put(String key, byte[] data);

    boolean has(String key);

    void remove(String key);

    /** 長い計算の途中結果。同じ {@code jobKey} で再投入されたとき、済んだ部分を読んで続きから計算するために使う。 */
    Checkpoint checkpoint(String jobKey);

    interface Checkpoint {
        /** index 番目の部分を保存する（上書き）。 */
        boolean save(int index, byte[] data);

        /** index 番目の部分。無ければ null。 */
        byte[] load(int index);

        /** この jobKey の途中結果をすべて消す（完了したときに呼ぶ）。 */
        void clear();
    }
}

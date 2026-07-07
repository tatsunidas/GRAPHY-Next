/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.system;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

/**
 * バックエンド（Spring Boot / SLF4J）ログの直近分を保持するインメモリ・リングバッファ。
 *
 * <p>{@link SystemLogAppender} が Logback イベントをここへ追記し、{@link SystemLogController}
 * が {@code GET /api/system/logs} で払い出す。これにより DIMSE（C-FIND/C-MOVE/C-STORE 等）や
 * DICOMweb のサーバ側エラーを、フロントの System＞ログ ビューアから参照できる。
 *
 * <p>Logback の appender は Spring 管理外でインスタンス化され得るため、Spring bean 配線に
 * 依存せず使える <b>静的シングルトン</b>とする（JVM 内は 1 プロセスなので十分）。全メソッドは
 * スレッドセーフ。
 */
public final class SystemLogStore {

    /** 1 行分のログ。JSON 応答にそのまま直列化される（record アクセサ名 = JSON キー）。 */
    public record Entry(long seq, long ts, String level, String logger, String message) {
    }

    /** 保持上限（フロントのリングバッファと同等）。超過分は古い順に破棄。 */
    private static final int MAX = 3000;
    private static final AtomicLong SEQ = new AtomicLong(0);
    private static final Deque<Entry> BUF = new ArrayDeque<>(MAX);

    private SystemLogStore() {
    }

    /** 1 行追記する（{@code ts} は epoch ミリ秒）。 */
    public static void add(long ts, String level, String logger, String message) {
        Entry e = new Entry(SEQ.getAndIncrement(), ts, level, logger, message);
        synchronized (BUF) {
            BUF.addLast(e);
            while (BUF.size() > MAX) {
                BUF.pollFirst();
            }
        }
    }

    /**
     * {@code seq > afterSeq} のエントリを古い→新しい順で返す。件数が {@code limit} を超える場合は
     * 新しい方から {@code limit} 件に丸める（フロントは差分ポーリングするため通常は少数）。
     */
    public static List<Entry> since(long afterSeq, int limit) {
        List<Entry> out = new ArrayList<>();
        synchronized (BUF) {
            for (Entry e : BUF) {
                if (e.seq() > afterSeq) {
                    out.add(e);
                }
            }
        }
        if (limit > 0 && out.size() > limit) {
            return new ArrayList<>(out.subList(out.size() - limit, out.size()));
        }
        return out;
    }
}

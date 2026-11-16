/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * 検査（StudyInstanceUID）ごとの取得の排他。定時の事前取得と、電子カルテ連携の先取りが、
 * 同じ検査を同時に取りに行かないようにする（片方が取り終えてから、もう片方は「揃っている」を見て飛ばす）。
 *
 * <p>検査ごとに別のロックなので、別の検査の取得は待たせない。使い終わったロックは表から消える。
 */
public final class StudyFetchLocks {

    private StudyFetchLocks() {
    }

    private static final class Entry {
        final ReentrantLock lock = new ReentrantLock();
        int refs;
    }

    private static final ConcurrentHashMap<String, Entry> LOCKS = new ConcurrentHashMap<>();

    /** 検査のロックを取って {@code body} を実行する。 */
    public static <T> T withLock(String studyUid, Supplier<T> body) {
        Entry e = LOCKS.compute(studyUid, (k, v) -> {
            Entry x = v == null ? new Entry() : v;
            x.refs++;
            return x;
        });
        e.lock.lock();
        try {
            return body.get();
        } finally {
            e.lock.unlock();
            LOCKS.compute(studyUid, (k, v) -> v == null || --v.refs <= 0 ? null : v);
        }
    }

    /** テスト用: 表に残っているロックの数。 */
    static int size() {
        return LOCKS.size();
    }
}

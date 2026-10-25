/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * ビューアで開いている検査（メモリのみ）。検査を開いたウィンドウが登録し、閉じるときに解除する。
 * 同じ検査を複数のウィンドウで開けるので数える。ウィンドウが落ちて解除し損ねた分は、backend の再起動まで
 * 守られたまま残る（安全側。時間切れの数字は置かない）。
 */
@Component
public class InUseRegistry {

    private final Map<String, Integer> counts = new ConcurrentHashMap<>();

    public void register(Collection<String> studyUids) {
        for (String s : studyUids) {
            if (s != null && !s.isBlank()) {
                counts.merge(s, 1, Integer::sum);
            }
        }
    }

    public void release(Collection<String> studyUids) {
        for (String s : studyUids) {
            if (s != null) {
                counts.computeIfPresent(s, (k, v) -> v <= 1 ? null : v - 1);
            }
        }
    }

    public Set<String> snapshot() {
        return new HashSet<>(counts.keySet());
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.activity;

import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 要求が返るまで続く処理（DICOM 送信・DB の編集・レポート保存など、ジョブ ID を持たないもの）の件数。
 * 中止はできない。終了時は「終わるのを待つ」ために数える。
 * 実体は {@link InFlightRequestFilter} が持つ（フィルターは @WebMvcTest のスライスにも入るので、他の Bean に依存させない）。
 */
public class InFlightRequests {

    private final Map<String, AtomicInteger> counts = new ConcurrentHashMap<>();

    public void enter(String kind) {
        counts.computeIfAbsent(kind, k -> new AtomicInteger()).incrementAndGet();
    }

    public void exit(String kind) {
        counts.computeIfPresent(kind, (k, n) -> n.decrementAndGet() <= 0 ? null : n);
    }

    /** 種類 → 件数（0 件の種類は含めない）。 */
    public Map<String, Integer> snapshot() {
        Map<String, Integer> out = new TreeMap<>();
        counts.forEach((k, n) -> {
            int v = n.get();
            if (v > 0) out.put(k, v);
        });
        return out;
    }
}

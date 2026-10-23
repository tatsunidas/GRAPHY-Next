/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import java.util.HashMap;
import java.util.function.Function;

/**
 * {@code DicomAnonymizerEngine} が UID の置換に使う {@code uidMap}（{@code computeIfAbsent(元, 乱数)}）の差し替え。
 *
 * <p>エンジンは {@code computeIfAbsent} しか呼ばないので、それだけを「元の UID だけで決まる値」に
 * 上書きする。エンジンの署名は変えず、手動の匿名化は従来の {@code HashMap}（乱数）のまま。
 * 渡された乱数の生成関数は使わない。
 */
final class ConsistentUidMap extends HashMap<String, String> {

    private static final long serialVersionUID = 1L;

    private final transient ConsistentPseudonyms pseudonyms;

    ConsistentUidMap(ConsistentPseudonyms pseudonyms) {
        this.pseudonyms = pseudonyms;
    }

    @Override
    public String computeIfAbsent(String original, Function<? super String, ? extends String> ignored) {
        return pseudonyms.uid(original);
    }
}

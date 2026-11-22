/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import io.github.tatsunidas.radiomics.main.RadiomicsJ;
import io.github.tatsunidas.radiomics.main.SettingParams;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * RadiomicsJ の設定キーの一覧と既定値（一括抽出の「詳細設定」の入力検査と、既定値の表示に使う）。
 * 既定値は、設定を初期化した直後の RadiomicsJ から読む（{@link RadiomicsJSettingsSnapshot}）。環境設定の値ではない。
 */
final class RadiomicsSettingsSchema {

    /**
     * @param key          RadiomicsJ の設定キー（例 {@code INT_deltaGLCM}）
     * @param type         {@code boolean}・{@code int}・{@code long}・{@code double}・{@code array}・{@code string}（キーの接頭辞から）
     * @param defaultValue 既定値（文字列。RadiomicsJ が既定を持たない（null の）ものは空）。読み出し方が無いキーは null
     */
    record Entry(String key, String type, String defaultValue) {}

    private RadiomicsSettingsSchema() {
    }

    static String typeOf(String key) {
        if (key.startsWith("BOOL_")) return "boolean";
        if (key.startsWith("INT_")) return "int";
        if (key.startsWith("LONG_")) return "long";
        if (key.startsWith("DOUBLE_")) return "double";
        if (key.startsWith("DOUBLEARRAY_") || key.startsWith("INTARRAY_")) return "array";
        return "string";
    }

    /** {@code KEY=value} の行（{@link RadiomicsJSettingsSnapshot} の書式）を、キー → 値にする。 */
    static Map<String, String> parse(String properties) {
        Map<String, String> out = new TreeMap<>();
        for (String line : properties.split("\n")) {
            int eq = line.indexOf('=');
            if (eq > 0) {
                out.put(line.substring(0, eq), line.substring(eq + 1));
            }
        }
        return out;
    }

    static List<Entry> entries() throws Exception {
        Map<String, String> defaults = RadiomicsLock.call(() -> {
            try {
                RadiomicsJ.resetSettings();
                return parse(RadiomicsJSettingsSnapshot.of(new RadiomicsJ()));
            } finally {
                RadiomicsJ.resetSettings();
            }
        });
        List<Entry> out = new ArrayList<>();
        java.util.stream.Stream.of(SettingParams.values()).map(Enum::name).sorted()
                .forEach(k -> out.add(new Entry(k, typeOf(k), defaults.get(k))));
        return out;
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import org.junit.jupiter.api.Test;

import java.time.LocalTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PrefetchConfigTest {

    private static Map<String, String> full() {
        Map<String, String> m = new HashMap<>();
        m.put(PrefetchConfig.KEY_ENABLED, "true");
        m.put(PrefetchConfig.KEY_SOURCE, "csv");
        m.put(PrefetchConfig.KEY_TARGET_DAY, "tomorrow");
        m.put(PrefetchConfig.KEY_TIMES, "18:30, 7:00 18:30");
        m.put(PrefetchConfig.KEY_CSV_FOLDER, "C:/ris");
        m.put(PrefetchConfig.KEY_CSV_CHARSET, "Shift_JIS");
        m.put(PrefetchConfig.KEY_CSV_COL_ID, "患者ID");
        m.put(PrefetchConfig.KEY_PACS_AE, "PACS");
        m.put(PrefetchConfig.KEY_RETRIEVE, "move");
        m.put(PrefetchConfig.KEY_TIMEOUT, "600");
        return m;
    }

    @Test
    void 時刻は昇順で重複なし_4桁の時も読める() {
        var c = PrefetchConfig.from(full());
        assertTrue(c.valid(), c.errors().toString());
        assertEquals(List.of(LocalTime.of(7, 0), LocalTime.of(18, 30)), c.times());
    }

    @Test
    void 空の設定は無効で_有効にしても必須が欠ければ理由が並ぶ() {
        var off = PrefetchConfig.from(Map.of());
        assertFalse(off.enabled());
        assertTrue(off.valid());
        var on = PrefetchConfig.from(Map.of(PrefetchConfig.KEY_ENABLED, "true"));
        assertFalse(on.valid());
        assertTrue(on.errors().containsAll(List.of("source-required", "targetDay-required", "times-required",
                "pacs-ae-required", "retrieve-required", "timeout-required")), on.errors().toString());
    }

    @Test
    void 負例_不正な数と時刻は失敗する_黙って別の意味にしない() {
        Map<String, String> m = full();
        m.put(PrefetchConfig.KEY_YEARS, "0");
        m.put(PrefetchConfig.KEY_MAX_STUDIES, "abc");
        m.put(PrefetchConfig.KEY_TIMES, "25:99");
        var c = PrefetchConfig.from(m);
        assertTrue(c.errors().containsAll(List.of("years-invalid", "maxStudies-invalid", "times-invalid")),
                c.errors().toString());
    }

    @Test
    void CSVの文字コードは2種類だけ() {
        Map<String, String> m = full();
        m.put(PrefetchConfig.KEY_CSV_CHARSET, "EUC-JP");
        assertTrue(PrefetchConfig.from(m).errors().contains("csv-charset-required"));
    }

    @Test
    void モダリティは大文字にそろえる() {
        Map<String, String> m = full();
        m.put(PrefetchConfig.KEY_MODALITIES, "ct, mr");
        assertEquals(List.of("CT", "MR"), PrefetchConfig.from(m).modalities());
    }
}

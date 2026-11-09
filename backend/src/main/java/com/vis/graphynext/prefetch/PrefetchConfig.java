/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 事前取得の設定（保存値 {@code prefetch.*} から読む）。<b>既定値は置かない</b>（施設の運用で決まる）。
 * 有効なのに必須の項目が空・不正なら、{@link #errors} にコードを入れる（実行しない。黙って別の意味にしない）。
 *
 * @param times      実行時刻（HH:mm）。昇順・重複なし
 * @param years      過去検査を遡る年数（null=制限なし）
 * @param modalities 取得する検査のモダリティ（空=制限なし。ModalitiesInStudy に含まれるものを対象）
 * @param maxStudies 患者ごとに取得する最近の検査の件数の上限（null=制限なし）
 */
public record PrefetchConfig(
        boolean enabled, String source, String targetDay, List<LocalTime> times, boolean catchUp,
        String mwlAe, String mwlStation, String mwlModality,
        String csvFolder, String csvCharset, String csvColPatientId, String csvColDate,
        String pacsAe, String retrieve, Integer years, List<String> modalities, Integer maxStudies,
        Integer timeoutSec, List<String> errors) {

    public static final String P = "prefetch.";
    public static final String KEY_ENABLED = P + "enabled";
    public static final String KEY_SOURCE = P + "source";
    public static final String KEY_TARGET_DAY = P + "targetDay";
    public static final String KEY_TIMES = P + "times";
    public static final String KEY_CATCH_UP = P + "catchUpOnStartup";
    public static final String KEY_MWL_AE = P + "mwl.ae";
    public static final String KEY_MWL_STATION = P + "mwl.station";
    public static final String KEY_MWL_MODALITY = P + "mwl.modality";
    public static final String KEY_CSV_FOLDER = P + "csv.folder";
    public static final String KEY_CSV_CHARSET = P + "csv.charset";
    public static final String KEY_CSV_COL_ID = P + "csv.colPatientId";
    public static final String KEY_CSV_COL_DATE = P + "csv.colDate";
    public static final String KEY_PACS_AE = P + "pacs.ae";
    public static final String KEY_RETRIEVE = P + "retrieve";
    public static final String KEY_YEARS = P + "years";
    public static final String KEY_MODALITIES = P + "modalities";
    public static final String KEY_MAX_STUDIES = P + "maxStudies";
    public static final String KEY_TIMEOUT = P + "timeoutSec";

    public boolean valid() {
        return errors.isEmpty();
    }

    public static PrefetchConfig from(Map<String, String> all) {
        List<String> err = new ArrayList<>();
        boolean enabled = "true".equals(str(all, KEY_ENABLED));
        List<LocalTime> times = new ArrayList<>();
        String timesRaw = str(all, KEY_TIMES);
        if (timesRaw != null) {
            for (String t : timesRaw.split("[,\\s]+")) {
                if (t.isBlank()) {
                    continue;
                }
                try {
                    String x = t.trim();
                    LocalTime lt = LocalTime.parse(x.length() == 4 ? "0" + x : x);
                    if (!times.contains(lt)) {
                        times.add(lt);
                    }
                } catch (RuntimeException e) {
                    err.add("times-invalid");
                }
            }
            times.sort(null);
        }
        Integer years = intOrNull(all, KEY_YEARS, "years-invalid", err);
        Integer maxStudies = intOrNull(all, KEY_MAX_STUDIES, "maxStudies-invalid", err);
        Integer timeout = intOrNull(all, KEY_TIMEOUT, "timeout-invalid", err);
        List<String> modalities = new ArrayList<>();
        String mods = str(all, KEY_MODALITIES);
        if (mods != null) {
            for (String m : mods.split("[,\\s]+")) {
                if (!m.isBlank()) {
                    modalities.add(m.trim().toUpperCase());
                }
            }
        }
        PrefetchConfig c = new PrefetchConfig(enabled, str(all, KEY_SOURCE), str(all, KEY_TARGET_DAY), times,
                "true".equals(str(all, KEY_CATCH_UP)),
                str(all, KEY_MWL_AE), str(all, KEY_MWL_STATION), str(all, KEY_MWL_MODALITY),
                str(all, KEY_CSV_FOLDER), str(all, KEY_CSV_CHARSET), str(all, KEY_CSV_COL_ID), str(all, KEY_CSV_COL_DATE),
                str(all, KEY_PACS_AE), str(all, KEY_RETRIEVE), years, modalities, maxStudies, timeout, err);
        if (enabled) {
            c.requireInto(err);
        }
        return c;
    }

    private void requireInto(List<String> err) {
        if (!"mwl".equals(source) && !"csv".equals(source)) {
            err.add("source-required");
        }
        if (targetDay == null || !List.of("today", "tomorrow", "both").contains(targetDay)) {
            err.add("targetDay-required");
        }
        if (times.isEmpty()) {
            err.add("times-required");
        }
        if ("mwl".equals(source) && mwlAe == null) {
            err.add("mwl-ae-required");
        }
        if ("csv".equals(source)) {
            if (csvFolder == null) {
                err.add("csv-folder-required");
            }
            if (!"UTF-8".equals(csvCharset) && !"Shift_JIS".equals(csvCharset)) {
                err.add("csv-charset-required");
            }
            if (csvColPatientId == null) {
                err.add("csv-col-id-required");
            }
        }
        if (pacsAe == null) {
            err.add("pacs-ae-required");
        }
        if (!"move".equals(retrieve) && !"get".equals(retrieve)) {
            err.add("retrieve-required");
        }
        if (timeoutSec == null) {
            err.add("timeout-required");
        }
    }

    private static String str(Map<String, String> m, String k) {
        String v = m.get(k);
        return v == null || v.isBlank() ? null : v.trim();
    }

    private static Integer intOrNull(Map<String, String> m, String k, String code, List<String> err) {
        String v = str(m, k);
        if (v == null) {
            return null;
        }
        try {
            int n = Integer.parseInt(v);
            if (n < 1) {
                err.add(code);
                return null;
            }
            return n;
        } catch (NumberFormatException e) {
            err.add(code);
            return null;
        }
    }
}

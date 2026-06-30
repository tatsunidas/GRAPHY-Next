/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.seriesextract;

import com.vis.graphynext.extract.TagExtractService;
import org.dcm4che3.data.Attributes;

import java.util.List;
import java.util.Set;

/**
 * シリーズ代表ヘッダを条件群（＋平面）で判定する（GRAPHY SeriesConditionEvaluator 移植）。
 *
 * <p>評価順: ① 平面フィルタ（指定時、面が不一致なら不採用） ② Exclude（どれか一致で不採用）
 * ③ Include（全て一致必須）。値抽出は {@link TagExtractService#resolvePath}。複数値（{@code \} を含む）は
 * 評価不能として不一致扱い（GRAPHY 準拠）。
 */
public final class SeriesConditionEvaluator {

    private SeriesConditionEvaluator() {
    }

    private static final Set<String> NUMERIC_VR = Set.of("DS", "IS", "FL", "FD", "SL", "SS", "UL", "US");
    private static final Set<String> DATETIME_VR = Set.of("DA", "DT", "TM");

    public static boolean matches(Attributes header, List<SearchCondition> conditions, List<String> planes) {
        if (header == null) {
            return false;
        }
        // ① 平面
        if (planes != null && !planes.isEmpty()) {
            String plane = PlaneUtil.planeOf(header);
            if (plane == null || !planes.contains(plane)) {
                return false;
            }
        }
        if (conditions != null) {
            // ② Exclude（どれか一致→不採用）
            for (SearchCondition c : conditions) {
                if (c.exclude() && matchOne(header, c)) {
                    return false;
                }
            }
            // ③ Include（全て一致必須）
            for (SearchCondition c : conditions) {
                if (!c.exclude() && !matchOne(header, c)) {
                    return false;
                }
            }
        }
        return true;
    }

    private static boolean matchOne(Attributes header, SearchCondition c) {
        String value = TagExtractService.resolvePath(header, c.segments());
        if (value == null || value.isEmpty()) {
            return false; // 欠落
        }
        if (value.indexOf('\\') >= 0) {
            return false; // 複数値は評価不能（GRAPHY 準拠でスキップ＝不一致）
        }
        String vr = c.vr() == null ? "" : c.vr().toUpperCase();
        if (NUMERIC_VR.contains(vr)) {
            return compareNumeric(value, c);
        }
        if (DATETIME_VR.contains(vr)) {
            return compareLexicographic(value, c);
        }
        return compareString(value, c);
    }

    private static boolean compareNumeric(String target, SearchCondition c) {
        try {
            double t = Double.parseDouble(target.trim());
            double v1 = Double.parseDouble(safe(c.value1()).trim());
            switch (c.op()) {
                case "EQUALS":
                    return t == v1;
                case "GE":
                    return t >= v1;
                case "LE":
                    return t <= v1;
                case "RANGE":
                    double v2 = Double.parseDouble(safe(c.value2()).trim());
                    return t >= v1 && t <= v2;
                default:
                    return false;
            }
        } catch (NumberFormatException e) {
            return false;
        }
    }

    /** DICOM の日付/時刻は YYYYMMDD / HHMMSS で辞書式比較が大小一致する。 */
    private static boolean compareLexicographic(String target, SearchCondition c) {
        String t = target.trim();
        String v1 = safe(c.value1()).trim();
        switch (c.op()) {
            case "EQUALS":
                return t.equals(v1);
            case "GE":
                return t.compareTo(v1) >= 0;
            case "LE":
                return t.compareTo(v1) <= 0;
            case "RANGE":
                String v2 = safe(c.value2()).trim();
                return t.compareTo(v1) >= 0 && t.compareTo(v2) <= 0;
            default:
                return false;
        }
    }

    private static boolean compareString(String target, SearchCondition c) {
        String query = safe(c.value1());
        if ("CONTAINS".equals(c.op())) {
            for (String kw : query.split(",")) {
                String k = kw.trim();
                if (!k.isEmpty() && target.toLowerCase().contains(k.toLowerCase())) {
                    return true; // OR
                }
            }
            return false;
        }
        if ("EQUALS".equals(c.op())) {
            return target.equalsIgnoreCase(query.trim());
        }
        return false; // GE/LE/RANGE は文字列 VR には非対応
    }

    private static String safe(String s) {
        return s == null ? "" : s;
    }
}

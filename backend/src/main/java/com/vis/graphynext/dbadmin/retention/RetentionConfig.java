/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 自動削除の条件。<b>値が空の条件は使わない</b>（既定の値は置かない。施設の運用で決まる数だから）。
 * GB は 1024^3 バイト（OS の空き容量の表示と同じ）。
 *
 * @param days      最後の受信からこの日数を過ぎた検査を消す（整数・1 以上）
 * @param maxGb     保管庫の合計がこれを超えたら、古い順に超えなくなるまで消す（0 より大きい）
 * @param minFreeGb ディスクの空きがこれを下回ったら、古い順に下回らなくなるまで消す（0 より大きい）
 */
public record RetentionConfig(Integer days, Double maxGb, Double minFreeGb) {

    public static final String KEY_DAYS = "retention.days";
    public static final String KEY_MAX_GB = "retention.maxGb";
    public static final String KEY_MIN_FREE_GB = "retention.minFreeGb";
    public static final long GB = 1024L * 1024L * 1024L;

    public boolean any() {
        return days != null || maxGb != null || minFreeGb != null;
    }

    public Long maxBytes() {
        return maxGb == null ? null : Math.round(maxGb * GB);
    }

    public Long minFreeBytes() {
        return minFreeGb == null ? null : Math.round(minFreeGb * GB);
    }

    /** 検査（不正なら IllegalArgumentException。メッセージは API の 400 にそのまま出す）。 */
    public RetentionConfig validated() {
        if (days != null && days < 1) {
            throw new IllegalArgumentException("days は 1 以上の整数です");
        }
        if (maxGb != null && !(maxGb > 0 && Double.isFinite(maxGb))) {
            throw new IllegalArgumentException("maxGb は 0 より大きい数です");
        }
        if (minFreeGb != null && !(minFreeGb > 0 && Double.isFinite(minFreeGb))) {
            throw new IllegalArgumentException("minFreeGb は 0 より大きい数です");
        }
        return this;
    }

    /** 設定の保存値から読む。壊れた値（数でない）は「使わない」とせず、失敗させる（黙って別の意味にしない）。 */
    public static RetentionConfig from(Map<String, String> all) {
        return new RetentionConfig(
                parseInt(all.get(KEY_DAYS), KEY_DAYS),
                parseDouble(all.get(KEY_MAX_GB), KEY_MAX_GB),
                parseDouble(all.get(KEY_MIN_FREE_GB), KEY_MIN_FREE_GB)).validated();
    }

    /** 保存する値（空の条件はキーごと消す）。 */
    public Map<String, String> toSettings() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put(KEY_DAYS, days == null ? null : String.valueOf(days));
        m.put(KEY_MAX_GB, maxGb == null ? null : String.valueOf(maxGb));
        m.put(KEY_MIN_FREE_GB, minFreeGb == null ? null : String.valueOf(minFreeGb));
        return m;
    }

    private static Integer parseInt(String s, String key) {
        if (s == null || s.isBlank()) {
            return null;
        }
        try {
            return Integer.valueOf(s.trim());
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException(key + " の保存値が整数ではありません: " + s);
        }
    }

    private static Double parseDouble(String s, String key) {
        if (s == null || s.isBlank()) {
            return null;
        }
        try {
            return Double.valueOf(s.trim());
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException(key + " の保存値が数ではありません: " + s);
        }
    }
}

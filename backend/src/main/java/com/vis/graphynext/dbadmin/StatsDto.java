package com.vis.graphynext.dbadmin;

import java.util.List;

/**
 * 統計グラフ用の集計結果。
 *
 * @param studyCountByMonth      時系列スタディ数（key=YYYY-MM）
 * @param studyCountByModality   モダリティ別スタディ数（モダリティ割合に使用）
 * @param instanceCountByModality モダリティ別画像枚数
 * @param volumeBytesByModality   モダリティ別データ容量（バイト）
 */
public record StatsDto(List<Bucket> studyCountByMonth,
                       List<Bucket> studyCountByModality,
                       List<Bucket> instanceCountByModality,
                       List<Bucket> volumeBytesByModality) {

    /** 汎用の {キー, 値} バケット。 */
    public record Bucket(String key, long value) {
    }
}

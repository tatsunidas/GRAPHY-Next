/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import java.util.List;
import java.util.Map;

/**
 * 自動削除の計画（試算の結果）。計画を立てるだけで、何も消さない。
 *
 * @param items          消す検査（古い順）
 * @param totalBytes     消す検査の容量の合計
 * @param protectedSkips 条件に当たったが保護で除外された検査の数（理由別・1 検査が複数の理由に数えられうる）
 * @param satisfied      条件を満たせたか（条件が 1 つも無ければ true）
 * @param warnings       満たせなかった理由など
 */
public record RetentionPlan(List<Item> items, long totalBytes, Map<String, Integer> protectedSkips, boolean satisfied,
                            List<String> warnings) {

    /** 消す検査 1 件。reason は {@code days} / {@code size} / {@code free}（最初に当たった条件）。 */
    public record Item(String studyUid, String patientId, String patientName, String studyDate, String modality, long instances,
                       long sizeBytes, long lastReceivedAt, String reason) {
    }
}

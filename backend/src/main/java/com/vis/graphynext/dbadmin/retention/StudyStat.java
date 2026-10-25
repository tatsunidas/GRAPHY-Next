/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

/**
 * 検査 1 件の集計（索引の行を検査ごとにまとめたもの）。
 *
 * @param lastReceivedAt  検査の画像の受信日時の最大（epoch ms）。1 枚も記録が無ければ null
 * @param unknownReceived 受信日時が不明の画像の数
 */
public record StudyStat(String studyUid, String patientKey, String patientId, String patientName, String studyDate,
                        String modality, long instances, long sizeBytes, Long lastReceivedAt, long unknownReceived) {
}

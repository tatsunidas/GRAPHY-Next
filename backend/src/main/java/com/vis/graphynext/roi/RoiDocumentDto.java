/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.roi;

/**
 * ROI ドキュメントの応答。
 *
 * <p>{@code json} は**そのまま文字列で返す**（backend でパースし直さない）。スキーマの正本は
 * フロントの `roiPersistence.ts` であり、backend は保管と版管理だけを担う。中身を解釈すると
 * ROI ツールを増やすたびに backend の改修が必要になる。
 *
 * @param patientKey 患者判定キー
 * @param json       ROI 配列の JSON（未保存なら null）
 * @param roiCount   保存されている ROI 件数
 * @param updatedAt  最終更新（ISO-8601。未保存なら null）
 * @param version    楽観ロックの版。保存時にこの値を返送する（未保存なら null）
 */
public record RoiDocumentDto(
        String patientKey,
        String json,
        int roiCount,
        String updatedAt,
        Long version) {
}

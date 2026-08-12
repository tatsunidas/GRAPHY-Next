/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.registration;

/**
 * 位置合わせ記録の応答。
 *
 * <p>{@code json} は**そのまま文字列で返す**（backend でパースし直さない）。スキーマの正本は
 * フロントの `registrationRecord.ts` で、backend は保管と版管理だけを担う。
 *
 * @param patientKey  患者判定キー
 * @param json        記録配列の JSON（未保存なら null）
 * @param recordCount 保存されている記録件数
 * @param updatedAt   最終更新（ISO-8601。未保存なら null）
 * @param version     楽観ロックの版。保存時にこの値を返送する（未保存なら null）
 */
public record RegistrationDocumentDto(
        String patientKey,
        String json,
        int recordCount,
        String updatedAt,
        Long version) {
}

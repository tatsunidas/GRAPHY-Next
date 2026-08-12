/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.registration;

/**
 * 位置合わせ記録の保存要求。
 *
 * @param json        記録配列の JSON（スキーマの正本はフロントの `registrationRecord.ts`）
 * @param recordCount 件数（要求と JSON の不一致は検証する）
 * @param version     直前に読んだ版。**null は「新規作成のみ許す」**の意味（読まずに上書きする事故を防ぐ）
 */
public record SaveRegistrationDocumentRequest(String json, int recordCount, Long version) {
}

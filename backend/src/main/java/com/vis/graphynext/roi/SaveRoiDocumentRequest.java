/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.roi;

/**
 * ROI ドキュメントの保存要求。
 *
 * @param json     ROI 配列の JSON（スキーマの正本はフロントの `roiPersistence.ts`）
 * @param roiCount 件数（一覧を JSON パースなしで見せるためのメタ。要求と JSON の不一致は検証する）
 * @param version  直前に読んだ版。**null は「新規作成のみ許す」**の意味。既存があれば 409 になる
 *                 （読まずに上書きしてしまう事故を防ぐ）
 */
public record SaveRoiDocumentRequest(String json, int roiCount, Long version) {
}

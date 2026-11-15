/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.emr;

/**
 * 電子カルテのファイルの患者 ID が、前回と違う ID に変わった（Spring のイベント）。
 * 🔴 患者 ID を含むので、ログに出さない。
 *
 * @param seq 変わるたびに 1 ずつ増える通し番号（クライアントが「新しい変化か」を見分ける）
 */
public record EmrPatientChanged(String patientId, long seq) {
}

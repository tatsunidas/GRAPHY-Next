/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

/** レポートの確定状態。 */
public enum ReportStatus {
    /** 下書き（編集可）。 */
    DRAFT,
    /** 確定済み（SR/KO 生成済み、本文は編集不可）。 */
    FINAL,
    /** 確定済みレポートへの追記（{@code predecessorReportId} で元レポートを参照）。 */
    ADDENDUM
}

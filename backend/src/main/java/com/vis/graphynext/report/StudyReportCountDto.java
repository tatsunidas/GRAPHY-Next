/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

/**
 * MainScreen の一覧表示用（スタディ 1 件分）。{@code reportState} は
 * {@code "report"}（確定あり）/{@code "draft"}（下書きのみ）/{@code "none"}（なし）。
 * 判定ロジックは `fw/report-design.md` §6（旧 GRAPHY {@code ReportCellRenderer} 相当）。
 */
public record StudyReportCountDto(String studyInstanceUid, String reportState, long reportCount, long draftCount) {
}

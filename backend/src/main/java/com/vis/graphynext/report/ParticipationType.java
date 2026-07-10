/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

/**
 * レポート参加者の関与形態。SR/KO 確定時（フェーズ2）のシーケンス対応:
 * {@link #AUTHOR}→Author Observer Sequence(0040,A078)、
 * {@link #VERIFIER}→Verifying Observer Sequence(0040,A073)、
 * {@link #ENTERER}/{@link #REVIEWER}→Participant Sequence(0040,A07A)。
 */
public enum ParticipationType {
    AUTHOR,
    VERIFIER,
    ENTERER,
    REVIEWER
}

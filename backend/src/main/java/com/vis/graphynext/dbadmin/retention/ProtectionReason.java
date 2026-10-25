/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

/**
 * 自動削除の対象から外す理由。1 つでも当たる検査は、どの条件でも消えない。
 * 表示用のキー（{@link #key}）は API とログに出る（患者名・検査名は含まない）。
 */
public enum ProtectionReason {
    /** 利用者が「ロック」した検査。 */
    LOCK("lock"),
    /** ROI・解析状態が付いている。 */
    ROI("roi"),
    /** レポートがある。 */
    REPORT("report"),
    /** 位置合わせの記録がある。 */
    REGISTRATION("registration"),
    /** GLAM 解析がある。 */
    GLAM("glam"),
    /** XA の空間校正がある。 */
    XA_CALIBRATION("xaCalibration"),
    /** プラグインの記録がある患者の検査（記録は患者単位で、検査に割り当てられないため患者ごと守る）。 */
    PLUGIN_RECORD("pluginRecord"),
    /** ビューアで開いている。 */
    IN_USE("inUse"),
    /** 判定の開始後に受信があった（受信中の検査を消さない）。 */
    RECEIVED_AFTER_PLAN_START("receivedAfterPlanStart"),
    /** 受信日時が不明の画像を含む（日付を作らず、消さない）。 */
    UNKNOWN_RECEIVED("unknownReceived"),
    /** セグメンテーション・RT・構造化レポート等、通常の画像でない DICOM を含む（本体が作った派生物を守る）。 */
    NON_IMAGE_DICOM("nonImageDicom");

    private final String key;

    ProtectionReason(String key) {
        this.key = key;
    }

    public String key() {
        return key;
    }
}

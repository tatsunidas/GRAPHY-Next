/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * 通信先ごとの検索（C-FIND）の方式。<b>すべて null（未指定）なら、従来どおりの検索になる</b>
 * （Study Root・STUDY→SERIES・既定の返却キー・findscu 既定の転送構文・文字コード指定なし）。
 *
 * <p>{@code dicom.remoteAes} の JSON の {@code find} にそのまま保存される。
 *
 * @param model              {@code "StudyRoot"}（既定）／{@code "PatientRoot"}
 * @param patientKeys        PATIENT 段の返却キー（null なら既定）
 * @param studyKeys          STUDY 段の返却キー（null なら既定）
 * @param seriesKeys         SERIES 段の返却キー（null なら既定）
 * @param wildcard           患者 ID・患者名の一致方法: {@code "contains"}（既定。前後に *）／{@code "prefix"}／{@code "exact"}
 * @param transferSyntax     {@code "implicit"}／{@code "explicit"}／null（findscu 既定）
 * @param charset            照合キーに付ける SpecificCharacterSet（例 {@code ISO_IR 192}）。null なら付けない
 * @param responseTimeoutMs  応答を待つ時間（ミリ秒）。null なら findscu 既定
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonIgnoreProperties(ignoreUnknown = true)
public record FindProfile(String model, List<String> patientKeys, List<String> studyKeys,
                          List<String> seriesKeys, String wildcard, String transferSyntax,
                          String charset, Integer responseTimeoutMs) {

    public static final FindProfile DEFAULT = new FindProfile(null, null, null, null, null, null, null, null);

    /** 最小の返却キー（相手が任意の返却キーで落ちる場合の逃げ道）。各段の一意キーだけ。 */
    public static final List<String> MINIMAL_PATIENT = List.of("PatientID");
    public static final List<String> MINIMAL_STUDY = List.of("StudyInstanceUID");
    public static final List<String> MINIMAL_SERIES = List.of("SeriesInstanceUID");

    public static FindProfile orDefault(FindProfile p) {
        return p == null ? DEFAULT : p;
    }

    public boolean patientRoot() {
        return "PatientRoot".equalsIgnoreCase(model);
    }

    public List<String> patientKeysOr(List<String> fallback) {
        return patientKeys == null || patientKeys.isEmpty() ? fallback : patientKeys;
    }

    public List<String> studyKeysOr(List<String> fallback) {
        return studyKeys == null || studyKeys.isEmpty() ? fallback : studyKeys;
    }

    public List<String> seriesKeysOr(List<String> fallback) {
        return seriesKeys == null || seriesKeys.isEmpty() ? fallback : seriesKeys;
    }

    public FindProfile withModel(String m) {
        return new FindProfile(m, patientKeys, studyKeys, seriesKeys, wildcard, transferSyntax, charset, responseTimeoutMs);
    }

    public FindProfile withKeys(List<String> patient, List<String> study, List<String> series) {
        return new FindProfile(model, patient, study, series, wildcard, transferSyntax, charset, responseTimeoutMs);
    }

    public FindProfile withTransferSyntax(String ts) {
        return new FindProfile(model, patientKeys, studyKeys, seriesKeys, wildcard, ts, charset, responseTimeoutMs);
    }

    public FindProfile withCharset(String cs) {
        return new FindProfile(model, patientKeys, studyKeys, seriesKeys, wildcard, transferSyntax, cs, responseTimeoutMs);
    }
}

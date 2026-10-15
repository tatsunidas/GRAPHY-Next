/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;

/**
 * 納品フォルダ（1 患者ぶん）に画像と一緒に置く被験者 CSV の解析と検査（純関数）。
 *
 * <p>形式: UTF-8（BOM 可）、1 行目は列名、<b>データ行はちょうど 1 行</b>。列は {@code PatientID}・{@code PatientName}・
 * {@code PatientBirthDate}・{@code PatientSex}・{@code Modality}・{@code StudyDescription}（後ろの 2 つは NIfTI にだけ効く）。
 * ダブルクォートの値・カンマ・クォート内の {@code ""} を扱う。<b>1 つでも不正があれば CSV 全体を拒否</b>し、何も適用しない。
 * 理由のコードに値そのものは含めない（個人情報をログ・画面へ出さない）。空の値は「指定なし」。
 */
final class ImportWatchCsv {

    /** 解析結果。{@code error} が null なら有効（{@code values} は指定のあった列だけ）。 */
    record Parsed(Map<String, String> values, String error) {
        boolean ok() {
            return error == null;
        }
    }

    static final String ERR_EMPTY = "csv-empty";
    static final String ERR_UNKNOWN_COLUMN = "csv-unknown-column";
    static final String ERR_DUPLICATE_COLUMN = "csv-duplicate-column";
    static final String ERR_ROWS = "csv-rows";
    static final String ERR_BAD_VALUE = "csv-bad-value";
    static final String ERR_UNREADABLE = "csv-unreadable";
    static final String ERR_MULTIPLE = "csv-multiple";

    private static final Map<String, Predicate<String>> COLUMNS = Map.of(
            "PatientID", PatientFields::validLo,
            "PatientName", PatientFields::validPn,
            "PatientBirthDate", PatientFields::validDa,
            "PatientSex", PatientFields::validSex,
            "Modality", PatientFields::validCs,
            "StudyDescription", PatientFields::validLo);

    private ImportWatchCsv() {
    }

    static Parsed parse(String text) {
        List<List<String>> rows = rows(text);
        if (rows.isEmpty()) {
            return bad(ERR_EMPTY);
        }
        List<String> header = rows.get(0).stream().map(String::trim).toList();
        Set<String> seenCols = new java.util.HashSet<>();
        for (String h : header) {
            if (!COLUMNS.containsKey(h)) {
                return bad(ERR_UNKNOWN_COLUMN); // 列名は値ではないが、不審な入力を画面へ出さないため種別だけ
            }
            if (!seenCols.add(h)) {
                return bad(ERR_DUPLICATE_COLUMN + ":" + h);
            }
        }
        if (rows.size() != 2) {
            return bad(ERR_ROWS);
        }
        List<String> row = rows.get(1);
        if (row.size() > header.size()) {
            return bad(ERR_ROWS);
        }
        Map<String, String> values = new LinkedHashMap<>();
        for (int i = 0; i < header.size(); i++) {
            String v = PatientFields.clean(i < row.size() ? row.get(i) : null);
            if (v == null) {
                continue; // 指定なし
            }
            if (!COLUMNS.get(header.get(i)).test(v)) {
                return bad(ERR_BAD_VALUE + ":" + header.get(i));
            }
            values.put(header.get(i), v);
        }
        return new Parsed(values, null);
    }

    private static Parsed bad(String error) {
        return new Parsed(Map.of(), error);
    }

    /** RFC 4180 に沿った分割。空行は無視。BOM を除く。 */
    static List<List<String>> rows(String text) {
        List<List<String>> out = new ArrayList<>();
        if (text == null) {
            return out;
        }
        if (text.startsWith("﻿")) {
            text = text.substring(1);
        }
        List<String> row = new ArrayList<>();
        StringBuilder cell = new StringBuilder();
        boolean quoted = false;
        boolean any = false; // この行に 1 文字でも読んだか（空行の判定）
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (quoted) {
                if (c == '"') {
                    if (i + 1 < text.length() && text.charAt(i + 1) == '"') {
                        cell.append('"');
                        i++;
                    } else {
                        quoted = false;
                    }
                } else {
                    cell.append(c);
                }
                continue;
            }
            switch (c) {
                case '"' -> {
                    quoted = true;
                    any = true;
                }
                case ',' -> {
                    row.add(cell.toString());
                    cell.setLength(0);
                    any = true;
                }
                case '\r' -> {
                    // \r\n の \n で行を閉じる。単独の \r も行末として扱う
                    if (i + 1 >= text.length() || text.charAt(i + 1) != '\n') {
                        endRow(out, row, cell, any);
                        row = new ArrayList<>();
                        any = false;
                    }
                }
                case '\n' -> {
                    endRow(out, row, cell, any);
                    row = new ArrayList<>();
                    any = false;
                }
                default -> {
                    cell.append(c);
                    any = true;
                }
            }
        }
        endRow(out, row, cell, any);
        return out;
    }

    private static void endRow(List<List<String>> out, List<String> row, StringBuilder cell, boolean any) {
        if (!any && row.isEmpty() && cell.length() == 0) {
            return; // 空行
        }
        row.add(cell.toString());
        cell.setLength(0);
        out.add(row);
    }
}

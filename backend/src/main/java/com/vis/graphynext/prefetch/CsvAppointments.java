/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import com.vis.graphynext.importer.ImportWatchCsv;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * RIS が書き出す予約一覧 CSV の解析（純関数）。1 行目は列名。患者 ID の列は必須、予約日の列は任意
 * （無ければ「そのファイルの全行が対象日の予約」）。予約日は {@code YYYYMMDD}・{@code YYYY/MM/DD}・{@code YYYY-MM-DD}。
 * <b>不正な行があれば全体を拒否</b>する（一部だけ取って黙って欠けるのを避ける）。エラーコードに値は含めない（個人情報）。
 */
final class CsvAppointments {

    record Parsed(List<String> patientIds, String error) {
        boolean ok() {
            return error == null;
        }
    }

    static final String ERR_EMPTY = "csv-empty";
    static final String ERR_NO_ID_COLUMN = "csv-no-id-column";
    static final String ERR_NO_DATE_COLUMN = "csv-no-date-column";
    static final String ERR_BAD_ID = "csv-bad-id";
    static final String ERR_BAD_DATE = "csv-bad-date";

    private static final List<DateTimeFormatter> FORMATS = List.of(
            DateTimeFormatter.BASIC_ISO_DATE,
            DateTimeFormatter.ofPattern("uuuu/M/d"),
            DateTimeFormatter.ofPattern("uuuu-M-d"));

    private CsvAppointments() {
    }

    /** @param dateCol null なら日付で絞らない。指定があれば {@code day} と同じ日の行だけ。 */
    static Parsed parse(String text, String idCol, String dateCol, LocalDate day) {
        List<List<String>> rows = ImportWatchCsv.rows(text);
        if (rows.isEmpty()) {
            return new Parsed(List.of(), ERR_EMPTY);
        }
        List<String> header = rows.get(0).stream().map(String::trim).toList();
        int idIdx = header.indexOf(idCol);
        if (idIdx < 0) {
            return new Parsed(List.of(), ERR_NO_ID_COLUMN);
        }
        int dateIdx = -1;
        if (dateCol != null) {
            dateIdx = header.indexOf(dateCol);
            if (dateIdx < 0) {
                return new Parsed(List.of(), ERR_NO_DATE_COLUMN);
            }
        }
        Set<String> ids = new LinkedHashSet<>();
        for (int i = 1; i < rows.size(); i++) {
            List<String> row = rows.get(i);
            String id = idIdx < row.size() ? row.get(idIdx).trim() : "";
            if (id.isEmpty() || id.length() > 64 || id.chars().anyMatch(Character::isISOControl)) {
                return new Parsed(List.of(), ERR_BAD_ID);
            }
            if (dateIdx >= 0) {
                LocalDate d = date(dateIdx < row.size() ? row.get(dateIdx).trim() : "");
                if (d == null) {
                    return new Parsed(List.of(), ERR_BAD_DATE);
                }
                if (!d.equals(day)) {
                    continue;
                }
            }
            ids.add(id);
        }
        return new Parsed(new ArrayList<>(ids), null);
    }

    private static LocalDate date(String s) {
        for (DateTimeFormatter f : FORMATS) {
            try {
                return LocalDate.parse(s, f);
            } catch (DateTimeParseException ignore) {
                // 次の書式を試す
            }
        }
        return null;
    }
}

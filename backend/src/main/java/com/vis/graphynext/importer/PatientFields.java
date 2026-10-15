/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.format.ResolverStyle;

/**
 * 患者属性の値の検査（DICOM の VR の規則から導く）。形式違いの値は「無い」ものとして扱い、黙って壊れた値を
 * DICOM に入れない。
 *
 * <ul>
 *   <li>患者 ID・各説明: LO（64 文字以下・{@code \} と制御文字を含まない）</li>
 *   <li>患者名: PN（{@code =} で区切った各グループが 64 文字以下・{@code \} と制御文字を含まない）</li>
 *   <li>生年月日: DA（{@code yyyyMMdd}、実在する日付）</li>
 *   <li>性別: CS のうち {@code M}・{@code F}・{@code O}</li>
 * </ul>
 */
final class PatientFields {

    private static final int MAX_LEN = 64;
    private static final DateTimeFormatter DA = DateTimeFormatter.ofPattern("uuuuMMdd").withResolverStyle(ResolverStyle.STRICT);

    private PatientFields() {
    }

    /** 前後の空白を除いた値。空なら null。 */
    static String clean(Object v) {
        if (v == null) {
            return null;
        }
        String s = v.toString().trim();
        return s.isEmpty() ? null : s;
    }

    private static boolean plain(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\' || c < 0x20 || c == 0x7F) {
                return false;
            }
        }
        return true;
    }

    /** LO（患者 ID・検査/シリーズの説明）。 */
    static boolean validLo(String s) {
        return s != null && !s.isEmpty() && s.length() <= MAX_LEN && plain(s);
    }

    /** PN（患者名）。 */
    static boolean validPn(String s) {
        if (s == null || s.isEmpty() || !plain(s)) {
            return false;
        }
        for (String group : s.split("=", -1)) {
            if (group.length() > MAX_LEN) {
                return false;
            }
        }
        return true;
    }

    /** DA（{@code yyyyMMdd}）。 */
    static boolean validDa(String s) {
        if (s == null || !s.matches("\\d{8}")) {
            return false;
        }
        try {
            LocalDate.parse(s, DA);
            return true;
        } catch (java.time.format.DateTimeParseException e) {
            return false;
        }
    }

    /** 性別（M・F・O）。 */
    static boolean validSex(String s) {
        return "M".equals(s) || "F".equals(s) || "O".equals(s);
    }

    /** CS（Modality）: 16 文字以下で、英大文字・数字・空白・{@code _}。 */
    static boolean validCs(String s) {
        return s != null && !s.isEmpty() && s.length() <= 16 && s.matches("[A-Z0-9 _]+");
    }

    /** 値が形式に合えばそのまま、合わなければ null。 */
    static String ifValid(String s, java.util.function.Predicate<String> rule) {
        return s != null && rule.test(s) ? s : null;
    }
}

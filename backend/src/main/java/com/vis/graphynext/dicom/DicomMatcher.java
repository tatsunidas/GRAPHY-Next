/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.ElementDictionary;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;

import java.util.regex.Pattern;

/**
 * C-FIND の照合キー（Identifier）と、索引から作った候補の突き合わせ。DICOM の照合規則
 * （PS3.4 C.2.2.2）を<b>ここだけ</b>に集める。
 *
 * <ul>
 *   <li>キーが空（値なし）: 全一致（そのタグは「戻してほしい属性」を表すだけ）</li>
 *   <li>文字列: {@code *}（0 文字以上）・{@code ?}（1 文字）のワイルドカード。無ければ完全一致。
 *       人名（PN: PatientName・ReferringPhysicianName）だけ大文字小文字を区別しない（他は区別する）。</li>
 *   <li>日付（DA）: {@code a-b}（両端含む）・{@code a-}・{@code -b} の範囲。無ければ完全一致。</li>
 *   <li>時刻（TM）: 同じ範囲。キーの桁数が少ないときは、値をその桁数に切って比べる（{@code 0900-1000} は 10:00:30 も含む）。</li>
 *   <li>複数値（UID リスト {@code \}・ModalitiesInStudy）: キーの値のどれかが候補の値のどれかに一致すれば一致。</li>
 *   <li>候補がそのタグを持たない（索引にない属性）: キーを無視する。DICOM は任意キーの未対応を許す。</li>
 *   <li>候補がタグを持つが値がない（索引に空）: キーが空でなければ不一致。</li>
 * </ul>
 */
final class DicomMatcher {

    private DicomMatcher() {
    }

    /** {@code keys} の全キーが {@code candidate} に一致するか。 */
    static boolean matches(Attributes keys, Attributes candidate) {
        for (int tag : keys.tags()) {
            if (skip(tag, keys)) {
                continue;
            }
            if (!candidate.contains(tag)) {
                continue; // 索引にない属性: 無視（戻りでは空で返す）
            }
            VR vr = keys.getVR(tag);
            if (!matchesValue(keys.getStrings(tag), candidate.getStrings(tag), vr, isPersonName(tag))) {
                return false;
            }
        }
        return true;
    }

    /** 候補の持たないキー（照合に使えず、無視したもの）のタグ。デバッグログ用。 */
    static String ignoredKeys(Attributes keys, Attributes candidate) {
        StringBuilder sb = new StringBuilder();
        for (int tag : keys.tags()) {
            if (skip(tag, keys) || candidate.contains(tag)) {
                continue;
            }
            String[] k = keys.getStrings(tag);
            if (k == null || k.length == 0 || (k.length == 1 && (k[0] == null || k[0].isEmpty()))) {
                continue; // 空のキーは「戻す属性」の指定で、無視ではない
            }
            sb.append(String.format("(%04X,%04X) ", tag >>> 16, tag & 0xFFFF));
        }
        return sb.toString().trim();
    }

    private static boolean skip(int tag, Attributes keys) {
        return tag == Tag.QueryRetrieveLevel || tag == Tag.SpecificCharacterSet || keys.getVR(tag) == VR.SQ;
    }

    /** 1 つのタグ分の照合。 */
    static boolean matchesValue(String[] key, String[] value, VR vr, boolean ignoreCase) {
        if (isEmpty(key)) {
            return true;
        }
        if (value == null || value.length == 0) {
            // 索引にあるが値の無い属性。「*」だけのキーは全一致、それ以外は一致しない。
            for (String k : key) {
                if (k != null && !k.isEmpty() && k.chars().allMatch(c -> c == '*')) {
                    return true;
                }
            }
            return false;
        }
        for (String k : key) {
            if (k == null || k.isEmpty()) {
                continue;
            }
            for (String v : value) {
                if (v != null && single(k, v, vr, ignoreCase)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean isEmpty(String[] a) {
        if (a == null || a.length == 0) {
            return true;
        }
        for (String s : a) {
            if (s != null && !s.isEmpty()) {
                return false;
            }
        }
        return true;
    }

    private static boolean single(String key, String value, VR vr, boolean ignoreCase) {
        key = trimTrailing(key);
        value = trimTrailing(value);
        if (vr == VR.DA && key.indexOf('-') >= 0) {
            return dateInRange(key, value);
        }
        if (vr == VR.TM && key.indexOf('-') >= 0) {
            return timeInRange(key, value);
        }
        if (key.indexOf('*') >= 0 || key.indexOf('?') >= 0) {
            return wildcard(key, ignoreCase).matcher(value).matches();
        }
        return ignoreCase ? key.equalsIgnoreCase(value) : key.equals(value);
    }

    /** {@code a-b}（両端含む）。片側が空なら開区間。日付は yyyyMMdd の文字列比較で足りる。 */
    static boolean dateInRange(String range, String value) {
        int dash = range.indexOf('-');
        String from = range.substring(0, dash).trim();
        String to = range.substring(dash + 1).trim();
        if (value.isEmpty()) {
            return false;
        }
        if (!from.isEmpty() && value.compareTo(from) < 0) {
            return false;
        }
        return to.isEmpty() || value.compareTo(to) <= 0;
    }

    /** {@code a-b}（両端含む）。片側が空なら開区間。各端は、その桁数まで値を切って比べる。 */
    static boolean timeInRange(String range, String value) {
        int dash = range.indexOf('-');
        String from = range.substring(0, dash).trim();
        String to = range.substring(dash + 1).trim();
        if (value.isEmpty()) {
            return false;
        }
        if (!from.isEmpty() && prefix(value, from.length()).compareTo(from) < 0) {
            return false;
        }
        return to.isEmpty() || prefix(value, to.length()).compareTo(to) <= 0;
    }

    private static String prefix(String s, int n) {
        return s.length() <= n ? s : s.substring(0, n);
    }

    /** 人名（PN）のタグか。照合で大文字小文字を区別しない。 */
    private static boolean isPersonName(int tag) {
        return ElementDictionary.getStandardElementDictionary().vrOf(tag) == VR.PN;
    }

    static Pattern wildcard(String key, boolean ignoreCase) {
        StringBuilder re = new StringBuilder();
        StringBuilder lit = new StringBuilder();
        for (int i = 0; i < key.length(); i++) {
            char c = key.charAt(i);
            if (c == '*' || c == '?') {
                if (lit.length() > 0) {
                    re.append(Pattern.quote(lit.toString()));
                    lit.setLength(0);
                }
                re.append(c == '*' ? ".*" : ".");
            } else {
                lit.append(c);
            }
        }
        if (lit.length() > 0) {
            re.append(Pattern.quote(lit.toString()));
        }
        int flags = Pattern.DOTALL | (ignoreCase ? Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE : 0);
        return Pattern.compile(re.toString(), flags);
    }

    /** DICOM の文字列は末尾の空白（パディング）を値に含めない。 */
    private static String trimTrailing(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == ' ') {
            end--;
        }
        return s.substring(0, end);
    }
}

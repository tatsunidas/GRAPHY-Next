/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import org.dcm4che3.data.ElementDictionary;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;

import java.time.DateTimeException;
import java.time.LocalDate;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * タグの編集で、変えてよいタグと値の形の決まり。画面（{@code tagEditRules.ts}）にも同じ表があるが、正はこちら。
 *
 * <p>理由コードは画面で文言にする。値の決まりは PS3.5 6.2（VR ごとの文字・長さ・形式）。
 */
final class TagEditRules {

    private TagEditRules() {
    }

    /** 画素の中身とその読み方。変えると画素が別の意味で読まれる。 */
    private static final Set<Integer> PIXEL = Set.of(
            Tag.PixelData, Tag.FloatPixelData, Tag.DoubleFloatPixelData, Tag.Rows, Tag.Columns,
            Tag.BitsAllocated, Tag.BitsStored, Tag.HighBit, Tag.PixelRepresentation, Tag.SamplesPerPixel,
            Tag.PhotometricInterpretation, Tag.NumberOfFrames, Tag.PlanarConfiguration);

    /** 幾何。値を誤ると計測・MPR・ROI の位置が知らせなしにずれる（v1 は編集しない、2026-10-19 決定）。 */
    private static final Set<Integer> GEOMETRY = Set.of(
            Tag.ImagePositionPatient, Tag.ImageOrientationPatient, Tag.PixelSpacing, Tag.SliceThickness);

    /** 患者情報の編集が受け持つ（ROI などの記録を新しい患者キーへ運ぶため、ここでは変えない）。 */
    private static final Set<Integer> PATIENT = Set.of(
            Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex);

    private static final Set<VR> BINARY = Set.of(VR.OB, VR.OW, VR.OF, VR.OD, VR.OL, VR.OV, VR.UN);

    /** 値を {@code \} で区切らない（1 つの値の中に {@code \} を書ける）VR。 */
    private static final Set<VR> SINGLE = Set.of(VR.LT, VR.ST, VR.UT, VR.UR);

    /**
     * そのタグを編集できない理由。編集できるなら null。
     * 理由: structure / meta / uid / pixel / geometry / patient / audit / sequence / binary / privateCreator
     */
    static String lockReason(int tag, VR vr) {
        int group = tag >>> 16;
        int element = tag & 0xFFFF;
        if (group == 0x0002) {
            return "meta";
        }
        if (group == 0x0000 || group == 0xFFFE || element == 0x0000) {
            return "structure";
        }
        if (PATIENT.contains(tag)) {
            return "patient";
        }
        if (PIXEL.contains(tag)) {
            return "pixel";
        }
        if (GEOMETRY.contains(tag)) {
            return "geometry";
        }
        if (tag == Tag.OriginalAttributesSequence) {
            return "audit";
        }
        if (vr == VR.UI) {
            return "uid";
        }
        if (vr == VR.SQ) {
            return "sequence";
        }
        if (vr == null || BINARY.contains(vr)) {
            return "binary";
        }
        if ((group & 1) == 1 && element >= 0x0010 && element <= 0x00FF) {
            return "privateCreator";
        }
        return null;
    }

    /** 辞書の VR（プライベート・未知のタグは null）。 */
    static VR dictionaryVr(int tag) {
        if (((tag >>> 16) & 1) == 1) {
            return null;
        }
        VR vr = ElementDictionary.getStandardElementDictionary().vrOf(tag);
        return vr == VR.UN ? null : vr;
    }

    /** {@code (gggg,eeee)} または キーワード を数値のタグに。読めなければ -1。 */
    static int parseTag(String s) {
        if (s == null) {
            return -1;
        }
        String t = s.trim();
        var m = Pattern.compile("^\\(?([0-9A-Fa-f]{4}),?([0-9A-Fa-f]{4})\\)?$").matcher(t);
        if (m.matches()) {
            return (int) Long.parseLong(m.group(1) + m.group(2), 16);
        }
        int byKw = ElementDictionary.tagForKeyword(t, null);
        return byKw == -1 ? -1 : byKw;
    }

    static String format(int tag) {
        return String.format("(%04X,%04X)", tag >>> 16, tag & 0xFFFF);
    }

    private static final Pattern DS = Pattern.compile("^ *[+-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)? *$");
    private static final Pattern IS = Pattern.compile("^ *[+-]?\\d+ *$");
    private static final Pattern CS = Pattern.compile("^[A-Z0-9 _]*$");
    private static final Pattern AS = Pattern.compile("^\\d{3}[DWMY]$");
    private static final Pattern DA = Pattern.compile("^(\\d{4})(\\d{2})(\\d{2})$");
    private static final Pattern TM = Pattern.compile("^([01]\\d|2[0-3])([0-5]\\d([0-5]\\d|60)?(\\.\\d{1,6})?)?$");
    private static final Pattern DT = Pattern.compile(
            "^\\d{4}(\\d{2}(\\d{2}(\\d{2}(\\d{2}(\\d{2}(\\.\\d{1,6})?)?)?)?)?)?([+-]\\d{4})?$");

    /**
     * 値が VR の決まりに合わないときの理由。合えば null。空は「値なし」として許す。
     * 理由: format / tooLong / badChars / outOfRange
     */
    static String valueError(VR vr, String value) {
        if (value == null || value.isEmpty()) {
            return null;
        }
        if (SINGLE.contains(vr)) {
            return one(vr, value);
        }
        for (String v : value.split("\\\\", -1)) {
            String e = one(vr, v);
            if (e != null) {
                return e;
            }
        }
        return null;
    }

    private static String one(VR vr, String v) {
        if (v.isEmpty()) {
            return null;
        }
        boolean text = vr == VR.LT || vr == VR.ST || vr == VR.UT;
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            boolean allowedCtl = text && (c == '\r' || c == '\n' || c == '\t' || c == '\f');
            if ((c < 0x20 && c != 0x1B && !allowedCtl) || c == 0x7F) {
                return "badChars";
            }
        }
        return switch (vr) {
            case AE -> v.length() > 16 ? "tooLong" : ascii(v) ? null : "badChars";
            case AS -> AS.matcher(v).matches() ? null : "format";
            case CS -> v.length() > 16 ? "tooLong" : CS.matcher(v).matches() ? null : "badChars";
            case DA -> date(v);
            case DS -> v.length() > 16 ? "tooLong" : DS.matcher(v).matches() ? null : "format";
            case DT -> v.length() > 26 ? "tooLong" : !DT.matcher(v).matches() ? "format"
                    : v.length() >= 8 ? date(v.substring(0, 8)) : null;
            case IS -> v.length() > 12 ? "tooLong" : !IS.matcher(v).matches() ? "format"
                    : range(Long.parseLong(v.trim().replace("+", "")), Integer.MIN_VALUE, Integer.MAX_VALUE);
            case LO -> v.length() > 64 ? "tooLong" : null;
            case SH -> v.length() > 16 ? "tooLong" : null;
            case LT -> v.length() > 10240 ? "tooLong" : null;
            case ST -> v.length() > 1024 ? "tooLong" : null;
            case PN -> personName(v);
            case TM -> v.length() > 14 ? "tooLong" : TM.matcher(v).matches() ? null : "format";
            case UR -> v.startsWith(" ") ? "format" : ascii(v) ? null : "badChars";
            case UC, UT -> null;
            case US -> integer(v, 0, 0xFFFF);
            case SS -> integer(v, Short.MIN_VALUE, Short.MAX_VALUE);
            case UL -> integer(v, 0, 0xFFFFFFFFL);
            case SL -> integer(v, Integer.MIN_VALUE, Integer.MAX_VALUE);
            case SV -> integer(v, Long.MIN_VALUE, Long.MAX_VALUE);
            case UV -> v.trim().matches("^\\+?\\d{1,20}$") && new java.math.BigInteger(v.trim().replace("+", ""))
                    .compareTo(new java.math.BigInteger("18446744073709551615")) <= 0 ? null : "outOfRange";
            case FL, FD -> floating(v);
            default -> "format";
        };
    }

    private static boolean ascii(String v) {
        return v.chars().allMatch(c -> c >= 0x20 && c < 0x7F);
    }

    /** DA（YYYYMMDD）。DT の日付部分にも使う。 */
    private static String date(String v) {
        var m = DA.matcher(v);
        if (!m.matches()) {
            return "format";
        }
        try {
            LocalDate.of(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)));
            return null;
        } catch (DateTimeException e) {
            return "format";
        }
    }

    private static String personName(String v) {
        String[] groups = v.split("=", -1);
        if (groups.length > 3) {
            return "format";
        }
        for (String g : groups) {
            if (g.length() > 64) {
                return "tooLong";
            }
            if (g.split("\\^", -1).length > 5) {
                return "format";
            }
        }
        return null;
    }

    private static String integer(String v, long min, long max) {
        String t = v.trim();
        if (!t.matches("^[+-]?\\d{1,19}$")) {
            return "format";
        }
        try {
            return range(Long.parseLong(t.replace("+", "")), min, max);
        } catch (NumberFormatException e) {
            return "outOfRange";
        }
    }

    private static String range(long n, long min, long max) {
        return n < min || n > max ? "outOfRange" : null;
    }

    /** FL・FD は文字で書かれた 10 進の数（NaN・Infinity・Java の接尾辞 f/d は断る）。 */
    private static String floating(String v) {
        return DS.matcher(v).matches() && Double.isFinite(Double.parseDouble(v.trim())) ? null : "format";
    }
}

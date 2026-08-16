/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import java.lang.reflect.Field;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.ElementDictionary;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;

/**
 * サイドカー JSON（dcm2niix / BIDS が出す {@code *.json}）を DICOM 属性へ写す。
 *
 * <p>Swing 版 GRAPHY と同じ方針で、<b>JSON のキー名を DICOM キーワードとして解釈</b>する
 * （完全一致 → 1 文字までの誤差を許すあいまい一致）。BIDS のキーは DICOM キーワードから
 * 派生しているものが多く（{@code RepetitionTime} / {@code FlipAngle} / {@code MagneticFieldStrength} 等）、
 * 個別マッピング表を持つより取りこぼしが少ない。
 *
 * <p><b>時間系は秒 → ミリ秒へ換算する</b>（BIDS は秒、DICOM は ms）。
 * 幾何・画素・識別子など<b>変換側が責任を持つタグは上書きさせない</b>。
 */
public final class NiftiMetadataMapper {

    /** 正規化キーワード → タグ。 */
    private static final Map<String, Integer> DICT = buildDictionary();

    /** 秒 → ミリ秒へ直すタグ（BIDS は秒で書く）。 */
    private static final int[] TIME_TAGS_SEC_TO_MS = {
        Tag.RepetitionTime, Tag.EchoTime, Tag.InversionTime,
    };

    /** 変換側が決めるので JSON で上書きさせないタグ。 */
    private static final int[] PROTECTED_TAGS = {
        Tag.PixelData, Tag.ImagePositionPatient, Tag.ImageOrientationPatient, Tag.PixelSpacing,
        Tag.SliceThickness, Tag.SpacingBetweenSlices, Tag.Rows, Tag.Columns, Tag.BitsAllocated,
        Tag.BitsStored, Tag.HighBit, Tag.PixelRepresentation, Tag.SamplesPerPixel,
        Tag.PhotometricInterpretation, Tag.PlanarConfiguration, Tag.RescaleSlope, Tag.RescaleIntercept,
        Tag.SOPInstanceUID, Tag.SOPClassUID, Tag.StudyInstanceUID, Tag.SeriesInstanceUID,
        Tag.FrameOfReferenceUID, Tag.PatientID, Tag.PatientName, Tag.Modality, Tag.InstanceNumber,
        Tag.SeriesNumber, Tag.TemporalPositionIndex, Tag.NumberOfTemporalPositions, Tag.SliceLocation,
        Tag.TransferSyntaxUID, Tag.SpecificCharacterSet,
    };

    private NiftiMetadataMapper() {
    }

    private static Map<String, Integer> buildDictionary() {
        Map<String, Integer> dict = new HashMap<>();
        for (Field f : Tag.class.getFields()) {
            if (f.getType() != int.class) {
                continue;
            }
            try {
                dict.put(normalize(f.getName()), f.getInt(null));
            } catch (IllegalAccessException ignore) {
                // public static final なので通らない
            }
        }
        return Map.copyOf(dict);
    }

    private static String normalize(String s) {
        return s.toLowerCase().replace("_", "").replace("-", "").replace(" ", "");
    }

    /**
     * JSON のキーに対応する DICOM タグを探す。完全一致 → 編集距離 1 まで許容。
     *
     * @return 見つからなければ null
     */
    public static Integer findTag(String jsonKey) {
        if (jsonKey == null || jsonKey.isBlank()) {
            return null;
        }
        String key = normalize(jsonKey);
        Integer exact = DICT.get(key);
        if (exact != null) {
            return exact;
        }
        // 「Manufacturers…」のような 1 文字違いを拾う（Swing 版と同じ許容）
        for (Map.Entry<String, Integer> e : DICT.entrySet()) {
            if (Math.abs(key.length() - e.getKey().length()) > 1) {
                continue;
            }
            if (levenshtein(key, e.getKey()) <= 1) {
                return e.getValue();
            }
        }
        return null;
    }

    /** 変換側が決めるタグか（true なら JSON で上書きしない）。 */
    public static boolean isProtected(int tag) {
        for (int t : PROTECTED_TAGS) {
            if (t == tag) {
                return true;
            }
        }
        return false;
    }

    /**
     * JSON の内容を属性へ写す。
     *
     * @return 写せたキーの数
     */
    public static int apply(Attributes ds, Map<String, Object> meta) {
        if (meta == null || meta.isEmpty()) {
            return 0;
        }
        int applied = 0;
        for (Map.Entry<String, Object> e : meta.entrySet()) {
            Object value = e.getValue();
            if (value == null) {
                continue;
            }
            Integer tag = findTag(e.getKey());
            if (tag == null || isProtected(tag)) {
                continue;
            }
            if (setValue(ds, tag, value)) {
                applied++;
            }
        }
        return applied;
    }

    private static boolean isSecondsTag(int tag) {
        for (int t : TIME_TAGS_SEC_TO_MS) {
            if (t == tag) {
                return true;
            }
        }
        return false;
    }

    private static boolean setValue(Attributes ds, int tag, Object value) {
        VR vr = ElementDictionary.getStandardElementDictionary().vrOf(tag);
        if (vr == null || vr == VR.SQ || vr == VR.OB || vr == VR.OW || vr == VR.UN) {
            return false; // シーケンス・バイナリは JSON からは入れない
        }
        double multiplier = isSecondsTag(tag) ? 1000.0 : 1.0;

        if (value instanceof List<?> list) {
            if (list.isEmpty()) {
                return false;
            }
            String[] out = new String[list.size()];
            for (int i = 0; i < list.size(); i++) {
                out[i] = asString(list.get(i), vr, multiplier);
            }
            ds.setString(tag, vr, out);
            return true;
        }
        String s = asString(value, vr, multiplier);
        if (s == null) {
            return false;
        }
        ds.setString(tag, vr, s);
        return true;
    }

    /** VR に合わせて文字列化する（数値系は倍率を掛け、整数系は丸める）。 */
    private static String asString(Object value, VR vr, double multiplier) {
        if (value == null) {
            return null;
        }
        Double num = null;
        if (value instanceof Number n) {
            num = n.doubleValue();
        } else if (value instanceof String str) {
            try {
                num = Double.valueOf(str);
            } catch (NumberFormatException ignore) {
                num = null;
            }
        } else if (value instanceof Boolean b) {
            return b ? "YES" : "NO";
        }

        boolean numericVr = vr == VR.DS || vr == VR.FD || vr == VR.FL || vr == VR.IS
                || vr == VR.US || vr == VR.SS || vr == VR.UL || vr == VR.SL;
        if (num != null && numericVr) {
            double v = num * multiplier;
            if (vr == VR.IS || vr == VR.US || vr == VR.SS || vr == VR.UL || vr == VR.SL) {
                return Long.toString(Math.round(v));
            }
            // DS は 16 文字までなので、無駄な桁を落とす
            String s = String.format("%.6f", v);
            s = s.replaceAll("0+$", "").replaceAll("\\.$", "");
            return s.length() <= 16 ? s : s.substring(0, 16);
        }
        if (numericVr) {
            return null; // 数値 VR に非数値は入れない（黙って壊さない）
        }
        return String.valueOf(value);
    }

    private static int levenshtein(String a, String b) {
        int[] prev = new int[b.length() + 1];
        int[] cur = new int[b.length() + 1];
        for (int j = 0; j <= b.length(); j++) {
            prev[j] = j;
        }
        for (int i = 1; i <= a.length(); i++) {
            cur[0] = i;
            for (int j = 1; j <= b.length(); j++) {
                int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
                cur[j] = Math.min(Math.min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
            }
            int[] tmp = prev;
            prev = cur;
            cur = tmp;
        }
        return prev[b.length()];
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

import java.util.Set;

/**
 * Export のフォルダ/ファイル名生成（<b>人が読める名前</b>）。
 *
 * <p>階層: 患者=PatientID / 検査=検査日(YYYY-MM-DD) / シリーズ=SeriesDescription（無ければ ProtocolName）。
 * Windows を含む一般的なファイルシステムで安全になるよう、禁止文字・末尾ドット/空白・予約デバイス名を回避し、
 * 長さも制限する。
 */
public final class ExportNaming {

    private ExportNaming() {}

    /** フォルダ/ファイル名の最大長（深いパスでの総長対策）。 */
    private static final int MAX_LEN = 64;

    /** Windows 禁止文字（{@code < > : " / \ | ? *}）＋制御文字。 */
    private static final String FORBIDDEN = "[<>:\"/\\\\|?*\\x00-\\x1f]";

    /** Windows 予約デバイス名（拡張子を除いた基底名で比較）。 */
    private static final Set<String> RESERVED = Set.of(
            "CON", "PRN", "AUX", "NUL",
            "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
            "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9");

    /**
     * 任意文字列を安全なフォルダ/ファイル名へ変換する。空・無効になった場合は {@code fallback} を返す。
     */
    public static String safeName(String raw, String fallback) {
        String s = raw == null ? "" : raw.trim();
        s = s.replaceAll(FORBIDDEN, "_");
        // 先頭・末尾の空白とドットを除去（Windows は末尾ドット/空白を許さない）
        s = s.replaceAll("^[ .]+", "").replaceAll("[ .]+$", "");
        if (s.length() > MAX_LEN) {
            s = s.substring(0, MAX_LEN).replaceAll("[ .]+$", "");
        }
        if (s.isEmpty()) {
            return fallback;
        }
        // 予約名は接頭辞を付けて回避
        String base = s.contains(".") ? s.substring(0, s.indexOf('.')) : s;
        if (RESERVED.contains(base.toUpperCase())) {
            s = "_" + s;
        }
        return s;
    }

    /**
     * DICOM の検査日（DA, {@code YYYYMMDD}）を {@code "YYYY-MM-DD"} に整形する。ハイフンは
     * Windows で許容される。不正・欠落なら {@code null}。
     */
    public static String formatStudyDate(String da) {
        if (da == null) {
            return null;
        }
        String d = da.trim();
        if (d.length() < 8) {
            return null;
        }
        String ymd = d.substring(0, 8);
        for (int i = 0; i < 8; i++) {
            if (!Character.isDigit(ymd.charAt(i))) {
                return null;
            }
        }
        return ymd.substring(0, 4) + "-" + ymd.substring(4, 6) + "-" + ymd.substring(6, 8);
    }

    /** 画像（葉）ファイル名。連番 8 桁＋{@code .dcm}（例 {@code 00000001.dcm}）。 */
    public static String imageName(int index) {
        return String.format("%08d.dcm", index);
    }

    /** 親フォルダ内で一意な名前にする（既出なら {@code _2, _3, ...} を付与）。 */
    public static String unique(String base, Set<String> usedInParent) {
        String name = base;
        int n = 2;
        while (!usedInParent.add(name)) {
            name = base + "_" + n++;
        }
        return name;
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.export;

/**
 * DICOM 交換メディア（PS3.10）に準拠したファイル ID 生成。
 *
 * <p>DICOMDIR の各ディレクトリレコード／ReferencedFileID が要求する制約:
 * 1 要素は最大 8 文字、英大文字 {@code A–Z}・数字 {@code 0–9}・{@code _} のみ、拡張子なし。
 * これに合わせて {@code PAT00001 / STU00001 / SER00001} と画像 {@code 00000001} を割り当てる。
 */
public final class MediaNaming {

    private MediaNaming() {}

    /**
     * 階層ディレクトリ名（接頭辞＋ゼロ詰め連番）。接頭辞 3 文字＋5 桁で 8 文字に収める。
     * 例: {@code dirName("PAT", 1)} → {@code "PAT00001"}。
     */
    public static String dirName(String prefix, int index) {
        int digits = Math.max(1, 8 - prefix.length());
        return prefix + String.format("%0" + digits + "d", index);
    }

    /** 画像（葉）ファイル名。接頭辞なし 8 桁で最大 99,999,999 枚/シリーズに対応。 */
    public static String imageName(int index) {
        return String.format("%08d", index);
    }

    /** PS3.10 のファイル ID 要素として妥当か（≤8 文字, 英大文字/数字/アンダースコア）。 */
    public static boolean isValidFileId(String s) {
        return s != null && !s.isEmpty() && s.length() <= 8 && s.matches("[A-Z0-9_]+");
    }
}

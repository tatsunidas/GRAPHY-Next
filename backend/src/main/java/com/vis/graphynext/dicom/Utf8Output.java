/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;

import java.util.Arrays;

/** 本体が新しく作る DICOM の文字コードをそろえる。 */
public final class Utf8Output {

    private Utf8Output() {}

    /**
     * 元画像から属性を写し終えた {@code a} を UTF-8（{@code ISO_IR 192}）で書くようにする。
     * 元の {@code SpecificCharacterSet} を引き継いだままだと、欧文用のときに日本語が書き出しで {@code ?} になる。
     *
     * <p>写した値は元の文字コードの生のバイトのことがあるので、<b>宣言を差し替える前に復号する</b>。
     * 宣言の無い元は復号しない（宣言なしで UTF-8 などを入れた規格外のデータを、バイトのまま残すため）。
     *
     * <p><b>写しがすべて終わってから呼ぶこと</b>。後から元の生のバイトを写すと、UTF-8 として読まれる。
     */
    public static void apply(Attributes a) {
        String[] declared = a.getStrings(Tag.SpecificCharacterSet);
        if (declared != null && Arrays.stream(declared).anyMatch(c -> c != null && !c.isEmpty())) {
            a.setSpecificCharacterSet("ISO_IR 192"); // dcm4che は、今の宣言で全値（入れ子も）を復号してから差し替える
        } else {
            a.setString(Tag.SpecificCharacterSet, VR.CS, "ISO_IR 192"); // 復号せず、宣言だけを付ける
        }
    }
}

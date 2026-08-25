/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;

/**
 * プラグインが書いた SR に<b>出所を刻む</b>（{@code fw/plugin-architecture.md} §7）。
 *
 * <p>規則は H4b / H9 と同じにそろえる——{@code SeriesDescription} に {@code [Plugin] } を付け、
 * {@code ContributingEquipmentSequence} にプラグイン id・表示名・版を入れる。
 * <b>出力を見ただけで「誰が計算したか」が分かる</b>ようにするためのもので、
 * 数値の意味が製品ごとに違う（半値法 / 密度計測）この領域では特に要る。
 */
final class AngioSrProvenance {

    /** H9 と同じ接頭辞。**一覧での見え方をそろえる**（片方だけ違うと混乱する）。 */
    static final String PLUGIN_PREFIX = "[Plugin] ";
    /** DICOM の LO は 64 文字。 */
    private static final int LO_MAX = 64;

    private AngioSrProvenance() {
    }

    static void stamp(Attributes ds, AngioPluginSrRequest.Producer p) {
        if (ds == null || p == null) {
            return;
        }
        String desc = ds.getString(Tag.SeriesDescription, "");
        if (!desc.startsWith(PLUGIN_PREFIX)) {
            String out = PLUGIN_PREFIX + desc;
            ds.setString(Tag.SeriesDescription, VR.LO, out.length() <= LO_MAX ? out : out.substring(0, LO_MAX));
        }
        Attributes eq = new Attributes(4);
        eq.setString(Tag.Manufacturer, VR.LO, "GRAPHY-Next plugin");
        eq.setString(Tag.ManufacturerModelName, VR.LO,
                p.name() != null && !p.name().isBlank() ? p.name() : p.id());
        eq.setString(Tag.SoftwareVersions, VR.LO, p.version() != null ? p.version() : "");
        eq.setString(Tag.ContributionDescription, VR.ST, "Angio analysis produced by plugin " + p.id());
        ds.newSequence(Tag.ContributingEquipmentSequence, 1).add(eq);
    }
}

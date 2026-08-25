/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * プラグインが書いた SR の<b>出所</b>（{@code fw/plugin-architecture.md} §7 の H37）。
 *
 * <p>ここが抜けると、保管庫の中で「本体が計算した値」と「プラグインが計算した値」を
 * <b>見分けられなくなる</b>。この領域は製品ごとに径の測り方が違う（半値法 / 密度計測）ので、
 * 誰が出した数字かは数字そのものと同じくらい重要。
 */
class AngioSrProvenanceTest {

    private static final AngioPluginSrRequest.Producer P =
            new AngioPluginSrRequest.Producer("angio-quant", "Angio Quant", "0.1.0");

    private static Attributes ds(String seriesDescription) {
        Attributes a = new Attributes();
        a.setString(Tag.SeriesDescription, VR.LO, seriesDescription);
        return a;
    }

    @Test
    void stampsPluginPrefixAndContributingEquipment() {
        Attributes a = ds("QCA");
        AngioSrProvenance.stamp(a, P);

        assertEquals("[Plugin] QCA", a.getString(Tag.SeriesDescription), "一覧での見え方を H9 とそろえる");
        Attributes eq = a.getNestedDataset(Tag.ContributingEquipmentSequence);
        assertNotNull(eq, "誰が計算したかを刻む");
        assertEquals("GRAPHY-Next plugin", eq.getString(Tag.Manufacturer));
        assertEquals("Angio Quant", eq.getString(Tag.ManufacturerModelName));
        assertEquals("0.1.0", eq.getString(Tag.SoftwareVersions));
        assertTrue(eq.getString(Tag.ContributionDescription).contains("angio-quant"), "id も残す");
    }

    @Test
    void doesNotDoublePrefix() {
        Attributes a = ds("[Plugin] QCA");
        AngioSrProvenance.stamp(a, P);
        assertEquals("[Plugin] QCA", a.getString(Tag.SeriesDescription));
    }

    @Test
    void truncatesToLoLimit() {
        // DICOM の LO は 64 文字。接頭辞で溢れたら切る（不正な長さの要素を書かない）。
        String longDesc = "x".repeat(64);
        Attributes a = ds(longDesc);
        AngioSrProvenance.stamp(a, P);
        assertEquals(64, a.getString(Tag.SeriesDescription).length());
        assertTrue(a.getString(Tag.SeriesDescription).startsWith("[Plugin] "));
    }

    @Test
    void nameFallsBackToId() {
        Attributes a = ds("QCA");
        AngioSrProvenance.stamp(a, new AngioPluginSrRequest.Producer("angio-quant", "  ", null));
        Attributes eq = a.getNestedDataset(Tag.ContributingEquipmentSequence);
        assertEquals("angio-quant", eq.getString(Tag.ManufacturerModelName));
        // 版が無ければ**長さ 0 の要素**として書く（dcm4che は getString で null を返す）。
        // 要素ごと落とすと「版を書かないプラグイン」と「版を書き忘れた本体」の区別が付かない。
        assertTrue(eq.contains(Tag.SoftwareVersions), "版が無くても要素は書く");
        assertNull(eq.getString(Tag.SoftwareVersions), "空値は null として読める");
    }

    @Test
    void nullProducerLeavesDatasetUntouched() {
        // 本体の経路（producer 無し）ではこの関数を通らないが、通っても壊さない。
        Attributes a = ds("QCA");
        AngioSrProvenance.stamp(a, null);
        assertEquals("QCA", a.getString(Tag.SeriesDescription));
        assertNull(a.getSequence(Tag.ContributingEquipmentSequence));
        assertFalse(a.contains(Tag.ContributingEquipmentSequence));
    }
}

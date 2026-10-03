/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.vis.graphynext.anonymize.AnonymizeService;

import java.util.Set;

/**
 * 外部の計算機へ送ってよいシリーズか（画素に写った患者情報＝焼き込み）。設計: fw/remote-compute-design.md §3.2。
 *
 * <p>ローカルへの書き出し（匿名化ツール）は、マスクの無いシリーズを「件数を見せて通す」。
 * 外へ出す経路ではそれでは足りないので、<b>焼き込みが普通にある種類はマスクが無ければ拒否する</b>。
 * 判定材料は {@link AnonymizeService#seriesBurnFacts}（既存の焼き込み事前検査＋元ファイルの
 * BurnedInAnnotation）。拒否は利用者もプラグインも解除できない——解除したければマスクを登録する。
 */
final class RemoteBurnPolicy {

    /** マスクが無ければ送らないモダリティ（焼き込みが普通にあり、BurnedInAnnotation が当てにならない）。 */
    static final Set<String> RISKY_MODALITIES = Set.of(
            "US", "XA", "RF", "ES", "SC", "OT", "DX", "CR", "MG", "XC", "GM", "SM", "IVUS", "IVOCT", "DOC");

    /** マスクが無ければ送らない SOP クラス（の接頭辞）。二次キャプチャ・可視光（写真・動画）・PDF。 */
    static final Set<String> RISKY_SOP_PREFIXES = Set.of(
            "1.2.840.10008.5.1.4.1.1.7",      // Secondary Capture（.7.1〜.7.4 を含む）
            "1.2.840.10008.5.1.4.1.1.77.1",   // VL（内視鏡・顕微鏡・写真・動画）
            "1.2.840.10008.5.1.4.1.1.104");   // Encapsulated PDF / CDA

    /**
     * @param allowed  送ってよいか
     * @param reason   拒否の理由（コード。画面で訳す）。許可なら null
     * @param burnIn   匿名化で焼き込みを塗るか（マスクがあるときだけ true）
     */
    record Decision(boolean allowed, String reason, boolean burnIn) {
        static Decision refuse(String reason) {
            return new Decision(false, reason, false);
        }
    }

    private RemoteBurnPolicy() {
    }

    static Decision decide(AnonymizeService.SeriesBurnFacts f) {
        if (f.instances() == 0) {
            return Decision.refuse("series-not-found");
        }
        AnonymizeService.BurnPreflight p = f.preflight();
        if (p.blocked() > 0) {
            // マスクはあるのに塗れない（圧縮を伸長できない・マスクが当たらないインスタンスがある）
            return Decision.refuse("burnin-mask-blocked");
        }
        if (p.unmasked() == 0 && p.burnable() > 0) {
            return new Decision(true, null, true); // 全インスタンスをマスクで塗る
        }
        if (p.burnable() > 0) {
            // マスクはシリーズ単位なので通常は起きない。半端に塗ったものは送らない
            return Decision.refuse("burnin-mask-partial");
        }
        if (f.burnedInYes() > 0) {
            return Decision.refuse("burnin-declared");
        }
        for (String m : f.modalities()) {
            if (RISKY_MODALITIES.contains(m.toUpperCase(java.util.Locale.ROOT))) {
                return Decision.refuse("burnin-risky-modality");
            }
        }
        for (String sop : f.sopClassUids()) {
            for (String prefix : RISKY_SOP_PREFIXES) {
                if (sop.equals(prefix) || sop.startsWith(prefix + ".")) {
                    return Decision.refuse("burnin-risky-sop-class");
                }
            }
        }
        if (f.modalities().isEmpty()) {
            return Decision.refuse("burnin-unknown-modality"); // 種類が分からないものは送らない
        }
        return new Decision(true, null, false);
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 画像を読んだときに、画素値へ掛けた校正（PET の SUV など）の記録。
 *
 * @param valueUnit      計算に使った値の単位（{@code HU}・{@code SUVbw}・{@code SUVlbm}・{@code SUVbsa}・
 *                       {@code BQML（未校正）}・{@code SUV（元の値）}）。単位が分からないときは空
 * @param type           校正の種類（{@code bw}・{@code sul-james}・{@code sul-janma}・{@code bsa}・{@code none}・
 *                       {@code already-suv}）。校正を扱わない読み込み（PET 以外・従来の経路）は空
 * @param scale          画素値に掛けた係数（掛けなかったときは 1）
 * @param warnings       係数の計算の警告
 * @param uncalibratedPet PET を、利用者の明示で校正せずに（Bq/mL のまま）読んだ
 * @param facts          値の種類（{@link ValueKind}）の判定の材料。ヘッダを読まなかった経路は null
 */
public record ValueCalibration(String valueUnit, String type, double scale, List<String> warnings,
                               boolean uncalibratedPet, ValueKind.Facts facts) {

    /** 判定の材料なし（従来の作り方）。 */
    public ValueCalibration(String valueUnit, String type, double scale, List<String> warnings,
                            boolean uncalibratedPet) {
        this(valueUnit, type, scale, warnings, uncalibratedPet, null);
    }

    ValueCalibration withFacts(ValueKind.Facts f) {
        return new ValueCalibration(valueUnit, type, scale, warnings, uncalibratedPet, f);
    }

    /** 校正を扱わない読み込み（従来の経路・PET 以外で単位が分からないとき）。 */
    public static final ValueCalibration UNSET = new ValueCalibration("", "", 1.0, List.of(), false);

    /** CT（HU）。校正はしない。 */
    public static final ValueCalibration HU = new ValueCalibration("HU", "", 1.0, List.of(), false);

    /** 結果の表の {@code Provenance_Calibration} 列の文字列。校正しなかった（係数を掛けなかった）ときは空。 */
    public String text() {
        if (type == null || type.isEmpty()) {
            return "";
        }
        StringBuilder b = new StringBuilder(type).append(";scale=").append(scale);
        for (String w : warnings) {
            b.append(';').append(w);
        }
        return b.toString();
    }

    /** 画素値に掛ける係数が 1 でなければ true。 */
    public boolean scales() {
        return Double.compare(scale, 1.0) != 0;
    }

    /**
     * 校正の指定（{@link RoiFeatureRequest#calibration}）と、シリーズの最初のインスタンスのヘッダから、校正を決める。
     * PET の SUV は、体重・投与量・時刻などのタグから求め、欠けていれば<b>理由つきで断る</b>（既定値や 0 で埋めない）。
     * 係数は最初のインスタンスから求め、最後のインスタンスの係数と食い違えば警告を付ける。
     *
     * @param requested 校正の指定（auto・none・bw・sul-james・sul-janma・bsa）
     * @param first     最初のインスタンスのヘッダ（画素の前まで）
     * @param last      最後のインスタンスのヘッダ。同じインスタンス・マルチフレームなら null
     * @throws IllegalArgumentException PET 以外に SUV を指定した、または SUV を計算できない
     */
    static ValueCalibration resolve(String requested, Attributes first, Attributes last) {
        String req = requested.trim().toLowerCase(Locale.ROOT);
        String modality = String.valueOf(first.getString(Tag.Modality, "")).trim().toUpperCase(Locale.ROOT);
        return resolveCalibration(req, modality, first, last).withFacts(ValueKind.factsOf(first, last));
    }

    private static ValueCalibration resolveCalibration(String req, String modality, Attributes first, Attributes last) {
        boolean pet = modality.equals("PT") || modality.equals("PET");
        PetSuvCalibration.Type type = PetSuvCalibration.Type.of(req);
        if (!pet) {
            if (type != null) {
                throw new IllegalArgumentException("SUV の校正は PET（Modality=PT）だけです（このシリーズは "
                        + (modality.isEmpty() ? "モダリティ不明" : modality) + "）");
            }
            return modality.equals("CT") ? HU : UNSET;
        }
        PetSuvCalibration.Params params = PetSuvCalibration.extract(first);
        if (params.alreadySuv()) {
            // すでに SUV 化されたシリーズ（Units=GML・SUVType・RescaleType）は、再校正しない
            return new ValueCalibration("SUV（元の値）", "already-suv", 1.0, List.of("alreadySuv"), false);
        }
        if (req.equals(RoiFeatureRequest.CALIBRATION_NONE)) {
            String unit = params.units() == null ? "" : params.units();
            return new ValueCalibration(unit + "（未校正）", "none", 1.0, List.of("uncalibratedPet"), true);
        }
        if (type == null) { // auto
            type = PetSuvCalibration.Type.BW;
        }
        PetSuvCalibration.Outcome out = PetSuvCalibration.compute(params, type);
        if (!out.ok()) {
            throw new IllegalArgumentException("PET を " + type.unit() + " に校正できません: "
                    + PetSuvCalibration.describe(out.error()) + "（校正しない（Bq/mL）を選べば、そのまま計算できます）");
        }
        List<String> warnings = new ArrayList<>(out.warnings());
        if (last != null) {
            PetSuvCalibration.Outcome o2 = PetSuvCalibration.compute(PetSuvCalibration.extract(last), type);
            if (!o2.ok() || Math.abs(o2.scale() - out.scale()) > Math.abs(out.scale()) * 1e-6) {
                warnings.add("scaleVariesAcrossSlices");
            }
        }
        return new ValueCalibration(out.unit(), type.id(), out.scale(), warnings, false);
    }
}

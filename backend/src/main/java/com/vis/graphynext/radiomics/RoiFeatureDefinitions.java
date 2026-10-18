/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import io.github.tatsunidas.radiomics.features.FractalFeatureType;
import io.github.tatsunidas.radiomics.features.GLAMFeatureType;
import io.github.tatsunidas.radiomics.features.GLCMFeatureType;
import io.github.tatsunidas.radiomics.features.GLDZMFeatureType;
import io.github.tatsunidas.radiomics.features.GLRLMFeatureType;
import io.github.tatsunidas.radiomics.features.GLSZMFeatureType;
import io.github.tatsunidas.radiomics.features.IntensityBasedStatisticalFeatureType;
import io.github.tatsunidas.radiomics.features.IntensityHistogramFeatureType;
import io.github.tatsunidas.radiomics.features.IntensityVolumeHistogramFeatureType;
import io.github.tatsunidas.radiomics.features.LocalIntensityFeatureType;
import io.github.tatsunidas.radiomics.features.MorphologicalFeatureType;
import io.github.tatsunidas.radiomics.features.NGLDMFeatureType;
import io.github.tatsunidas.radiomics.features.NGTDMFeatureType;
import io.github.tatsunidas.radiomics.features.Shape2DFeatureType;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * RadiomicsJ の結果表の列名から、族・特徴名・IBSI コード・定義の注記を引く。
 *
 * <p>列名は {@code <族の接頭辞>_<enum の名前>}（接頭辞は RadiomicsJ {@code compute()} の文字列そのもの）。
 * IBSI コードは各 {@code *FeatureType} の {@code id()}。IBSI の識別子は英数字 4 文字で、パラメータ付きの
 * 特徴は枝番が付く（IVH の {@code BC2M_1}・{@code GBPN_2} など、割合 10%/90%）。それ以外の id
 * （Fractal・Shape2D の連番、GLAM の名前、一次統計の独自量 "1"〜"3"）は IBSI 外として扱う。
 *
 * <p>注記は RadiomicsJ のコードで確かめた事実だけを置く。訳は画面側の辞書で引く。
 */
final class RoiFeatureDefinitions {

    /** 尖度は −3 済みの過剰尖度（{@code IntensityBasedStatisticalFeatures.getExcessKurtosis}）。 */
    static final String NOTE_EXCESS_KURTOSIS = "EXCESS_KURTOSIS";
    /** 離散化したヒストグラムのエントロピーで、対数の底は 2。 */
    static final String NOTE_LOG2_DISCRETISED = "LOG2_DISCRETISED";
    /** IBSI の定義の外にある特徴。 */
    static final String NOTE_NON_IBSI = "NON_IBSI";

    /**
     * RadiomicsJ 2.4.1 の {@code DiagnosticsInfo} は、再セグメント後の形態マスクの数に強度マスクの数を入れている。
     * 形態マスクは再セグメントしないので、範囲フィルタ・外れ値除去を使うと実際の形態マスクの数と食い違う。
     */
    static final String NOTE_RJ_MORPH_COUNT_IS_INTENSITY = "RJ_MORPH_COUNT_IS_INTENSITY";

    static final String DIAGNOSTICS = "Diagnostics";

    /** IBSI の識別子（4 文字）と、パラメータ付きの特徴の枝番。 */
    private static final Pattern IBSI_ID = Pattern.compile("[0-9A-Z]{4}(_[0-9]+)?");

    /** 接頭辞 → enum の名前から id を引く関数。並びは RadiomicsJ の計算順。 */
    private static final Map<String, Function<String, String>> FAMILIES = new LinkedHashMap<>();

    static {
        FAMILIES.put("Morphology", n -> MorphologicalFeatureType.valueOf(n).id());
        FAMILIES.put("LocalIntensity", n -> LocalIntensityFeatureType.valueOf(n).id());
        FAMILIES.put("IntensityBasedStatistical", n -> IntensityBasedStatisticalFeatureType.valueOf(n).id());
        FAMILIES.put("IntensityHistogram", n -> IntensityHistogramFeatureType.valueOf(n).id());
        FAMILIES.put("IntensityVolumeHistogram", n -> IntensityVolumeHistogramFeatureType.valueOf(n).id());
        FAMILIES.put("Shape2D", n -> Shape2DFeatureType.valueOf(n).id());
        FAMILIES.put("GLCM", n -> GLCMFeatureType.valueOf(n).id());
        FAMILIES.put("GLRLM", n -> GLRLMFeatureType.valueOf(n).id());
        FAMILIES.put("GLSZM", n -> GLSZMFeatureType.valueOf(n).id());
        FAMILIES.put("GLDZM", n -> GLDZMFeatureType.valueOf(n).id());
        FAMILIES.put("NGTDM", n -> NGTDMFeatureType.valueOf(n).id());
        FAMILIES.put("NGLDM", n -> NGLDMFeatureType.valueOf(n).id());
        FAMILIES.put("Fractal", n -> FractalFeatureType.valueOf(n).id());
        FAMILIES.put("GLAM", n -> GLAMFeatureType.valueOf(n).id());
    }

    private RoiFeatureDefinitions() {}

    /** 列名を族・特徴・IBSI・注記に分ける。知らない接頭辞・名前は例外（RadiomicsJ の列名の変化に気づくため）。 */
    static RoiFeatureResult.Row row(String column, Double value) {
        int us = column.indexOf('_');
        if (us <= 0) {
            throw new IllegalStateException("RadiomicsJ の列名を解釈できません: " + column);
        }
        String family = column.substring(0, us);
        String feature = column.substring(us + 1);
        if (DIAGNOSTICS.equals(family)) {
            List<String> diagNotes = "DiagnosticsResegmentedROIMorphMaskVoxelCount".equals(feature)
                    ? List.of(NOTE_RJ_MORPH_COUNT_IS_INTENSITY) : List.of();
            return new RoiFeatureResult.Row(column, family, feature, null, value, diagNotes);
        }
        Function<String, String> idOf = FAMILIES.get(family);
        if (idOf == null) {
            throw new IllegalStateException("RadiomicsJ の族を解釈できません: " + column);
        }
        String id = idOf.apply(feature);
        String ibsi = id != null && IBSI_ID.matcher(id).matches() ? id : null;
        List<String> notes = new ArrayList<>();
        if (ibsi == null) {
            notes.add(NOTE_NON_IBSI);
        }
        if ("Kurtosis".equals(feature)
                && ("IntensityBasedStatistical".equals(family) || "IntensityHistogram".equals(family))) {
            notes.add(NOTE_EXCESS_KURTOSIS);
        }
        if ("Entropy".equals(feature) && "IntensityHistogram".equals(family)) {
            notes.add(NOTE_LOG2_DISCRETISED);
        }
        return new RoiFeatureResult.Row(column, family, feature, ibsi, value, List.copyOf(notes));
    }
}

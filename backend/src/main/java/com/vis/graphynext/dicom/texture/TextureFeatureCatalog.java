/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.texture;

import java.util.HashMap;
import java.util.Map;

import ij.ImagePlus;
import io.github.tatsunidas.radiomics.features.GLCMFeatureType;
import io.github.tatsunidas.radiomics.features.GLCMFeatures;
import io.github.tatsunidas.radiomics.features.GLDZMFeatureType;
import io.github.tatsunidas.radiomics.features.GLDZMFeatures;
import io.github.tatsunidas.radiomics.features.GLRLMFeatureType;
import io.github.tatsunidas.radiomics.features.GLRLMFeatures;
import io.github.tatsunidas.radiomics.features.GLSZMFeatureType;
import io.github.tatsunidas.radiomics.features.GLSZMFeatures;
import io.github.tatsunidas.radiomics.features.IntensityBasedStatisticalFeatureType;
import io.github.tatsunidas.radiomics.features.IntensityBasedStatisticalFeatures;
import io.github.tatsunidas.radiomics.features.IntensityHistogramFeatureType;
import io.github.tatsunidas.radiomics.features.IntensityHistogramFeatures;
import io.github.tatsunidas.radiomics.features.LocalIntensityFeatureType;
import io.github.tatsunidas.radiomics.features.LocalIntensityFeatures;
import io.github.tatsunidas.radiomics.features.NGLDMFeatureType;
import io.github.tatsunidas.radiomics.features.NGLDMFeatures;
import io.github.tatsunidas.radiomics.features.NGTDMFeatureType;
import io.github.tatsunidas.radiomics.features.NGTDMFeatures;
import io.github.tatsunidas.radiomics.features.RadiomicsFeature;
import io.github.tatsunidas.radiomics.main.FeatureCalculator;
import io.github.tatsunidas.radiomics.main.FeatureCalculatorFactory;
import io.github.tatsunidas.radiomics.main.FeatureSpecifier;

/**
 * Texture 可視化マップ用の特徴カタログ。特徴文字列 {@code "<FAMILY>_<FeatureName>"} を
 * RadiomicsJ の族クラス＋特徴 enum＋設定 Map に解決し、{@link FeatureCalculator} を組み立てる。
 *
 * <p>{@link FeatureCalculatorFactory} は {@code (ImagePlus,ImagePlus,Map)} コンストラクタを要求するため、
 * それを持つ族（テクスチャ6族／一次統計／局所強度）は Factory で生成する。
 * <b>IntensityHistogram だけは Map コンストラクタが無い</b>ため、実コンストラクタを呼ぶ
 * カスタム {@link FeatureCalculator} ラムダで対応する（設計 §4.1）。
 */
final class TextureFeatureCatalog {

    private TextureFeatureCatalog() {}

    /** 族メタ情報。 */
    private record Family(
            Class<? extends RadiomicsFeature> featClass,
            Class<? extends Enum<?>> enumType,
            String binPrefix,   // GRAPHY プロパティのビン系プレフィクス（GLCM/HIST 等）
            boolean hasDelta,
            boolean hasAlpha,
            boolean customHistogram) {
    }

    private static final Map<String, Family> FAMILIES = new HashMap<>();
    static {
        FAMILIES.put("GLCM", new Family(GLCMFeatures.class, GLCMFeatureType.class, "GLCM", true, false, false));
        FAMILIES.put("GLRLM", new Family(GLRLMFeatures.class, GLRLMFeatureType.class, "GLRLM", false, false, false));
        FAMILIES.put("GLSZM", new Family(GLSZMFeatures.class, GLSZMFeatureType.class, "GLSZM", false, false, false));
        FAMILIES.put("GLDZM", new Family(GLDZMFeatures.class, GLDZMFeatureType.class, "GLDZM", false, false, false));
        FAMILIES.put("NGTDM", new Family(NGTDMFeatures.class, NGTDMFeatureType.class, "NGTDM", true, false, false));
        FAMILIES.put("NGLDM", new Family(NGLDMFeatures.class, NGLDMFeatureType.class, "NGLDM", true, true, false));
        // 一次統計（first-order）。ビンは HIST の設定を流用。
        FAMILIES.put("FIRSTORDER",
                new Family(IntensityBasedStatisticalFeatures.class, IntensityBasedStatisticalFeatureType.class, "HIST", false, false, false));
        // 局所強度（LABEL のみ）。
        FAMILIES.put("LOCALINTENSITY",
                new Family(LocalIntensityFeatures.class, LocalIntensityFeatureType.class, "HIST", false, false, false));
        // ヒストグラム: Map コンストラクタ非対応 → カスタムラムダ。
        FAMILIES.put("HISTOGRAM",
                new Family(IntensityHistogramFeatures.class, IntensityHistogramFeatureType.class, "HIST", false, false, true));
    }

    /** 組み立て結果。 */
    record BuiltFeature(FeatureCalculator calculator, String displayName) {}

    /**
     * {@code "GLCM_JointEntropy"} 形式の特徴文字列から calculator を組み立てる。
     *
     * @param feature  "&lt;FAMILY&gt;_&lt;FeatureName&gt;"
     * @param settings GRAPHY Property キー→値（文字列）マップ
     */
    static BuiltFeature build(String feature, Map<String, String> settings) {
        if (feature == null || !feature.contains("_")) {
            throw new IllegalArgumentException("feature は \"FAMILY_FeatureName\" 形式が必要です: " + feature);
        }
        int us = feature.indexOf('_');
        String famKey = feature.substring(0, us).toUpperCase();
        String featName = feature.substring(us + 1);
        Family fam = FAMILIES.get(famKey);
        if (fam == null) {
            throw new IllegalArgumentException("未対応の特徴ファミリーです（可視化マップ非対応）: " + famKey);
        }

        Enum<?> featureEnum = resolveEnum(fam.enumType(), featName);
        String featureId = enumId(featureEnum);

        int label = intOf(settings, "MASK_LABEL_INT", 1);
        boolean useBinCount = boolOf(settings, "BINCOUNT_" + fam.binPrefix() + "_BOOL", true);
        int nBins = intOf(settings, "BINCOUNT_" + fam.binPrefix() + "_INT", 16);
        Double binWidth = doubleOrNull(settings, "BINWIDTH_" + fam.binPrefix() + "_DOUBLE");

        String displayName = famKey + "_" + featName;

        // ヒストグラムは Map コンストラクタが無いためカスタム calculator。
        if (fam.customHistogram()) {
            final int fLabel = label;
            final boolean fUse = useBinCount;
            final int fBins = nBins;
            final Double fWidth = binWidth;
            FeatureCalculator calc = (subVol, subMask) -> {
                try {
                    IntensityHistogramFeatures f =
                            new IntensityHistogramFeatures(subVol, subMask, fLabel, fUse, fBins, fWidth);
                    return f.calculate(featureId);
                } catch (Exception e) {
                    return Double.NaN;
                }
            };
            return new BuiltFeature(calc, displayName);
        }

        // Map コンストラクタ族: 設定 Map を組んで Factory で生成。
        Map<String, Object> radSettings = new HashMap<>();
        radSettings.put(RadiomicsFeature.LABEL, Integer.valueOf(label));
        radSettings.put(RadiomicsFeature.USE_BIN_COUNT, Boolean.valueOf(useBinCount));
        radSettings.put(RadiomicsFeature.nBins, Integer.valueOf(nBins));
        if (binWidth != null) {
            radSettings.put(RadiomicsFeature.BinWidth, binWidth);
        }
        if (fam.hasDelta()) {
            radSettings.put(RadiomicsFeature.DELTA, Integer.valueOf(intOf(settings, "DELTA_" + famKey + "_DOUBLE", 1)));
        }
        if (fam.hasAlpha()) {
            radSettings.put(RadiomicsFeature.ALPHA, Integer.valueOf(intOf(settings, "ALPHA_" + famKey + "_DOUBLE", 1)));
        }

        FeatureSpecifier<? extends RadiomicsFeature> spec =
                new FeatureSpecifier<>(cast(fam.featClass()), featureEnum, radSettings);
        FeatureCalculator calc = new FeatureCalculatorFactory().create(spec);
        return new BuiltFeature(calc, displayName);
    }

    @SuppressWarnings("unchecked")
    private static <T extends RadiomicsFeature> Class<T> cast(Class<? extends RadiomicsFeature> c) {
        return (Class<T>) c;
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static Enum<?> resolveEnum(Class<? extends Enum<?>> enumType, String name) {
        try {
            return Enum.valueOf((Class) enumType, name);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("未対応の特徴名です: " + name + "（" + enumType.getSimpleName() + "）");
        }
    }

    private static String enumId(Enum<?> e) {
        try {
            Object id = e.getClass().getMethod("id").invoke(e);
            return id != null ? id.toString() : e.name();
        } catch (Exception ex) {
            return e.name();
        }
    }

    private static int intOf(Map<String, String> s, String key, int def) {
        if (s == null) return def;
        String v = s.get(key);
        if (v == null || v.isBlank()) return def;
        try {
            return (int) Math.round(Double.parseDouble(v.trim()));
        } catch (NumberFormatException e) {
            return def;
        }
    }

    private static boolean boolOf(Map<String, String> s, String key, boolean def) {
        if (s == null) return def;
        String v = s.get(key);
        if (v == null || v.isBlank()) return def;
        return Boolean.parseBoolean(v.trim());
    }

    private static Double doubleOrNull(Map<String, String> s, String key) {
        if (s == null) return null;
        String v = s.get(key);
        if (v == null || v.isBlank()) return null;
        try {
            double d = Double.parseDouble(v.trim());
            return Double.isNaN(d) ? null : d;
        } catch (NumberFormatException e) {
            return null;
        }
    }
}

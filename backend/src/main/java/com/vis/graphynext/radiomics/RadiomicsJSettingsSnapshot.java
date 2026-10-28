/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import io.github.tatsunidas.radiomics.main.RadiomicsJ;
import io.github.tatsunidas.radiomics.main.SettingParams;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * {@code loadSettings} の後の RadiomicsJ から、計算に実際に使う設定を読み出して RadiomicsJ の
 * {@code .properties} 形式に正規化する。
 *
 * <p>渡した設定そのものではなく読み込んだ後の状態を書くのは、{@code loadSettings} が範囲外の値を黙って
 * 丸め（ビン数 0→1 など）、数にならない値を既定のままにするため。全キーを名前順に {@code KEY=value} で並べ、
 * コメント行は付けない（{@link java.util.Properties#store} は日時を書くので使わない）ので、同じ設定なら同じ
 * バイト列＝同じ SHA-256 になる。null の値は空にする（{@code loadSettings} は空を読み飛ばすので、新しい
 * インスタンスの既定の null に戻る）。
 *
 * <p>族の有効化（インスタンスのフィールド）とリサンプリング（static）は RadiomicsJ の外から読めないので
 * リフレクションで読む。見つからなければ例外にする（版を上げて名前が変わったときに黙って既定値を書かない）。
 */
final class RadiomicsJSettingsSnapshot {

    private static final Map<SettingParams, Function<RadiomicsJ, String>> READERS = new EnumMap<>(SettingParams.class);

    static {
        put(SettingParams.INT_label, r -> s(RadiomicsJ.targetLabel));
        put(SettingParams.INT_interpolation2D, r -> s(RadiomicsJ.interpolation2D));
        put(SettingParams.INT_interpolation_mask2D, r -> s(RadiomicsJ.interpolation_mask2D));
        put(SettingParams.INT_interpolation3D, r -> s(RadiomicsJ.interpolation3D));
        put(SettingParams.INT_interpolation_mask3D, r -> s(RadiomicsJ.interpolation_mask3D));
        put(SettingParams.DOUBLE_Mask_PartialVolumeThareshold, r -> s(RadiomicsJ.mask_PartialVolumeThreshold));
        put(SettingParams.BOOL_interpolation_intensity_rounding, r -> b(RadiomicsJ.interpolation_intensity_rounding));
        put(SettingParams.BOOL_USE_FixedBinNumber, r -> b(RadiomicsJ.BOOL_USE_FixedBinNumber));
        put(SettingParams.BOOL_USE_GPU, r -> b(RadiomicsJ.BOOL_USE_GPU));
        put(SettingParams.DOUBLE_binWidth, r -> s(RadiomicsJ.binWidth));
        put(SettingParams.INT_binCount, r -> s(RadiomicsJ.nBins));
        put(SettingParams.BOOL_normalize, r -> b(RadiomicsJ.normalize));
        put(SettingParams.BOOL_removeOutliers, r -> b(RadiomicsJ.removeOutliers));
        put(SettingParams.DOUBLE_zScore, r -> s(RadiomicsJ.zScore));
        put(SettingParams.DOUBLE_normalizeScale, r -> s(RadiomicsJ.normalizeScale));
        put(SettingParams.DOUBLE_densityShift, r -> s(RadiomicsJ.densityShift));
        put(SettingParams.DOUBLE_rangeMax, r -> s(RadiomicsJ.rangeMax));
        put(SettingParams.DOUBLE_rangeMin, r -> s(RadiomicsJ.rangeMin));
        put(SettingParams.INT_IVH_binCount, r -> s(RadiomicsJ.IVH_binCount));
        put(SettingParams.DOUBLE_IVH_binWidth, r -> s(RadiomicsJ.IVH_binWidth));
        put(SettingParams.INT_IVH_MODE, r -> s(RadiomicsJ.IVH_mode));
        put(SettingParams.INT_alpha, r -> s(RadiomicsJ.alpha));
        put(SettingParams.INT_deltaGLCM, r -> s(RadiomicsJ.deltaGLCM));
        put(SettingParams.INT_deltaNGTDM, r -> s(RadiomicsJ.deltaNGToneDM));
        put(SettingParams.INT_deltaNGLDM, r -> s(RadiomicsJ.deltaNGLevelDM));
        put(SettingParams.INT_GLAM_maxRadius, r -> s(RadiomicsJ.glamMaxRadius));
        put(SettingParams.INT_GLAM_maxReferenceVoxels, r -> s(RadiomicsJ.glamMaxReferenceVoxels));
        put(SettingParams.BOOL_GLAM_boundaryCorrection, r -> b(RadiomicsJ.glamBoundaryCorrection));
        put(SettingParams.INT_GLAM_numRandomisations, r -> s(RadiomicsJ.glamNumRandomisations));
        put(SettingParams.LONG_GLAM_randomSeed, r -> s(RadiomicsJ.glamRandomSeed));
        put(SettingParams.INT_GLAM_savitzkyGolayWindow, r -> s(RadiomicsJ.glamSavitzkyGolayWindow));
        put(SettingParams.INT_GLAM_savitzkyGolayPolynomial, r -> s(RadiomicsJ.glamSavitzkyGolayPolynomial));
        put(SettingParams.DOUBLE_GLAM_peakProminence, r -> s(RadiomicsJ.glamPeakProminence));
        put(SettingParams.INT_GLAM_maxLocalShellRadius, r -> s(RadiomicsJ.glamMaxLocalShellRadius));
        put(SettingParams.STRING_weightingNorm, r -> s(RadiomicsJ.weightingNorm));
        put(SettingParams.INTARRAY_box_sizes, r -> RadiomicsJ.box_sizes == null ? ""
                : Arrays.stream(RadiomicsJ.box_sizes).mapToObj(Integer::toString).collect(Collectors.joining(",")));
        put(SettingParams.DOUBLEARRAY_resamplingFactorXYZ, r -> {
            double[] v = (double[]) read(null, "resamplingFactorXYZ");
            return v == null ? ""
                    : Arrays.stream(v).mapToObj(Double::toString).collect(Collectors.joining(","));
        });
        // 画像フィルタ（RadiomicsJ 2.5.0〜）。配列は loadSettings が読み戻せる区切り（数値は , 文字列の組は ;）で書く。
        put(SettingParams.DOUBLEARRAY_logSigmaMm, r -> doubles(RadiomicsJ.logSigmaMm));
        put(SettingParams.DOUBLE_logTruncate, r -> s(RadiomicsJ.logTruncate));
        put(SettingParams.STRING_logPadding, r -> s(RadiomicsJ.logPadding));
        put(SettingParams.INTARRAY_meanSupport, r -> ints(RadiomicsJ.meanSupport));
        put(SettingParams.STRING_meanPadding, r -> s(RadiomicsJ.meanPadding));
        put(SettingParams.STRING_lawsKernels, r -> join(RadiomicsJ.lawsKernels, ","));
        put(SettingParams.STRING_lawsPadding, r -> s(RadiomicsJ.lawsPadding));
        put(SettingParams.STRING_lawsPooling, r -> s(RadiomicsJ.lawsPooling));
        put(SettingParams.INT_lawsEnergyDelta, r -> s(RadiomicsJ.lawsEnergyDelta));
        put(SettingParams.STRING_gaborSets, r -> join(RadiomicsJ.gaborSets, ";"));
        put(SettingParams.STRING_gaborPadding, r -> s(RadiomicsJ.gaborPadding));
        put(SettingParams.STRING_gaborPooling, r -> s(RadiomicsJ.gaborPooling));
        put(SettingParams.DOUBLE_gaborDeltaTheta, r -> s(RadiomicsJ.gaborDeltaTheta));
        put(SettingParams.STRING_waveletSets, r -> join(RadiomicsJ.waveletSets, ";"));
        put(SettingParams.STRING_waveletPadding, r -> s(RadiomicsJ.waveletPadding));
        put(SettingParams.STRING_waveletPooling, r -> s(RadiomicsJ.waveletPooling));
        put(SettingParams.INTARRAY_simoncelliLevels, r -> ints(RadiomicsJ.simoncelliLevels));
        put(SettingParams.STRING_simoncelliPadding, r -> s(RadiomicsJ.simoncelliPadding));
        put(SettingParams.BOOL_force2D, r -> b(RadiomicsJ.force2D));
        put(SettingParams.BOOL_activate_no_default_features, r -> b(RadiomicsJ.activate_no_default_features));
        // 族の有効化はインスタンスのフィールドで、名前は設定キーと同じ。
        for (SettingParams p : SettingParams.values()) {
            if (p.name().startsWith("BOOL_enable")) {
                put(p, r -> b((Boolean) read(r, p.name())));
            }
        }
        for (SettingParams p : SettingParams.values()) {
            if (!READERS.containsKey(p)) {
                // RadiomicsJ に設定が増えたら、ここで止める（記録から黙って抜けるのを防ぐ）。
                throw new ExceptionInInitializerError("RadiomicsJ の設定の読み出しが未対応です: " + p.name());
            }
        }
    }

    private RadiomicsJSettingsSnapshot() {}

    /** 読み込み後の設定を正規化した {@code .properties} の本文（キーの名前順、改行は LF）。 */
    static String of(RadiomicsJ radiomics) {
        Map<String, String> sorted = new TreeMap<>();
        READERS.forEach((p, reader) -> sorted.put(p.name(), reader.apply(radiomics)));
        StringBuilder sb = new StringBuilder();
        sorted.forEach((k, v) -> sb.append(k).append('=').append(v).append('\n'));
        return sb.toString();
    }

    static String sha256(String properties) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(properties.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void put(SettingParams p, Function<RadiomicsJ, String> reader) {
        READERS.put(p, reader);
    }

    private static String s(Object v) {
        return v == null ? "" : v.toString();
    }

    private static String doubles(double[] v) {
        return v == null ? "" : Arrays.stream(v).mapToObj(Double::toString).collect(Collectors.joining(","));
    }

    private static String ints(int[] v) {
        return v == null ? "" : Arrays.stream(v).mapToObj(Integer::toString).collect(Collectors.joining(","));
    }

    private static String join(String[] v, String sep) {
        return v == null ? "" : String.join(sep, v);
    }

    private static String b(Boolean v) {
        return v != null && v ? "1" : "0";
    }

    private static Object read(RadiomicsJ target, String field) {
        try {
            Field f = RadiomicsJ.class.getDeclaredField(field);
            f.setAccessible(true);
            return f.get(target);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("RadiomicsJ の設定 " + field + " を読めません（版の変更？）", e);
        }
    }
}

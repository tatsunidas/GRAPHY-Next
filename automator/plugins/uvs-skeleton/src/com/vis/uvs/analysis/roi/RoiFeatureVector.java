package com.vis.uvs.analysis.roi;

import java.util.Arrays;

/**
 * クラスタリング用の特徴ベクトル（RadiomicsJ の特徴量とは別物）。
 *
 * <p>Swing 版は {@code Set<Feature>} で名前引きしていたが、
 * <b>次元の順序が固定なら配列で十分</b>かつ高速。名前は {@link #names()} が持つ。
 * NaN / Inf を含むベクトルは破棄する（Swing と同じ）。
 */
public record RoiFeatureVector(String[] names, double[] values) {

    public int dimensions() {
        return values.length;
    }

    public boolean isFinite() {
        for (double v : values) {
            if (!Double.isFinite(v)) {
                return false;
            }
        }
        return true;
    }

    public RoiFeatureVector withValues(double[] newValues) {
        return new RoiFeatureVector(names, newValues);
    }

    @Override
    public String toString() {
        StringBuilder sb = new StringBuilder("{");
        for (int i = 0; i < values.length; i++) {
            if (i > 0) sb.append(", ");
            sb.append(names[i]).append('=').append(values[i]);
        }
        return sb.append('}').toString();
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof RoiFeatureVector other
                && Arrays.equals(names, other.names)
                && Arrays.equals(values, other.values);
    }

    @Override
    public int hashCode() {
        return 31 * Arrays.hashCode(names) + Arrays.hashCode(values);
    }
}

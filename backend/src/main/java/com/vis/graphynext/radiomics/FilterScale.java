/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * 「強調する構造の半径 r（mm）」から LoG の σ（mm）への換算。
 *
 * <p>LoG の核の中心の山の半径（符号が変わる半径）は d 次元で √d·σ で、半径 R の円板（2D）・球（3D）への
 * σ² 正規化した応答は σ=R/√d で最大になる。そこで既定は σ=r/√d（d は LoG の次元。3D の単位は 3、2D の単位は 2）。
 * 文献に換算式は無いので、他のソフトの同名の設定と同じ値になるとは言えない。
 */
final class FilterScale {

    enum Conversion { SQRT_D, IDENTITY, COEFFICIENT }

    private FilterScale() {
    }

    static Conversion parse(String name) {
        if (name == null || name.isBlank()) {
            return Conversion.SQRT_D;
        }
        try {
            return Conversion.valueOf(name.trim());
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("scaleConversion は SQRT_D・IDENTITY・COEFFICIENT のいずれかです: " + name);
        }
    }

    /**
     * σ（mm）。r=0 は「フィルタなし」で null。列名・キャッシュの鍵に入る値なので、小数 4 桁に丸める
     * （同じ r は常に同じ文字列になる）。
     */
    static Double sigmaMm(double r, int d, Conversion conversion, Double k) {
        if (!Double.isFinite(r) || r < 0) {
            throw new IllegalArgumentException("構造の半径は 0 以上の数で指定してください（0 はフィルタなし）: " + r);
        }
        if (r == 0) {
            return null;
        }
        double sigma = switch (conversion) {
            case SQRT_D -> r / Math.sqrt(d);
            case IDENTITY -> r;
            case COEFFICIENT -> {
                if (k == null || !Double.isFinite(k) || k <= 0) {
                    throw new IllegalArgumentException("係数 k は正の数で指定してください（σ = k·r）。");
                }
                yield k * r;
            }
        };
        double rounded = new BigDecimal(sigma).setScale(4, RoundingMode.HALF_UP).doubleValue();
        if (rounded <= 0) {
            throw new IllegalArgumentException("半径 " + r + " mm は小さすぎて σ が 0 になります。");
        }
        return rounded;
    }

    /** RadiomicsJ の {@code DOUBLEARRAY_logSigmaMm} に渡す文字列（末尾の 0 を付けない）。 */
    static String settingValue(double sigmaMm) {
        return BigDecimal.valueOf(sigmaMm).stripTrailingZeros().toPlainString();
    }
}

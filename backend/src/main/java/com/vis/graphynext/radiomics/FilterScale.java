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

    /** スケールの値の書き方。 */
    enum Notation { RADIUS_MM, WIDTH_PX }

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

    static Notation parseNotation(String name) {
        if (name == null || name.isBlank()) {
            return Notation.RADIUS_MM;
        }
        try {
            return Notation.valueOf(name.trim());
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("scaleNotation は RADIUS_MM・WIDTH_PX のいずれかです: " + name);
        }
    }

    /**
     * 幅（画素）を半径 r（mm）に直す。幅は構造の直径として読む（r ＝ 幅 × 画素間隔 / 2）。
     * 0 はそのまま 0（フィルタなし）。画素は入力の書き方だけで、計算に使うのは mm に直したあとの値。
     */
    static double radiusMmFromWidthPx(double widthPx, double pixelSpacingMm) {
        if (!Double.isFinite(widthPx) || widthPx < 0) {
            throw new IllegalArgumentException("構造の幅（画素）は 0 以上の数で指定してください（0 はフィルタなし）: " + widthPx);
        }
        if (!Double.isFinite(pixelSpacingMm) || pixelSpacingMm <= 0) {
            throw new IllegalArgumentException("画素間隔が読めないので、画素幅からは換算できません。半径（mm）で指定してください。");
        }
        // 浮動小数の誤差（6 × 0.7 / 2 = 2.0999999999999996）を表示・記録に持ち込まないよう、小数 6 桁に丸める
        return new BigDecimal(widthPx * pixelSpacingMm / 2.0).setScale(6, RoundingMode.HALF_UP).doubleValue();
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

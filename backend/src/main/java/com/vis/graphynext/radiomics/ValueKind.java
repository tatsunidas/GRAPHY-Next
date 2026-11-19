/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;

import com.vis.graphynext.dicom.ParametricMapFrameExpander;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 画素値が「何であるか」の判定（IBSI の 3 区分）と、それによる IVH・補間後の丸めの切り替え。
 * モダリティではなく、DICOM のメタデータで決める（計算画像はどのモダリティにも出る）。
 * <ul>
 * <li>{@link #DISCRETE}: 離散の校正値（CT の HU）。IVH は mode 0。補間後の丸めを選べる。CT の画素値は HU と DICOM が定めるので、
 *     Rescale Type が空の CT（実データに多い）も、原画像で Rescale が整数なら離散とする。Rescale Type が HU 以外と書かれていれば離散にしない。</li>
 * <li>{@link #CONTINUOUS}: 連続の校正値（単位が明示されたもの。PET の SUV、計算画像の単位）。IVH は mode 1（ビン幅が要る）。丸めない。</li>
 * <li>{@link #ARBITRARY}: 任意単位・不明（MR・マンモ・SPECT・単位不明の計算画像）。IVH は mode 2。丸めない。</li>
 * </ul>
 * 離散と確認できたときだけ mode 0 と丸めを使う（確認できなければ値を壊さない側に倒す）。
 * 画像の中身（小数があるか）では決めない — 補間した CT も計算画像も小数になる。
 *
 * @param kind        {@link #DISCRETE}・{@link #CONTINUOUS}・{@link #ARBITRARY}。分類しない（従来）は {@link #LEGACY}
 * @param basis       判定の根拠（結果の表に残す）
 * @param flags       QC の旗（{@link #FLAG_OVERRIDDEN}・{@link #FLAG_BINWIDTH_UNSET}・{@link #FLAG_ROUNDING_IGNORED}）
 * @param ivhMode     RadiomicsJ の IVH のモード（0・1・2）。{@link #LEGACY} は null（RadiomicsJ の既定のまま）
 * @param ivhBinWidth mode 1 のビン幅。それ以外は null
 * @param rounding    補間後の整数への丸めを掛ける
 */
public record ValueKind(String kind, String basis, List<String> flags, Integer ivhMode, Double ivhBinWidth,
                        boolean rounding) {

    public static final String LEGACY = "legacy";
    public static final String DISCRETE = "discrete";
    public static final String CONTINUOUS = "continuous";
    public static final String ARBITRARY = "arbitrary";
    public static final String AUTO = "auto";

    public static final String FLAG_OVERRIDDEN = "VALUEKIND_OVERRIDDEN";
    public static final String FLAG_BINWIDTH_UNSET = "IVH_BINWIDTH_UNSET";
    public static final String FLAG_ROUNDING_IGNORED = "ROUNDING_IGNORED";
    /** 利用者が IVH・丸めの設定を直接渡した（値の種類が決める設定より優先した）。 */
    public static final String FLAG_SETTING_EXPLICIT = "IVH_SETTING_EXPLICIT";

    /** 指定できる値の種類（null・空は従来の {@link #LEGACY}）。 */
    public static final java.util.Set<String> REQUESTABLE = java.util.Set.of(AUTO, DISCRETE, CONTINUOUS, ARBITRARY);

    /** PET の SUV のビン幅の初期値（IBSI の例: 18F-FDG-PET で 0.10 SUV）。SUV 以外の単位には初期値を置かない。 */
    public static final double DEFAULT_SUV_BIN_WIDTH = 0.10;

    /** 分類しない（従来の要求）。 */
    public static final ValueKind NONE = new ValueKind(LEGACY, "", List.of(), null, null, false);

    /** 利用者の指定（要求の 3 項目）。 */
    public record Spec(String valueKind, Double ivhBinWidth, boolean intensityRounding) {
        public boolean legacy() {
            return valueKind == null || valueKind.isBlank();
        }

        public String kindOrAuto() {
            return legacy() ? AUTO : valueKind.trim().toLowerCase(Locale.ROOT);
        }
    }

    /**
     * ヘッダから取れる、判定の材料。
     *
     * @param modality       Modality
     * @param imageType0     ImageType の先頭（ORIGINAL・DERIVED）。無ければ空
     * @param rescaleType    Rescale Type。無ければ空
     * @param rescaleKnown   Rescale の傾き・切片を読めた（最上位か共有の機能グループ。フレームごとのときは false）
     * @param rescaleInteger 傾きと切片がともに整数（先頭と末尾の両方）
     * @param floatPixel     浮動小数の画素（Parametric Map）
     * @param rwvmUnit       Real World Value Mapping の単位。無ければ空
     */
    public record Facts(String modality, String imageType0, String rescaleType, boolean rescaleKnown,
                        boolean rescaleInteger, boolean floatPixel, String rwvmUnit) {}

    /** 最初と最後のインスタンスのヘッダから、判定の材料を取り出す（{@code last} は null でよい）。 */
    static Facts factsOf(Attributes first, Attributes last) {
        String modality = String.valueOf(first.getString(Tag.Modality, "")).trim().toUpperCase(Locale.ROOT);
        String[] it = first.getStrings(Tag.ImageType);
        String imageType0 = it == null || it.length == 0 || it[0] == null ? "" : it[0].trim().toUpperCase(Locale.ROOT);
        double[] r1 = rescaleOf(first);
        double[] r2 = last == null ? r1 : rescaleOf(last);
        boolean known = r1 != null && r2 != null;
        boolean integer = known && isInteger(r1[0]) && isInteger(r1[1]) && isInteger(r2[0]) && isInteger(r2[1]);
        String type = rescaleTypeOf(first);
        boolean pm = ParametricMapFrameExpander.isParametricMap(first);
        String rwvm = pm ? ParametricMapFrameExpander.unitOfFrame(first, 0) : "";
        return new Facts(modality, imageType0, type, known, integer, pm, rwvm == null ? "" : rwvm);
    }

    private static boolean isInteger(double v) {
        return !Double.isNaN(v) && !Double.isInfinite(v) && v == Math.rint(v);
    }

    /** {slope, intercept}。最上位か、共有の機能グループの PixelValueTransformation。読めなければ null。 */
    private static double[] rescaleOf(Attributes ds) {
        if (ds.containsValue(Tag.RescaleSlope) && ds.containsValue(Tag.RescaleIntercept)) {
            return new double[] { ds.getDouble(Tag.RescaleSlope, Double.NaN), ds.getDouble(Tag.RescaleIntercept, Double.NaN) };
        }
        Attributes pvt = pixelValueTransformation(ds);
        if (pvt != null && pvt.containsValue(Tag.RescaleSlope) && pvt.containsValue(Tag.RescaleIntercept)) {
            return new double[] { pvt.getDouble(Tag.RescaleSlope, Double.NaN), pvt.getDouble(Tag.RescaleIntercept, Double.NaN) };
        }
        return null;
    }

    private static String rescaleTypeOf(Attributes ds) {
        String t = ds.getString(Tag.RescaleType);
        if (t == null) {
            Attributes pvt = pixelValueTransformation(ds);
            t = pvt == null ? null : pvt.getString(Tag.RescaleType);
        }
        return t == null ? "" : t.trim();
    }

    private static Attributes pixelValueTransformation(Attributes ds) {
        Sequence shared = ds.getSequence(Tag.SharedFunctionalGroupsSequence);
        if (shared == null || shared.isEmpty()) {
            return null;
        }
        return shared.get(0).getNestedDataset(Tag.PixelValueTransformationSequence);
    }

    /** 単位として扱える Rescale Type か（US・a.u. などの「単位なし」と、空は単位ではない）。 */
    private static boolean isUnit(String rescaleType) {
        if (rescaleType == null || rescaleType.isBlank()) {
            return false;
        }
        String t = rescaleType.trim().toLowerCase(Locale.ROOT);
        return !(t.equals("us") || t.equals("a.u.") || t.equals("au") || t.equals("arbitrary"));
    }

    /**
     * 値の種類と、IVH・丸めの設定を決める。ヘッダだけから決める純粋な関数。
     *
     * @param facts ヘッダの材料。読み込みで取れなかったとき（従来の経路）は null — 離散と確認できないので任意単位になる
     * @param vc    読み込みで決めた校正（PET の単位の根拠）
     * @param spec  利用者の指定。{@link Spec#legacy()} なら分類しない（{@link #NONE}）
     * @throws IllegalArgumentException 指定が不正、または連続を明示したのにビン幅が決まらない
     */
    static ValueKind decide(Facts facts, ValueCalibration vc, Spec spec) {
        if (spec == null || spec.legacy()) {
            if (spec != null && spec.intensityRounding()) {
                throw new IllegalArgumentException("補間後の丸めは、値の種類（valueKind）を指定したときだけ使えます。");
            }
            return NONE;
        }
        String requested = spec.kindOrAuto();
        if (!REQUESTABLE.contains(requested)) {
            throw new IllegalArgumentException("値の種類は auto・discrete・continuous・arbitrary のどれかです（指定: "
                    + spec.valueKind() + "）");
        }
        if (spec.ivhBinWidth() != null && !(spec.ivhBinWidth() > 0) ) {
            throw new IllegalArgumentException("IVH のビン幅は正の数です（指定: " + spec.ivhBinWidth() + "）");
        }

        // 1. ヘッダだけからの判定
        List<String> basis = new ArrayList<>();
        String unit = unitOf(facts, vc);
        String auto;
        boolean huLabel = facts != null && ("HU".equalsIgnoreCase(facts.rescaleType())
                || (facts.rescaleType().isEmpty() && "CT".equals(facts.modality())));
        if (huLabel && "ORIGINAL".equals(facts.imageType0())
                && facts.rescaleKnown() && facts.rescaleInteger() && !facts.floatPixel()) {
            auto = DISCRETE;
            basis.add(facts.rescaleType().isEmpty() ? "RescaleType=absent(CT)" : "RescaleType=HU");
            basis.add("ImageType=ORIGINAL");
            basis.add("rescale=integer");
        } else if (unit != null) {
            auto = CONTINUOUS;
            basis.add("unit=" + unit);
        } else {
            auto = ARBITRARY;
            basis.add(facts == null ? "header=unavailable" : "unit=none");
            if (facts != null && "CT".equals(facts.modality())) {
                basis.add(!"ORIGINAL".equals(facts.imageType0()) ? "ImageType=" + facts.imageType0()
                        : !facts.rescaleKnown() ? "rescale=unreadable" : !facts.rescaleInteger() ? "rescale=non-integer"
                        : "RescaleType=" + (facts.rescaleType().isEmpty() ? "none" : facts.rescaleType()));
            }
        }

        // 2. 利用者の上書き
        List<String> flags = new ArrayList<>();
        String kind = auto;
        if (!requested.equals(AUTO)) {
            kind = requested;
            if (!requested.equals(auto)) {
                flags.add(FLAG_OVERRIDDEN);
                basis.add("override=" + requested + "(auto=" + auto + ")");
            } else {
                basis.add("override=" + requested);
            }
        }

        // 3. 種類ごとの IVH と丸め
        Integer mode;
        Double binWidth = null;
        boolean rounding = false;
        switch (kind) {
            case DISCRETE -> {
                mode = 0;
                rounding = spec.intensityRounding();
            }
            case CONTINUOUS -> {
                binWidth = spec.ivhBinWidth() != null ? spec.ivhBinWidth()
                        : unit != null && unit.toUpperCase(Locale.ROOT).startsWith("SUV") ? DEFAULT_SUV_BIN_WIDTH : null;
                if (binWidth == null) {
                    if (requested.equals(CONTINUOUS)) {
                        throw new IllegalArgumentException("連続の校正値を指定しましたが、IVH のビン幅が決まりません"
                                + "（単位 " + (unit == null ? "不明" : unit) + "）。ビン幅を指定してください。");
                    }
                    // 単位はあるがビン幅が無い: 値を作らず任意単位（固定ビン数）に落とし、旗を付ける
                    kind = ARBITRARY;
                    mode = 2;
                    flags.add(FLAG_BINWIDTH_UNSET);
                    basis.add("ivhBinWidth=unset");
                } else {
                    mode = 1;
                }
            }
            default -> mode = 2;
        }
        if (spec.intensityRounding() && !kind.equals(DISCRETE)) {
            flags.add(FLAG_ROUNDING_IGNORED);
        }
        return new ValueKind(kind, String.join(";", basis), List.copyOf(flags), mode, binWidth, rounding);
    }

    /** 単位が明示されているときだけ、その表示名。無ければ null。 */
    private static String unitOf(Facts facts, ValueCalibration vc) {
        if (vc != null && vc.valueUnit() != null && !vc.valueUnit().isBlank() && !vc.valueUnit().equals("HU")) {
            return vc.valueUnit();
        }
        if (facts == null) {
            return null;
        }
        if (!facts.rwvmUnit().isBlank()) {
            return facts.rwvmUnit();
        }
        if (isUnit(facts.rescaleType())) {
            return facts.rescaleType();
        }
        return null;
    }
}

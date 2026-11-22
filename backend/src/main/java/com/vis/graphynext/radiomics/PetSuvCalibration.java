/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;

import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * PET の SUV（Standardized Uptake Value）の係数。{@code SUV = 値（Bq/mL） × scale}。
 *
 * <p>フロントの {@code frontend/src/viewer/suv.ts}（{@code extractSuvParams}・{@code computeSuvScale}）の Java 版。
 * radiomics は画面に開いていないシリーズも、コマンドラインや無人実行でも読むので、係数を backend で求める。
 * 式・フォールバックの順序は TS 版と同じにしてあり、2 つの実装は共通のテスト値
 * （{@code backend/src/test/resources/radiomics/suv-golden.json}）で突き合わせる。
 *
 * <p>欠けているタグは、既定値や 0 で埋めずに理由つきのエラーにする（体重・身長・性別・投与量・時刻）。
 */
public final class PetSuvCalibration {

    private PetSuvCalibration() {
    }

    /** SUV の種類。{@code id} は TS 版の {@code SuvType} と同じ文字列（{@code pid} は対象外）。 */
    public enum Type {
        BW("bw", "SUVbw"),
        SUL_JAMES("sul-james", "SUVlbm"),
        SUL_JANMA("sul-janma", "SUVlbm"),
        BSA("bsa", "SUVbsa");

        private final String id;
        private final String unit;

        Type(String id, String unit) {
            this.id = id;
            this.unit = unit;
        }

        public String id() {
            return id;
        }

        public String unit() {
            return unit;
        }

        /** 文字列から種類。該当しなければ null。 */
        public static Type of(String id) {
            for (Type t : values()) {
                if (t.id.equals(id)) {
                    return t;
                }
            }
            return null;
        }
    }

    /** 係数の計算に使うパラメータ（DICOM から読んだ値）。欠損は null。 */
    public record Params(
            Double patientWeightKg,
            Double patientHeightM,
            /** "M" か "F"。欠損・不明（"O" など）は null（SUL では計算不可。推測で埋めない）。 */
            String patientSex,
            Double totalDoseBq,
            Double halfLifeSec,
            String radionuclideName,
            Long injectionTimeMs,
            Long scanTimeMs,
            /** Units (0054,1001) を大文字にしたもの。 */
            String units,
            List<String> correctedImage,
            /** DecayCorrection (0054,1102)。 */
            String decayCorrection,
            Double philipsSuvScaleFactor,
            Double philipsActivityConcScaleFactor,
            /** すでに SUV 化されている（Units=GML・SUVType・RescaleType に "SUV"）。 */
            boolean alreadySuv,
            String modality) {
    }

    /** 係数の計算結果。成功なら {@code error} は null。 */
    public record Outcome(Double scale, String unit, Type type, List<String> warnings, String error) {
        public boolean ok() {
            return error == null;
        }

        static Outcome failure(String error) {
            return new Outcome(null, null, null, List.of(), error);
        }
    }

    /** 核種別の物理半減期（秒）。RadionuclideHalfLife (0018,1075) 欠損時のフォールバック（コードは SRT/DCM の CodeValue）。 */
    private static final Map<String, Double> HALF_LIFE_BY_CODE = Map.of(
            "C-111A", 6586.2, // F-18
            "C-105A", 1220.0, // C-11
            "C-107A", 597.9, // N-13
            "C-1018C", 122.24, // O-15
            "C-131A", 4062.6, // Ga-68
            "C-1082", 75.45, // Rb-82
            "C-127A", 45720.0, // Cu-64
            "C-B1031", 282276.0, // Zr-89
            "C-113A", 360806.0); // I-124

    private static Double halfLifeFromName(String name) {
        if (name == null || name.isEmpty()) {
            return null;
        }
        String s = name.toUpperCase(Locale.ROOT).replaceAll("[\\s^-]", "");
        if (Pattern.compile("(^|[^0-9])18F|F18|FLUOR|FDG").matcher(s).find()) return 6586.2;
        if (Pattern.compile("(^|[^0-9])11C|C11|CARBON").matcher(s).find()) return 1220.0;
        if (Pattern.compile("(^|[^0-9])13N|N13|NITROGEN").matcher(s).find()) return 597.9;
        if (Pattern.compile("(^|[^0-9])15O|O15|OXYGEN").matcher(s).find()) return 122.24;
        if (Pattern.compile("(^|[^0-9])68GA|GA68|GALLIUM").matcher(s).find()) return 4062.6;
        if (Pattern.compile("(^|[^0-9])82RB|RB82|RUBIDIUM").matcher(s).find()) return 75.45;
        if (Pattern.compile("(^|[^0-9])64CU|CU64|COPPER").matcher(s).find()) return 45720.0;
        if (Pattern.compile("(^|[^0-9])89ZR|ZR89|ZIRCONIUM").matcher(s).find()) return 282276.0;
        if (Pattern.compile("(^|[^0-9])124I|I124|IODINE").matcher(s).find()) return 360806.0;
        return null;
    }

    // ------------------------------------------------------------------ 抽出

    /** シリーズのインスタンス 1 件の DICOM から、SUV の係数に使うパラメータを読む（{@code suv.ts} の {@code extractSuvParams}）。 */
    public static Params extract(Attributes ds) {
        Attributes radDs = ds.getNestedDataset(Tag.RadiopharmaceuticalInformationSequence);

        Double weight = nonZero(dsFloat(ds, Tag.PatientWeight));
        Double height = nonZero(dsFloat(ds, Tag.PatientSize)); // m
        String sexRaw = str(ds, Tag.PatientSex);
        String sex = null;
        if (sexRaw != null) {
            String u = sexRaw.trim().toUpperCase(Locale.ROOT);
            sex = u.startsWith("F") ? "F" : u.startsWith("M") ? "M" : null;
        }

        Double dose = firstNonNull(dsFloat(radDs, Tag.RadionuclideTotalDose), dsFloat(ds, Tag.RadionuclideTotalDose));
        Double halfLife = firstNonNull(dsFloat(radDs, Tag.RadionuclideHalfLife), dsFloat(ds, Tag.RadionuclideHalfLife));

        Attributes codeDs = firstNonNull(
                radDs == null ? null : radDs.getNestedDataset(Tag.RadionuclideCodeSequence),
                ds.getNestedDataset(Tag.RadionuclideCodeSequence));
        String codeValue = str(codeDs, Tag.CodeValue);
        String codeMeaning = str(codeDs, Tag.CodeMeaning);
        String name = firstNonNull(codeMeaning, firstNonNull(str(radDs, Tag.Radiopharmaceutical), str(ds, Tag.Radiopharmaceutical)));
        if (name == null) {
            name = "Unknown";
        }
        if (halfLife == null) {
            halfLife = firstNonNull(codeValue == null ? null : HALF_LIFE_BY_CODE.get(codeValue),
                    firstNonNull(halfLifeFromName(codeMeaning), halfLifeFromName(name)));
        }
        if (dose != null && dose < 0) {
            dose = null;
        }

        String seriesDate = str(ds, Tag.SeriesDate);
        String seriesTime = str(ds, Tag.SeriesTime);
        String acqDate = str(ds, Tag.AcquisitionDate);
        String acqTime = str(ds, Tag.AcquisitionTime);
        String startDT = firstNonNull(str(radDs, Tag.RadiopharmaceuticalStartDateTime), str(ds, Tag.RadiopharmaceuticalStartDateTime));
        String startTM = firstNonNull(str(radDs, Tag.RadiopharmaceuticalStartTime), str(ds, Tag.RadiopharmaceuticalStartTime));
        Long injection = parseDT(startDT);
        if (injection == null && startTM != null) {
            injection = combineDateTime(seriesDate, startTM);
        }

        Long seriesMs = combineDateTime(seriesDate, seriesTime);
        Long acqMs = combineDateTime(acqDate, acqTime);
        Long gePostInj = parseDT(str(ds, 0x0009100D)); // GE の私設タグ: 投与後の日時
        Long scan;
        if (seriesMs != null && (acqMs == null || seriesMs <= acqMs)) {
            scan = seriesMs; // Series Time が信頼できる（未崩壊補正の基準）
        } else if (gePostInj != null) {
            scan = gePostInj;
        } else {
            scan = acqMs != null ? acqMs : seriesMs;
        }

        String unitsRaw = str(ds, Tag.Units);
        String units = unitsRaw == null ? null : unitsRaw.toUpperCase(Locale.ROOT);
        if (units != null && units.isEmpty()) {
            units = null;
        }
        List<String> corrected = new ArrayList<>();
        String[] ci = ds.getStrings(Tag.CorrectedImage);
        if (ci != null) {
            for (String c : ci) {
                if (c != null && !c.trim().isEmpty()) {
                    corrected.add(c.trim().toUpperCase(Locale.ROOT));
                }
            }
        }
        String decayCorrection = str(ds, Tag.DecayCorrection);
        Double philipsSuv = dsFloat(ds, 0x70531000);
        Double philipsConc = dsFloat(ds, 0x70531009);

        String suvType = str(ds, Tag.SUVType);
        String rescaleType = str(ds, Tag.RescaleType);
        boolean alreadySuv = "GML".equals(units)
                || (suvType != null && !suvType.trim().isEmpty())
                || (rescaleType != null && rescaleType.toUpperCase(Locale.ROOT).contains("SUV"));

        return new Params(weight, height, sex, dose, halfLife, name, injection, scan, units, corrected,
                decayCorrection, philipsSuv, philipsConc, alreadySuv, str(ds, Tag.Modality));
    }

    // ------------------------------------------------------------------ 計算

    /** 除脂肪体重（kg）James 1976。H は m。 */
    static double lbmJames(double weightKg, double heightM, String sex) {
        double hCm = heightM * 100;
        double wsq = Math.pow(weightKg / hCm, 2);
        return "M".equals(sex) ? 1.1 * weightKg - 128 * wsq : 1.07 * weightKg - 148 * wsq;
    }

    /** 除脂肪体重（kg）Janmahasatian 2005。 */
    static double lbmJanma(double weightKg, double heightM, String sex) {
        double bmi = weightKg / (heightM * heightM);
        return "M".equals(sex)
                ? (9270 * weightKg) / (6680 + 216 * bmi)
                : (9270 * weightKg) / (8780 + 244 * bmi);
    }

    /** 体表面積（m^2）DuBois。 */
    static double bsaDuBois(double weightKg, double heightM) {
        return 0.007184 * Math.pow(weightKg, 0.425) * Math.pow(heightM * 100, 0.725);
    }

    /**
     * SUV の係数を計算する（{@code suv.ts} の {@code computeSuvScale}）。Units により分岐（OHIF 準拠）:
     * GML はすでに SUV（係数 1）、CNTS（Philips）は私設タグ、BQML・未指定は崩壊補正 × 正規化ベース。
     */
    public static Outcome compute(Params p, Type type) {
        List<String> warnings = new ArrayList<>();
        String units = p.units() == null ? "" : p.units().toUpperCase(Locale.ROOT);

        if ("GML".equals(units) || p.alreadySuv()) {
            warnings.add("alreadySuv");
            return new Outcome(1.0, type.unit(), type, warnings, null);
        }

        if ("CNTS".equals(units)) {
            if (p.philipsSuvScaleFactor() != null && p.philipsSuvScaleFactor() > 0) {
                if (type != Type.BW) {
                    warnings.add("philipsBwOnly");
                }
                return new Outcome(p.philipsSuvScaleFactor(), Type.BW.unit(), Type.BW, warnings, null);
            }
            if (!(p.philipsActivityConcScaleFactor() != null && p.philipsActivityConcScaleFactor() > 0)) {
                return Outcome.failure("philipsInvalid");
            }
            warnings.add("philipsActivityConc");
        }

        if (p.totalDoseBq() == null || p.totalDoseBq() <= 0) return Outcome.failure("missingDose");
        if (p.halfLifeSec() == null || p.halfLifeSec() <= 0) return Outcome.failure("missingHalfLife");
        String decayCorrection = p.decayCorrection() == null ? "" : p.decayCorrection().trim().toUpperCase(Locale.ROOT);
        double decayedDoseBq;
        if ("ADMIN".equals(decayCorrection)) {
            warnings.add("decayAdmin");
            decayedDoseBq = p.totalDoseBq();
        } else {
            if ("NONE".equals(decayCorrection)) {
                warnings.add("decayNone");
            }
            if (p.injectionTimeMs() == null || p.scanTimeMs() == null) {
                return Outcome.failure("missingTime");
            }
            double decaySec = (p.scanTimeMs() - p.injectionTimeMs()) / 1000.0;
            if (decaySec < 0) {
                decaySec += 86400;
                warnings.add("midnightAdjust");
            }
            if (decaySec < 0) return Outcome.failure("negativeDecay");
            decayedDoseBq = p.totalDoseBq() * Math.pow(2, -decaySec / p.halfLifeSec());
        }
        if (!(decayedDoseBq > 0)) return Outcome.failure("negativeDecay");

        Double w = p.patientWeightKg();
        Double h = p.patientHeightM();
        if (w == null || w <= 0) return Outcome.failure("missingWeight");
        double normBase;
        switch (type) {
            case BW -> normBase = w * 1000; // g
            case SUL_JAMES -> {
                if (h == null || h <= 0) return Outcome.failure("missingHeight");
                if (p.patientSex() == null) return Outcome.failure("missingSex");
                normBase = lbmJames(w, h, p.patientSex()) * 1000;
            }
            case SUL_JANMA -> {
                if (h == null || h <= 0) return Outcome.failure("missingHeight");
                if (p.patientSex() == null) return Outcome.failure("missingSex");
                normBase = lbmJanma(w, h, p.patientSex()) * 1000;
            }
            case BSA -> {
                if (h == null || h <= 0) return Outcome.failure("missingHeight");
                normBase = bsaDuBois(w, h) * 10000; // m^2 → cm^2
            }
            default -> throw new IllegalStateException("未対応の種類: " + type);
        }
        if (!(normBase > 0)) return Outcome.failure("invalidNormBase");

        // SUV = 濃度 / (崩壊補正後の投与量 / 正規化ベース) = 濃度 × (正規化ベース / 崩壊補正後の投与量)
        double scale = normBase / decayedDoseBq;
        // Philips (7053,1009): 画素値を Bq/mL の濃度に換算してから標準式
        if ("CNTS".equals(units) && p.philipsActivityConcScaleFactor() != null && p.philipsActivityConcScaleFactor() != 0) {
            scale *= p.philipsActivityConcScaleFactor();
        }
        return new Outcome(scale, type.unit(), type, warnings, null);
    }

    /** エラー名（{@link Outcome#error()}）を、利用者に見せる文にする。 */
    public static String describe(String error) {
        return switch (error) {
            case "missingDose" -> "投与量（RadionuclideTotalDose）が DICOM にありません";
            case "missingHalfLife" -> "半減期（RadionuclideHalfLife）が DICOM になく、核種からも決められません";
            case "missingTime" -> "投与時刻または撮像時刻が DICOM にありません";
            case "negativeDecay" -> "投与から撮像までの時間が負になります（日付・時刻を確認してください）";
            case "missingWeight" -> "体重（PatientWeight）が DICOM にありません";
            case "missingHeight" -> "身長（PatientSize）が DICOM にありません（SUL・SUVbsa には必要です。SUVbw なら不要です）";
            case "missingSex" -> "性別（PatientSex）が M・F ではありません（SUL には必要です。SUVbw なら不要です）";
            case "invalidNormBase" -> "体重・身長から求めた正規化の基準が正になりません";
            case "philipsInvalid" -> "Philips の単位（CNTS）の換算係数（7053,1000・7053,1009）がありません";
            default -> error;
        };
    }

    // ------------------------------------------------------------------ タグの読み取りと日時

    private static String str(Attributes ds, int tag) {
        if (ds == null) {
            return null;
        }
        String v = ds.getString(tag);
        return v == null || v.isEmpty() ? null : v;
    }

    /** DS・IS の文字列、または FL・FD の生値を数に。読めなければ null。 */
    private static Double dsFloat(Attributes ds, int tag) {
        if (ds == null || !ds.containsValue(tag)) {
            return null;
        }
        try {
            double v = ds.getDouble(tag, Double.NaN);
            if (Double.isFinite(v)) {
                return v;
            }
        } catch (RuntimeException ignored) {
            // DS・IS・FL・FD 以外（UN など）は文字列として読む
        }
        String s = str(ds, tag);
        if (s != null) {
            try {
                double n = Double.parseDouble(s.split("\\\\")[0].trim());
                if (Double.isFinite(n)) {
                    return n;
                }
            } catch (NumberFormatException ignored) {
                // 読めない
            }
        }
        return null;
    }

    private static Double nonZero(Double v) {
        return v == null || v == 0 || !Double.isFinite(v) ? null : v;
    }

    private static <T> T firstNonNull(T a, T b) {
        return a != null ? a : b;
    }

    private static final Pattern DA = Pattern.compile("^\\d{8}.*");
    private static final Pattern TM_HH = Pattern.compile("^\\d{2}.*");
    private static final Pattern FRAC = Pattern.compile("\\.(\\d+)");

    /** DICOM DA（YYYYMMDD）と TM（HHMMSS.FFFFFF）を、UTC 基準の相対値のエポックミリ秒に。 */
    static Long combineDateTime(String da, String tm) {
        if (da == null || !DA.matcher(da).matches() || tm == null || !TM_HH.matcher(tm).matches()) {
            return null;
        }
        try {
            int y = Integer.parseInt(da.substring(0, 4));
            int mo = Integer.parseInt(da.substring(4, 6));
            int d = Integer.parseInt(da.substring(6, 8));
            int hh = Integer.parseInt(tm.substring(0, 2));
            int mm = tm.length() >= 4 ? Integer.parseInt(tm.substring(2, 4)) : 0;
            int ss = tm.length() >= 6 ? Integer.parseInt(tm.substring(4, 6)) : 0;
            Matcher m = FRAC.matcher(tm);
            long ms = m.find() ? Math.round(Double.parseDouble("0." + m.group(1)) * 1000) : 0;
            LocalDateTime t = LocalDateTime.of(y, mo, d, hh, mm, ss);
            return t.toEpochSecond(ZoneOffset.UTC) * 1000 + ms;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** DICOM DT（YYYYMMDDHHMMSS.FFFFFF&ZZXX）をエポックミリ秒に。タイムゾーンは無視（差だけを使う）。 */
    static Long parseDT(String dt) {
        if (dt == null || !DA.matcher(dt).matches()) {
            return null;
        }
        String core = dt.replaceAll("[+-]\\d{4}$", "");
        String da = core.substring(0, 8);
        String tm = core.length() > 8 ? core.substring(8) : "000000";
        return combineDateTime(da, tm);
    }
}

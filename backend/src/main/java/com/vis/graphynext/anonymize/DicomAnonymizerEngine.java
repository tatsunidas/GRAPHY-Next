/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.anonymize.DicomTagRule.Action;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.dcm4che3.util.UIDUtils;

import java.util.Map;
import java.util.Set;

/**
 * PS3.15 Basic Application Confidentiality Profile の匿名化エンジン（GRAPHY DicomAnonymizerEngine を
 * dcm4che {@link Attributes} 上に移植）。
 *
 * <p>{@link #deidentify} は 1 データセットを破壊的に匿名化する。UID は {@code uidMap} で全ファイル一貫置換、
 * 患者は {@code pmap} の新 ID/Name を設定する。private/SR は別途クリーニングし、PS3.15 の method タグを付与する。
 */
public class DicomAnonymizerEngine {

    /** 形式/構造を示す必須 UID は絶対に置換しない。 */
    private static final Set<Integer> PROTECTED_UIDS = Set.of(
            Tag.TransferSyntaxUID, Tag.MediaStorageSOPClassUID, Tag.ImplementationClassUID,
            Tag.SOPClassUID, Tag.RelatedGeneralSOPClassUID, Tag.OriginalSpecializedSOPClassUID);

    /**
     * 患者単位の新 ID/Name と、日付シフト量。
     *
     * <p>{@code dateShiftDays} は Modified Dates Option（113107）用。<b>患者ごとに 1 回だけ決める</b>ので、
     * スタディ・シリーズ・インスタンスを跨いで自動的に一貫し、患者内の時間的前後関係が保たれる。
     * 導出は {@link DateShifter#shiftDaysFor}（種と元 PatientID の純関数＝処理順に依存しない）。
     *
     * <p>⚠ {@link AnonymizeConfig} に持たせることはできない（患者ごとに値を変えられない）。
     * エンジンのフィールドや {@code ThreadLocal} も不可 —— エンジンは {@code AnonymizeService} の
     * <b>共有インスタンス</b>なので、状態を持たせると患者間で漏れる。
     */
    public record PatientMapping(String newPatId, String newPatName, int dateShiftDays) {

        /** 日付シフト無し（Modified Dates を使わない経路用）。 */
        public PatientMapping(String newPatId, String newPatName) {
            this(newPatId, newPatName, 0);
        }
    }

    /**
     * このインスタンスに対して<b>実際に</b>行った処理の申告材料。
     *
     * <p>🔴 <b>オプションが立っていることと、実際にやったことは別</b>。
     * {@code DeidentificationMethodCodeSequence} は「その SOP Instance に実際に適用した手法」の
     * 列挙なので、やっていない処理を宣言してはいけない。宣言だけして中身が伴わないと、
     * 受け取った側はタグを信用して検証しないため、<b>匿名化しないより危険</b>になる。
     *
     * <p>申告はエンジンが一箇所で組み立て、<b>事実は呼び出し元が渡す</b>のが不変条件。
     * 「宣言してから消す」形にすると、消し忘れたときに安全側に倒れない。
     *
     * @param pixelCleaned 焼き込みマスクを実際に画素へ適用したか（圧縮 TS・マスク 0 件・
     *                     画像外の矩形などで塗れなかった場合は false）
     */
    public record InstanceDeidFacts(boolean pixelCleaned) {

        /** 何も実施していない（申告するものが無い）。 */
        public static InstanceDeidFacts none() {
            return new InstanceDeidFacts(false);
        }
    }

    static {
        AnonymizeTagDictionary.ensureLoaded();
    }

    /**
     * 1 データセットを匿名化（破壊的）。実施した処理が無い前提で申告する。
     *
     * @deprecated 画素処理を伴う経路では {@link #deidentify(Attributes, AnonymizeConfig, PatientMapping, Map, InstanceDeidFacts)}
     *             を使い、実際に塗ったかを渡すこと。この 4 引数版は画素に触らない呼び出し専用。
     */
    @Deprecated
    public void deidentify(Attributes ds, AnonymizeConfig cfg, PatientMapping pmap, Map<String, String> uidMap) {
        deidentify(ds, cfg, pmap, uidMap, InstanceDeidFacts.none());
    }

    /** 1 データセットを匿名化（破壊的）。{@code facts} に実際に行った処理を渡す。 */
    public void deidentify(Attributes ds, AnonymizeConfig cfg, PatientMapping pmap, Map<String, String> uidMap,
            InstanceDeidFacts facts) {
        deidentifyRecursive(ds, cfg, uidMap, pmap.dateShiftDays());

        ds.setString(Tag.PatientName, VR.PN, pmap.newPatName());
        ds.setString(Tag.PatientID, VR.LO, pmap.newPatId());

        // PS3.15 E.1.1 の method タグ
        ds.setString(Tag.PatientIdentityRemoved, VR.CS, "YES");
        ds.setString(Tag.DeidentificationMethod, VR.LO, "Basic Application Level Confidentiality Profile");
        Sequence method = ds.newSequence(Tag.DeidentificationMethodCodeSequence, 0);
        addCode(method, "113100", "Basic Application Confidentiality Profile");
        // 🔴 オプションが立っているだけでは申告しない。実際に塗ったインスタンスに限る。
        // 圧縮 TS・マスク 0 件・画像外の矩形では 1 画素も変わらないので、その場合は
        // BurnedInAnnotation も原本のまま残す（真の YES を偽の NO に書き換えない）。
        if (cfg.hasOption(AnonymizeConfig.Option.CleanPixelData) && facts.pixelCleaned()) {
            addCode(method, "113101", "Clean Pixel Data Option");
            ds.setString(Tag.BurnedInAnnotation, VR.CS, "NO");
        }
        if (cfg.hasOption(AnonymizeConfig.Option.CleanRecognizableVisualFeatures)) {
            addCode(method, "113102", "Clean Recognizable Visual Features Option");
        }
        if (cfg.hasOption(AnonymizeConfig.Option.CleanGraphics)) {
            addCode(method, "113103", "Clean Graphics Option");
        }
        if (cfg.hasOption(AnonymizeConfig.Option.CleanStructuredContent)) {
            addCode(method, "113104", "Clean Structured Content Option");
        }
        if (cfg.hasOption(AnonymizeConfig.Option.CleanDescriptors)) {
            addCode(method, "113105", "Clean Descriptors Option");
        }
        if (cfg.hasOption(AnonymizeConfig.Option.RetainLongitudinalTemporalInformationFullDates)) {
            addCode(method, "113106", "Retain Longitudinal Temporal Information Full Dates Option");
        }
        if (cfg.hasOption(AnonymizeConfig.Option.RetainLongitudinalTemporalInformationModifiedDates)) {
            addCode(method, "113107", "Retain Longitudinal Temporal Information Modified Dates Option");
        }
        if (cfg.hasOption(AnonymizeConfig.Option.RetainPatientCharacteristics)) {
            addCode(method, "113108", "Retain Patient Characteristics Option");
        }
        if (cfg.hasOption(AnonymizeConfig.Option.RetainDeviceIdentity)) {
            addCode(method, "113109", "Retain Device Identity Option");
        }
        if (cfg.hasOption(AnonymizeConfig.Option.RetainUIDs)) {
            addCode(method, "113110", "Retain UIDs Option");
        }
        if (cfg.hasOption(AnonymizeConfig.Option.RetainSafePrivate)) {
            addCode(method, "113111", "Retain Safe Private Option");
        }
        if (cfg.hasOption(AnonymizeConfig.Option.RetainInstitutionIdentity)) {
            addCode(method, "113112", "Retain Institution Identity Option");
        }
    }

    private void deidentifyRecursive(Attributes ds, AnonymizeConfig cfg, Map<String, String> uidMap,
            int dateShiftDays) {
        cleanPrivateTags(ds, cfg);

        for (int tag : ds.tags()) {
            VR vr = ds.getVR(tag);
            if (vr == null) {
                continue;
            }
            DicomTagRule rule = AnonymizeTagDictionary.RULE_MAP.get(tag);
            Action action = rule != null ? cfg.determineFinalAction(rule) : null;

            if (vr == VR.SQ) {
                if (action == Action.C && (tag == Tag.ContentSequence
                        || tag == Tag.AcquisitionContextSequence || tag == Tag.SpecimenPreparationSequence)) {
                    cleanStructuredContentSequence(ds, tag, cfg, uidMap, dateShiftDays);
                    continue;
                }
                if (action == Action.X) {
                    ds.remove(tag);
                    continue;
                }
                if (action == Action.Z) {
                    ds.setNull(tag, vr);
                    continue;
                }
                Sequence sq = ds.getSequence(tag);
                if (sq != null) {
                    for (Attributes item : sq) {
                        deidentifyRecursive(item, cfg, uidMap, dateShiftDays);
                    }
                }
                continue;
            }

            if (vr == VR.UI) {
                if (PROTECTED_UIDS.contains(tag)) {
                    continue;
                }
                if (action != null) {
                    if (action == Action.K) {
                        continue;
                    } else if (action == Action.U) {
                        replaceUid(ds, tag, vr, uidMap);
                    } else {
                        applyTagAction(ds, tag, vr, action, cfg, dateShiftDays);
                    }
                } else if (!cfg.hasOption(AnonymizeConfig.Option.RetainUIDs)) {
                    replaceUid(ds, tag, vr, uidMap);
                }
                continue;
            }

            if (action != null && action != Action.K) {
                applyTagAction(ds, tag, vr, action, cfg, dateShiftDays);
            }
        }
    }

    private void applyTagAction(Attributes ds, int tag, VR vr, Action action, AnonymizeConfig cfg,
            int dateShiftDays) {
        String customVal = cfg.getCustomTagReplacements().get(tag);
        switch (action) {
            case X -> ds.remove(tag);
            case Z -> ds.setNull(tag, vr);
            case D, C -> {
                // 🔴 D と C は意味が違う。D は「ダミーで置換」なので固定値で正しいが、
                // C は「加工して関係を保つ」。日付の C を固定ダミーにすると全検査日が同じ日に潰れ、
                // Modified Dates Option（113107）が名前の逆を行う偽申告になる。
                String val;
                if (customVal != null) {
                    val = sanitizeForVr(customVal.trim(), vr);
                } else if (action == Action.C && dateShiftDays != 0 && isShiftableDateVr(vr)) {
                    // 解釈できない値は null になり、下で空にされる。
                    // 「ずらせなかったから元のまま素通し」は最悪の漏洩経路なので絶対にしない。
                    val = shiftDateValue(ds.getString(tag), vr, dateShiftDays);
                } else {
                    val = dummyForVr(vr);
                }
                if (val == null) {
                    ds.setNull(tag, vr);
                } else {
                    try {
                        ds.setString(tag, vr, val);
                    } catch (Exception e) {
                        ds.setNull(tag, vr); // VR が文字列を受け付けない（バイナリ等）場合は空に
                    }
                }
            }
            default -> {
                // K: keep
            }
        }
    }

    private static void replaceUid(Attributes ds, int tag, VR vr, Map<String, String> uidMap) {
        String orig = ds.getString(tag);
        if (orig == null || orig.trim().isEmpty()) {
            return;
        }
        String neu = uidMap.computeIfAbsent(orig, k -> UIDUtils.createUID());
        ds.setString(tag, vr, neu);
    }

    /** 奇数グループ（private）を安全表に基づきクリーニング。RetainSafePrivate 時のみ安全要素を保持。 */
    private static void cleanPrivateTags(Attributes ds, AnonymizeConfig cfg) {
        boolean retainSafe = cfg.hasOption(AnonymizeConfig.Option.RetainSafePrivate);
        for (int tag : ds.tags()) {
            int group = (tag >>> 16) & 0xFFFF;
            if ((group & 1) == 0) {
                continue; // 標準（偶数グループ）
            }
            int element = tag & 0xFFFF;
            if (element >= 0x0010 && element <= 0x00FF) {
                // private creator 要素
                if (!retainSafe) {
                    ds.remove(tag);
                }
                continue;
            }
            if (element > 0x00FF) {
                boolean safe = false;
                if (retainSafe) {
                    int block = element >>> 8;
                    int creatorTag = (group << 16) | block;
                    String creator = ds.getString(creatorTag);
                    if (creator != null) {
                        Set<Integer> sigs = AnonymizeTagDictionary.SAFE_PRIVATE_ATTRIBUTES.get(creator.trim());
                        if (sigs != null) {
                            int sig = (group << 16) | (element & 0xFF);
                            safe = sigs.contains(sig);
                        }
                    }
                }
                if (!safe) {
                    ds.remove(tag);
                }
            }
        }
    }

    /** Structured Content（SR）系シーケンスから個人情報アイテムを除去し、残りを再帰処理。 */
    private void cleanStructuredContentSequence(Attributes ds, int tag, AnonymizeConfig cfg,
            Map<String, String> uidMap, int dateShiftDays) {
        Sequence sq = ds.getSequence(tag);
        if (sq == null) {
            return;
        }
        java.util.Iterator<Attributes> it = sq.iterator();
        while (it.hasNext()) {
            Attributes item = it.next();
            if (isIdentifiableContentItem(item)) {
                it.remove();
            } else {
                deidentifyRecursive(item, cfg, uidMap, dateShiftDays);
            }
        }
    }

    private static boolean isIdentifiableContentItem(Attributes item) {
        Attributes concept = item.getNestedDataset(Tag.ConceptNameCodeSequence);
        if (concept == null) {
            return false;
        }
        String codeValue = concept.getString(Tag.CodeValue);
        String codingScheme = concept.getString(Tag.CodingSchemeDesignator);
        if (codeValue == null || codingScheme == null) {
            return false;
        }
        return AnonymizeTagDictionary.SR_CLEAN_CODES.contains(codingScheme.trim() + ":" + codeValue.trim());
    }

    private static void addCode(Sequence seq, String codeValue, String meaning) {
        Attributes item = new Attributes();
        item.setString(Tag.CodeValue, VR.SH, codeValue);
        item.setString(Tag.CodingSchemeDesignator, VR.SH, "DCM");
        item.setString(Tag.CodeMeaning, VR.LO, meaning);
        seq.add(item);
    }

    /** VR 別の既定ダミー値（バイナリ等で文字列不可なら null＝空にする）。 */
    /**
     * 日数シフトで扱える日付 VR か。
     *
     * <p>{@code TM}（時刻）は<b>含めない</b>。日単位のシフトでは時刻は定義上変化せず、
     * 時刻だけ独立にずらすと同一検査内の相対時刻が壊れる（投与後 1h / 4h のように
     * 同じ日に複数時点を撮る検査で間隔が失われる）。よって TM は K と同じく素通しさせる
     * ——ただし {@code isShiftableDateVr} が false を返すと {@code dummyForVr} 側に落ちるため、
     * TM の扱いは {@link #shiftDateValue} で明示的に「元の値を返す」としている。
     */
    private static boolean isShiftableDateVr(VR vr) {
        return vr == VR.DA || vr == VR.DT || vr == VR.TM;
    }

    /** DA/DT は日付部をシフト、TM は保持。解釈できなければ null（＝空にする）。 */
    private static String shiftDateValue(String original, VR vr, int days) {
        if (original == null || original.isBlank()) {
            return null;
        }
        return switch (vr) {
            case DA -> DateShifter.shiftDa(original, days);
            case DT -> DateShifter.shiftDt(original, days);
            // 時刻は日単位シフトの対象外。前後関係を保つため元の値をそのまま残す。
            case TM -> original;
            default -> null;
        };
    }

    private static String dummyForVr(VR vr) {
        return switch (vr) {
            case DA -> "20000101";
            case DT -> "20000101000000";
            case TM -> "000000";
            case AS -> "000Y";
            case IS, DS -> "0";
            case PN, LO, SH, ST, LT, UT, CS, UC, UR -> "ANONYMIZED";
            default -> null; // US/SS/UL/SL/FL/FD/AT/OB/OW/UN 等は空に
        };
    }

    private static String sanitizeForVr(String value, VR vr) {
        if (value == null) {
            return "";
        }
        if (vr == VR.AS) {
            return value.matches("\\d{3}[DWMY]") ? value : "000Y";
        }
        if (vr == VR.DA) {
            return value.matches("\\d{8}") ? value : "19000101";
        }
        if (vr == VR.CS || vr == VR.SH) {
            return value.length() > 16 ? value.substring(0, 16) : value;
        }
        if (vr == VR.LO) {
            return value.length() > 64 ? value.substring(0, 64) : value;
        }
        return value;
    }
}

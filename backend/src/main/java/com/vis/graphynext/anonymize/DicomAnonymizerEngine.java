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

    /** 患者単位の新 ID/Name。 */
    public record PatientMapping(String newPatId, String newPatName) {
    }

    static {
        AnonymizeTagDictionary.ensureLoaded();
    }

    /** 1 データセットを匿名化（破壊的）。 */
    public void deidentify(Attributes ds, AnonymizeConfig cfg, PatientMapping pmap, Map<String, String> uidMap) {
        deidentifyRecursive(ds, cfg, uidMap);

        ds.setString(Tag.PatientName, VR.PN, pmap.newPatName());
        ds.setString(Tag.PatientID, VR.LO, pmap.newPatId());

        // PS3.15 E.1.1 の method タグ
        ds.setString(Tag.PatientIdentityRemoved, VR.CS, "YES");
        ds.setString(Tag.DeidentificationMethod, VR.LO, "Basic Application Level Confidentiality Profile");
        Sequence method = ds.newSequence(Tag.DeidentificationMethodCodeSequence, 0);
        addCode(method, "113100", "Basic Application Confidentiality Profile");
        if (cfg.hasOption(AnonymizeConfig.Option.CleanPixelData)) {
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

    private void deidentifyRecursive(Attributes ds, AnonymizeConfig cfg, Map<String, String> uidMap) {
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
                    cleanStructuredContentSequence(ds, tag, cfg, uidMap);
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
                        deidentifyRecursive(item, cfg, uidMap);
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
                        applyTagAction(ds, tag, vr, action, cfg);
                    }
                } else if (!cfg.hasOption(AnonymizeConfig.Option.RetainUIDs)) {
                    replaceUid(ds, tag, vr, uidMap);
                }
                continue;
            }

            if (action != null && action != Action.K) {
                applyTagAction(ds, tag, vr, action, cfg);
            }
        }
    }

    private void applyTagAction(Attributes ds, int tag, VR vr, Action action, AnonymizeConfig cfg) {
        String customVal = cfg.getCustomTagReplacements().get(tag);
        switch (action) {
            case X -> ds.remove(tag);
            case Z -> ds.setNull(tag, vr);
            case D, C -> {
                String val = customVal != null ? sanitizeForVr(customVal.trim(), vr) : dummyForVr(vr);
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
    private void cleanStructuredContentSequence(Attributes ds, int tag, AnonymizeConfig cfg, Map<String, String> uidMap) {
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
                deidentifyRecursive(item, cfg, uidMap);
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

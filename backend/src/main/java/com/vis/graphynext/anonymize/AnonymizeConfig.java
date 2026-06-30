/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * 匿名化（PS3.15 Basic Application Confidentiality Profile）の設定（GRAPHY AnonymizeConfig 移植）。
 */
public class AnonymizeConfig {

    /** PS3.15 のオプション群（Table E.1-1 のオプション列に対応）。 */
    public enum Option {
        CleanPixelData,                                       // 113101
        CleanRecognizableVisualFeatures,                     // 113102
        CleanGraphics,                                       // 113103
        CleanStructuredContent,                              // 113104
        CleanDescriptors,                                    // 113105
        RetainLongitudinalTemporalInformationFullDates,      // 113106
        RetainLongitudinalTemporalInformationModifiedDates,  // 113107
        RetainPatientCharacteristics,                        // 113108
        RetainDeviceIdentity,                                // 113109
        RetainUIDs,                                          // 113110
        RetainSafePrivate,                                   // 113111
        RetainInstitutionIdentity,                           // 113112
    }

    private EnumSet<Option> options = EnumSet.noneOf(Option.class);
    private String replacePatientName = "de-identified";
    private String replacePatientId = "de-identified";
    private Long randomSeed;
    private Set<Integer> manualRetainTags = new HashSet<>();
    private Map<Integer, String> customTagReplacements = new HashMap<>();

    public EnumSet<Option> getOptions() {
        return options;
    }

    public void addOption(Option opt) {
        options.add(opt);
    }

    public boolean hasOption(Option opt) {
        return options.contains(opt);
    }

    public Set<Integer> getManualRetainTags() {
        return manualRetainTags;
    }

    public Map<Integer, String> getCustomTagReplacements() {
        return customTagReplacements;
    }

    public String getReplacePatientName() {
        return replacePatientName;
    }

    public void setReplacePatientName(String name) {
        this.replacePatientName = name;
    }

    public String getReplacePatientId() {
        return replacePatientId;
    }

    public void setReplacePatientId(String id) {
        this.replacePatientId = id;
    }

    public Long getRandomSeed() {
        return randomSeed;
    }

    public void setRandomSeed(Long randomSeed) {
        this.randomSeed = randomSeed;
    }

    /** 手動上書きを除いた、オプション＋既定によるアクション（UI のベース表示用）。 */
    public DicomTagRule.Action getActionByOptionsAndDefault(DicomTagRule rule) {
        if (rule == null) {
            return DicomTagRule.Action.X;
        }
        DicomTagRule.Action targetAction = null;
        for (Option opt : options) {
            if (rule.getOptionActions().containsKey(opt)) {
                DicomTagRule.Action actFromOpt = rule.getOptionActions().get(opt);
                // 加工/削除(C,X)は保持(K)より優先（安全側）。
                if (targetAction == null || actFromOpt == DicomTagRule.Action.C
                        || actFromOpt == DicomTagRule.Action.X) {
                    targetAction = actFromOpt;
                }
            }
        }
        return targetAction != null ? targetAction : rule.getDefaultAction();
    }

    /** エンジンが最終的に実行するアクションを決定する（GRAPHY 同ロジック）。 */
    public DicomTagRule.Action determineFinalAction(DicomTagRule rule) {
        if (rule == null) {
            return DicomTagRule.Action.X; // 辞書未登録は安全側で削除
        }
        if (rule.getTag() == 0x00100020) {
            return DicomTagRule.Action.D; // PatientID は常に置換
        }
        if (rule.getTag() == 0x00100010) {
            return (replacePatientName != null && !replacePatientName.isEmpty())
                    ? DicomTagRule.Action.D : DicomTagRule.Action.Z;
        }
        if (manualRetainTags.contains(rule.getTag())) {
            return DicomTagRule.Action.K; // 手動保持が最優先
        }
        if (customTagReplacements.containsKey(rule.getTag())) {
            return DicomTagRule.Action.D; // カスタムダミー値
        }
        return getActionByOptionsAndDefault(rule);
    }
}

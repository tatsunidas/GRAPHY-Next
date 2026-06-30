/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.anonymize.DicomTagRule.Action;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * PS3.15 の匿名化辞書（GRAPHY AnonymizeTagDictionary 移植）。CSV 3 表をクラスパスから読み込む:
 * <ul>
 *   <li>Table E.1-1 … タグ→基本アクション＋各オプション上書きアクション（{@link #RULE_MAP}）。</li>
 *   <li>Table E.3.10-1 … Safe Private（creator→安全要素シグネチャ集合, {@link #SAFE_PRIVATE_ATTRIBUTES}）。</li>
 *   <li>Table E.3.4-1 … Clean Structured Content の概念コード（{@link #SR_CLEAN_CODES}）。</li>
 * </ul>
 */
public final class AnonymizeTagDictionary {

    private static final Logger log = LoggerFactory.getLogger(AnonymizeTagDictionary.class);

    private static final String E1_1 = "dicom_dict/Table_E1_1_Application_Level_Confidentiality.csv";
    private static final String E3_10 = "dicom_dict/Table_E3_10-1_SafePrivateAttributes.csv";
    private static final String E3_4 =
            "dicom_dict/Table_E3_4-1_ApplicationLevelConfidentialityProfileCleanStructuredContentOptionContentItemConceptNameCodes.csv";

    public static final List<DicomTagRule> TAG_RULES = new ArrayList<>();
    public static final Map<Integer, DicomTagRule> RULE_MAP = new HashMap<>();
    public static final Set<String> SR_CLEAN_CODES = new HashSet<>();
    /** Private creator → 安全要素シグネチャ {@code (group<<16)|elemLower} の集合。 */
    public static final Map<String, Set<Integer>> SAFE_PRIVATE_ATTRIBUTES = new HashMap<>();

    static {
        loadRules();
        loadSrCleanCodes();
        loadSafePrivate();
        log.info("Anonymize dictionary loaded: rules={}, srCodes={}, safePrivateCreators={}",
                RULE_MAP.size(), SR_CLEAN_CODES.size(), SAFE_PRIVATE_ATTRIBUTES.size());
    }

    private AnonymizeTagDictionary() {
    }

    /** クラスのロードを促すだけのフック（静的初期化を確実に走らせる）。 */
    public static void ensureLoaded() {
        // no-op; static block does the work
    }

    private static final String CSV_SPLIT = ",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)";

    private static void loadRules() {
        try (BufferedReader br = reader(E1_1)) {
            if (br == null) {
                return;
            }
            String line;
            boolean header = true;
            while ((line = br.readLine()) != null) {
                if (header) {
                    header = false;
                    continue;
                }
                String[] cols = line.split(CSV_SPLIT, -1);
                if (cols.length < 15) {
                    continue;
                }
                String attrName = cols[0].replace("\"", "");
                String tagStr = cols[1].replace("\"", "").replace("(", "").replace(")", "");
                Action defaultAction = mapAction(cols[4]);
                if (tagStr.contains("gggg") && tagStr.contains("eeee")) {
                    continue; // 私的タグ総称は別ロジック（cleanPrivateTags）で処理
                }
                String[] parts = tagStr.split(",");
                if (parts.length != 2) {
                    continue;
                }
                String groupStr = parts[0].trim();
                String elemStr = parts[1].trim();
                if (elemStr.equals("xxxx")) {
                    elemStr = "0000";
                }
                if (groupStr.contains("xx")) {
                    // 繰り返しグループ(50xx,60xx 等)を 00..1E の偶数グループへ展開
                    String base = groupStr.substring(0, 2);
                    for (int i = 0; i <= 0x1E; i += 2) {
                        String expanded = String.format("%s%02X%s", base, i, elemStr);
                        addRule((int) Long.parseLong(expanded, 16),
                                attrName + " (Group " + String.format("%02X", i) + ")", defaultAction, cols);
                    }
                } else {
                    addRule((int) Long.parseLong(groupStr + elemStr, 16), attrName, defaultAction, cols);
                }
            }
        } catch (Exception e) {
            log.error("Anonymize rules CSV の読み込みに失敗", e);
        }
    }

    private static void addRule(int tag, String name, Action defaultAction, String[] cols) {
        DicomTagRule rule = new DicomTagRule(tag, name, defaultAction);
        applyOption(rule, cols[5], AnonymizeConfig.Option.RetainSafePrivate);
        applyOption(rule, cols[6], AnonymizeConfig.Option.RetainUIDs);
        applyOption(rule, cols[7], AnonymizeConfig.Option.RetainDeviceIdentity);
        applyOption(rule, cols[8], AnonymizeConfig.Option.RetainInstitutionIdentity);
        applyOption(rule, cols[9], AnonymizeConfig.Option.RetainPatientCharacteristics);
        applyOption(rule, cols[10], AnonymizeConfig.Option.RetainLongitudinalTemporalInformationFullDates);
        applyOption(rule, cols[11], AnonymizeConfig.Option.RetainLongitudinalTemporalInformationModifiedDates);
        applyOption(rule, cols[12], AnonymizeConfig.Option.CleanDescriptors);
        applyOption(rule, cols[13], AnonymizeConfig.Option.CleanStructuredContent);
        applyOption(rule, cols[14], AnonymizeConfig.Option.CleanGraphics);
        TAG_RULES.add(rule);
        RULE_MAP.put(tag, rule);
    }

    private static void applyOption(DicomTagRule rule, String colValue, AnonymizeConfig.Option option) {
        String val = colValue.replace("\"", "").trim();
        if (!val.isEmpty()) {
            rule.addOptionAction(option, mapAction(val));
        }
    }

    private static Action mapAction(String raw) {
        String act = raw.replace("\"", "").trim();
        if (act.contains("U*") || act.equals("U")) {
            return Action.U;
        }
        if (act.contains("D")) {
            return Action.D; // Z/D, X/D, X/Z/D -> D
        }
        if (act.contains("Z")) {
            return Action.Z; // X/Z -> Z
        }
        if (act.equals("X")) {
            return Action.X;
        }
        if (act.equals("K")) {
            return Action.K;
        }
        if (act.equals("C")) {
            return Action.C;
        }
        return Action.X;
    }

    private static void loadSrCleanCodes() {
        try (BufferedReader br = reader(E3_4)) {
            if (br == null) {
                return;
            }
            String line;
            boolean header = true;
            while ((line = br.readLine()) != null) {
                if (header) {
                    header = false;
                    continue;
                }
                String[] cols = line.split(CSV_SPLIT, -1);
                if (cols.length < 4) {
                    continue;
                }
                String codeValue = cols[1].replace("\"", "").trim();
                String codingScheme = cols[2].replace("\"", "").trim();
                if (!codeValue.isEmpty() && !codingScheme.isEmpty()) {
                    SR_CLEAN_CODES.add(codingScheme + ":" + codeValue);
                }
            }
        } catch (Exception e) {
            log.error("SR clean codes CSV の読み込みに失敗", e);
        }
    }

    private static void loadSafePrivate() {
        try (BufferedReader br = reader(E3_10)) {
            if (br == null) {
                return;
            }
            String line;
            boolean header = true;
            while ((line = br.readLine()) != null) {
                if (header) {
                    header = false;
                    continue;
                }
                String[] cols = line.split(CSV_SPLIT, -1);
                if (cols.length < 2) {
                    continue;
                }
                String de = cols[0].replace("\"", "").replace("(", "").replace(")", "").trim();
                String creator = cols[1].replace("\"", "").trim();
                if (!de.contains(",")) {
                    continue;
                }
                String[] parts = de.split(",");
                try {
                    int group = Integer.parseInt(parts[0].trim(), 16);
                    int elemLower = Integer.parseInt(parts[1].trim().replace("xx", "00"), 16);
                    int signature = (group << 16) | elemLower;
                    SAFE_PRIVATE_ATTRIBUTES.computeIfAbsent(creator, k -> new HashSet<>()).add(signature);
                } catch (NumberFormatException ignore) {
                    // skip
                }
            }
        } catch (Exception e) {
            log.error("Safe private CSV の読み込みに失敗", e);
        }
    }

    private static BufferedReader reader(String resource) {
        InputStream is = AnonymizeTagDictionary.class.getClassLoader().getResourceAsStream(resource);
        if (is == null) {
            log.error("Anonymize CSV が見つかりません: {}", resource);
            return null;
        }
        return new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * プラグインが {@code plugin.json} の {@code skills[]} で宣言する、AI アシスタント向けのスキル（入力と確認つきの処理手順）。
 *
 * <p>宣言は信頼できない入力。ここで見るのは**権限・件数・大きさ・トップレベルの形**だけで、手順の中身
 * （操作 id・引数・順序）は main（形・名前の書き換え）とアシスタント窓（実行の直前）が検査する。
 * 通らないスキルは黙って捨てず、理由をログに残して捨てる。作り直した（許可したキーだけの）値を配信する。
 */
public final class SkillSpec {

    private SkillSpec() {}

    public static final int MAX_SKILLS_PER_PLUGIN = 4;
    public static final int MAX_BYTES = 16 * 1024;
    public static final int MAX_STEPS = 40;
    public static final int MAX_INPUTS = 8;
    private static final Pattern ID = Pattern.compile("^[a-z0-9][a-z0-9-]{0,39}$");
    private static final List<String> KEYS = List.of("id", "title", "description", "inputs", "steps");
    private static final ObjectMapper M = new ObjectMapper();

    public static List<Map<String, Object>> sanitize(List<Map<String, Object>> raw, List<String> permissions, Consumer<String> reject) {
        if (raw == null || raw.isEmpty()) return List.of();
        if (permissions == null || !permissions.contains(AiToolSpec.PERMISSION)) {
            reject.accept("skills declared without the '" + AiToolSpec.PERMISSION + "' permission");
            return List.of();
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> s : raw) {
            if (out.size() >= MAX_SKILLS_PER_PLUGIN) {
                reject.accept("more than " + MAX_SKILLS_PER_PLUGIN + " skills (extra ones dropped)");
                break;
            }
            try {
                out.add(one(s, out));
            } catch (IllegalArgumentException e) {
                reject.accept("skill dropped: " + e.getMessage());
            }
        }
        return List.copyOf(out);
    }

    private static Map<String, Object> one(Map<String, Object> s, List<Map<String, Object>> already) {
        if (s == null) throw new IllegalArgumentException("null entry");
        for (String k : s.keySet()) {
            if (!KEYS.contains(k)) throw new IllegalArgumentException("unknown key '" + k + "'");
        }
        Object id = s.get("id");
        if (!(id instanceof String ids) || !ID.matcher(ids).matches()) throw new IllegalArgumentException("bad id");
        if (already.stream().anyMatch(a -> ids.equals(a.get("id")))) throw new IllegalArgumentException("duplicate id " + ids);
        localText(ids, "title", s.get("title"));
        localText(ids, "description", s.get("description"));
        Object inputs = s.get("inputs") == null ? List.of() : s.get("inputs");
        if (!(inputs instanceof List<?> il) || il.size() > MAX_INPUTS) throw new IllegalArgumentException(ids + ": inputs must be an array of at most " + MAX_INPUTS);
        if (!(s.get("steps") instanceof List<?> sl) || sl.isEmpty() || sl.size() > MAX_STEPS) {
            throw new IllegalArgumentException(ids + ": steps must be an array of 1.." + MAX_STEPS);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", ids);
        out.put("title", s.get("title"));
        out.put("description", s.get("description"));
        out.put("inputs", il);
        out.put("steps", sl);
        try {
            if (M.writeValueAsBytes(out).length > MAX_BYTES) throw new IllegalArgumentException(ids + ": larger than " + MAX_BYTES + " bytes");
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException(ids + ": not serializable");
        }
        return out;
    }

    private static void localText(String id, String key, Object v) {
        if (!(v instanceof Map<?, ?> m) || !(m.get("ja") instanceof String) || !(m.get("en") instanceof String)) {
            throw new IllegalArgumentException(id + ": " + key + " must be {ja, en} strings");
        }
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 公式索引（{@code index.json}）の解析と検証。設計: fw/plugin-manager-design.md §8。
 *
 * <p>索引は「見つけるための一覧」でしかなく、安全の根拠にはしない。公式かどうかは索引の自己申告ではなく
 * 導入前検査（{@code inspect}）で公式鍵の署名が通ったかで決まるので、ここには区分（tier）の項目を持たない。
 * 壊れた行は全体を捨てずにその行だけ除外し、理由を返す。
 */
final class PluginCatalog {

    private static final Pattern ID = Pattern.compile("[a-z0-9][a-z0-9._-]{0,63}");
    private static final Pattern REPO = Pattern.compile("[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}");
    private static final Pattern KEY_ID = Pattern.compile("[0-9A-Fa-f]{16}");
    private static final int MAX_ENTRIES = 1000;
    private static final int MAX_TEXT = 500;

    private PluginCatalog() {}

    /**
     * 索引の 1 エントリ。
     *
     * @param signerKeyId 作者が署名に使う minisign 鍵 ID（任意）。導入時に実際の署名と突き合わせる材料
     * @param minGraphy   必要な本体の最小版（任意・表示用）
     */
    record Entry(String id, String name, String repo, String description, String category,
                 String signerKeyId, String minGraphy) {}

    /** 解析結果。{@code rejected} は除外した行の理由（画面に出す）。 */
    record Parsed(List<Entry> entries, List<String> rejected) {}

    /** @throws PluginInstallException JSON として読めない、または形式が違う（全体不正） */
    static Parsed parse(byte[] json, ObjectMapper mapper) {
        JsonNode root;
        try {
            root = mapper.readTree(json);
        } catch (Exception e) {
            throw new PluginInstallException("plugin index is not valid JSON: " + e.getMessage());
        }
        if (root == null || !root.isObject() || !root.path("plugins").isArray()) {
            throw new PluginInstallException("plugin index must be an object with a \"plugins\" array");
        }
        List<Entry> entries = new ArrayList<>();
        List<String> rejected = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        int n = 0;
        for (JsonNode row : root.get("plugins")) {
            n++;
            if (n > MAX_ENTRIES) {
                rejected.add("more than " + MAX_ENTRIES + " entries: the rest were ignored");
                break;
            }
            String problem = validate(row);
            String id = text(row, "id");
            if (problem == null && !seen.add(id)) problem = "duplicate id";
            if (problem != null) {
                rejected.add("#" + n + (id == null ? "" : " (" + clip(id) + ")") + ": " + problem);
                continue;
            }
            entries.add(new Entry(id, text(row, "name"), text(row, "repo"), text(row, "description"),
                    text(row, "category"), upper(text(row, "signerKeyId")), text(row, "minGraphy")));
        }
        return new Parsed(entries, rejected);
    }

    private static String validate(JsonNode row) {
        if (row == null || !row.isObject()) return "not an object";
        String id = text(row, "id");
        if (id == null || !ID.matcher(id).matches()) return "invalid id";
        String name = text(row, "name");
        if (name == null || name.isBlank()) return "name is required";
        String repo = text(row, "repo");
        if (repo == null || !REPO.matcher(repo).matches()) return "invalid repo (owner/repo)";
        String key = text(row, "signerKeyId");
        if (key != null && !KEY_ID.matcher(key).matches()) return "invalid signerKeyId (16 hex digits)";
        return null;
    }

    /** 文字列以外・空・長すぎる値は「無い」とみなす（長すぎる説明で画面を壊されないように切る）。 */
    private static String text(JsonNode row, String field) {
        JsonNode v = row.get(field);
        if (v == null || !v.isTextual() || v.asText().isBlank()) return null;
        return clip(v.asText().trim());
    }

    private static String clip(String s) {
        return s.length() > MAX_TEXT ? s.substring(0, MAX_TEXT) : s;
    }

    private static String upper(String s) {
        return s == null ? null : s.toUpperCase(java.util.Locale.ROOT);
    }
}

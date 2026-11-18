/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.facility;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 施設の資料パネルの設定（JSON 文字列）を検証して {@link FacilityConfig} にする（純関数）。
 *
 * <p>🔴 <b>不正ならファイル全体を採用しない</b>（一部だけ表示して、直したつもりで古い項目が残るのを避ける）。
 * 失敗の理由は<b>コードと場所（JSON パス）だけ</b>で返す。内容そのものはエラーに入れない。
 * リンクは <b>https か mailto だけ</b>（{@code javascript:}・{@code file:}・{@code data:}・{@code http:}・相対は不正）。
 * 未知のキーは無視する（将来の拡張で古い本体が読めなくならない）。
 */
public final class FacilityConfigParser {

    private FacilityConfigParser() {
    }

    /** 本体が知っている最大のスキーマ版。これより大きい版は読まない。 */
    public static final int SCHEMA_VERSION = 1;
    /** 入れ子の深さ（最上位のグループを 1 と数える）。 */
    public static final int MAX_DEPTH = 3;
    public static final int MAX_GROUPS = 200;
    public static final int MAX_ITEMS = 2000;
    static final int MAX_TITLE = 200;
    static final int MAX_NOTE = 400;
    static final int MAX_BODY = 4000;
    static final int MAX_URL = 2000;

    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9._-]{1,64}$");
    private static final ObjectMapper MAPPER = new ObjectMapper().enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION);

    /** 結果。{@code config} か {@code error} のどちらか 1 つだけが入る。 */
    public record Result(FacilityConfig config, String error, String errorPath) {
        public boolean ok() {
            return config != null;
        }
    }

    private static final class Fail extends RuntimeException {
        final String code;
        final String path;

        Fail(String code, String path) {
            super(code, null, false, false);
            this.code = code;
            this.path = path;
        }
    }

    private static final class Ctx {
        int groups;
        int items;
        final Set<String> ids = new HashSet<>();
    }

    public static Result parse(String json) {
        if (json == null || json.isBlank()) {
            return new Result(null, "parse", ""); // 空のファイルは JSON として読めない
        }
        JsonNode root;
        try {
            root = MAPPER.readTree(json);
        } catch (Exception e) {
            return new Result(null, "parse", "");
        }
        try {
            return new Result(build(root), null, null);
        } catch (Fail f) {
            return new Result(null, f.code, f.path);
        }
    }

    private static FacilityConfig build(JsonNode root) {
        if (root == null || !root.isObject()) {
            throw new Fail("schema", "");
        }
        JsonNode v = root.get("schemaVersion");
        if (v == null || !v.isInt()) {
            throw new Fail("schema", "schemaVersion");
        }
        if (v.intValue() > SCHEMA_VERSION) {
            throw new Fail("schema-version", "schemaVersion");
        }
        if (v.intValue() < 1) {
            throw new Fail("schema", "schemaVersion");
        }
        String title = optText(root, "title", "title", MAX_TITLE);
        String updatedAt = optText(root, "updatedAt", "updatedAt", 40);
        String contact = optText(root, "contact", "contact", MAX_URL);
        if (contact != null && !validMailto(contact)) {
            throw new Fail("url", "contact");
        }
        JsonNode gs = root.get("groups");
        if (gs == null || !gs.isArray()) {
            throw new Fail("schema", "groups");
        }
        Ctx ctx = new Ctx();
        return new FacilityConfig(title, updatedAt, contact, groups(gs, "groups", 1, ctx));
    }

    private static List<FacilityConfig.Group> groups(JsonNode arr, String path, int depth, Ctx ctx) {
        if (depth > MAX_DEPTH) {
            throw new Fail("limit", path);
        }
        List<FacilityConfig.Group> out = new ArrayList<>();
        for (int i = 0; i < arr.size(); i++) {
            String p = path + "[" + i + "]";
            JsonNode g = arr.get(i);
            if (!g.isObject()) {
                throw new Fail("schema", p);
            }
            if (++ctx.groups > MAX_GROUPS) {
                throw new Fail("limit", p);
            }
            String id = reqId(g, p);
            if (!ctx.ids.add("g:" + id)) {
                throw new Fail("id-duplicate", p + ".id");
            }
            String title = reqText(g, "title", p + ".title", MAX_TITLE);
            List<FacilityConfig.Item> items = new ArrayList<>();
            JsonNode its = g.get("items");
            if (its != null) {
                if (!its.isArray()) {
                    throw new Fail("schema", p + ".items");
                }
                for (int k = 0; k < its.size(); k++) {
                    items.add(item(its.get(k), p + ".items[" + k + "]", id, k, ctx));
                }
            }
            List<FacilityConfig.Group> subs = List.of();
            JsonNode sub = g.get("groups");
            if (sub != null) {
                if (!sub.isArray()) {
                    throw new Fail("schema", p + ".groups");
                }
                subs = groups(sub, p + ".groups", depth + 1, ctx);
            }
            out.add(new FacilityConfig.Group(id, title, List.copyOf(items), subs));
        }
        return List.copyOf(out);
    }

    private static FacilityConfig.Item item(JsonNode n, String p, String groupId, int index, Ctx ctx) {
        if (!n.isObject()) {
            throw new Fail("schema", p);
        }
        if (++ctx.items > MAX_ITEMS) {
            throw new Fail("limit", p);
        }
        String type = reqText(n, "type", p + ".type", 16);
        if (!type.equals("link") && !type.equals("card")) {
            throw new Fail("schema", p + ".type");
        }
        String id = n.has("id") ? reqId(n, p) : groupId + "." + index;
        if (!ctx.ids.add("i:" + id)) {
            throw new Fail("id-duplicate", p + ".id");
        }
        String title = reqText(n, "title", p + ".title", MAX_TITLE);
        String note = optText(n, "note", p + ".note", MAX_NOTE);
        String url = null;
        String body = null;
        if (type.equals("link")) {
            url = reqText(n, "url", p + ".url", MAX_URL);
            if (!validUrl(url)) {
                throw new Fail("url", p + ".url");
            }
        } else {
            body = reqText(n, "body", p + ".body", MAX_BODY);
            if (n.has("url")) {
                url = optText(n, "url", p + ".url", MAX_URL);
                if (url != null && !validUrl(url)) {
                    throw new Fail("url", p + ".url");
                }
            }
        }
        return new FacilityConfig.Item(id, type, title, url, note, body);
    }

    private static String reqId(JsonNode n, String p) {
        String id = reqText(n, "id", p + ".id", 64);
        if (!ID.matcher(id).matches()) {
            throw new Fail("schema", p + ".id");
        }
        return id;
    }

    private static String reqText(JsonNode n, String key, String path, int max) {
        String s = optText(n, key, path, max);
        if (s == null || s.isBlank()) {
            throw new Fail("schema", path);
        }
        return s;
    }

    private static String optText(JsonNode n, String key, String path, int max) {
        JsonNode v = n.get(key);
        if (v == null || v.isNull()) {
            return null;
        }
        if (!v.isTextual()) {
            throw new Fail("schema", path);
        }
        String s = v.textValue();
        if (s.codePointCount(0, s.length()) > max) {
            throw new Fail("limit", path);
        }
        return s;
    }

    /** https（ホストあり・ユーザー情報なし）か mailto だけ。 */
    public static boolean validUrl(String s) {
        return validHttps(s) || validMailto(s);
    }

    private static boolean noControl(String s) {
        return s.chars().noneMatch(c -> Character.isISOControl(c) || Character.isWhitespace(c));
    }

    static boolean validHttps(String s) {
        if (s == null || s.length() > MAX_URL || !noControl(s)) {
            return false;
        }
        try {
            URI u = new URI(s);
            return "https".equals(u.getScheme() == null ? null : u.getScheme().toLowerCase(Locale.ROOT))
                    && u.getHost() != null && !u.getHost().isEmpty() && u.getUserInfo() == null;
        } catch (URISyntaxException e) {
            return false;
        }
    }

    static boolean validMailto(String s) {
        if (s == null || s.length() > MAX_URL || !noControl(s)) {
            return false;
        }
        try {
            URI u = new URI(s);
            if (u.getScheme() == null || !"mailto".equals(u.getScheme().toLowerCase(Locale.ROOT))) {
                return false;
            }
            String ssp = u.getSchemeSpecificPart();
            int q = ssp.indexOf('?');
            String addr = q >= 0 ? ssp.substring(0, q) : ssp;
            return !addr.isEmpty();
        } catch (URISyntaxException e) {
            return false;
        }
    }
}

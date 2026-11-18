/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.facility;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 設定ファイルの検証: 例のファイル全体が読め、各違反は理由コードと場所（内容は返さない）で断る。 */
class FacilityConfigParserTest {

    static final String SAMPLE = """
            {
              "schemaVersion": 1,
              "title": "放射線科 資料",
              "updatedAt": "2026-11-18",
              "contact": "mailto:rad-info@example.org",
              "unknownKey": {"x": 1},
              "groups": [
                { "id": "protocols", "title": "撮影プロトコル",
                  "items": [ { "type": "link", "title": "造影 CT", "url": "https://intra.example.org/proto/ct", "note": "2026-10 改訂" } ],
                  "groups": [ { "id": "peds", "title": "小児",
                    "items": [ { "type": "link", "id": "sed", "title": "鎮静の目安", "url": "https://intra.example.org/peds/sedation" } ] } ] },
                { "id": "phones", "title": "電話帳",
                  "items": [ { "type": "card", "title": "当直・緊急", "body": "放射線科 当直 内線 1234\\nCT 室 内線 5678" },
                             { "type": "link", "title": "IT 問い合わせ", "url": "mailto:it@example.org?subject=help" } ] }
              ]
            }
            """;

    private static FacilityConfigParser.Result parse(String json) {
        return FacilityConfigParser.parse(json);
    }

    private static void assertFail(String json, String code, String path) {
        FacilityConfigParser.Result r = parse(json);
        assertFalse(r.ok(), json);
        assertEquals(code, r.error(), json);
        assertEquals(path, r.errorPath(), json);
    }

    private static String withGroup(String groupBody) {
        return "{\"schemaVersion\":1,\"groups\":[" + groupBody + "]}";
    }

    @Test
    void 例のファイル全体が読め_未知のキーは無視され_項目idは自動で付く() {
        FacilityConfigParser.Result r = parse(SAMPLE);
        assertTrue(r.ok());
        FacilityConfig c = r.config();
        assertEquals("放射線科 資料", c.title());
        assertEquals("mailto:rad-info@example.org", c.contact());
        assertEquals(2, c.groups().size());
        FacilityConfig.Group protocols = c.groups().get(0);
        assertEquals("protocols.0", protocols.items().get(0).id());
        assertEquals("sed", protocols.groups().get(0).items().get(0).id());
        FacilityConfig.Item card = c.groups().get(1).items().get(0);
        assertEquals("card", card.type());
        assertTrue(card.body().contains("内線 1234"));
        assertNull(card.url());
        assertEquals("mailto:it@example.org?subject=help", c.groups().get(1).items().get(1).url());
    }

    @Test
    void JSONとして読めない_ルートが配列_は断る() {
        assertFail("{ not json", "parse", "");
        assertFail("", "parse", "");
        assertFail("[1,2]", "schema", "");
        assertFail("{\"schemaVersion\":1,\"groups\":[],\"groups\":[]}", "parse", ""); // キーの重複
    }

    @Test
    void スキーマ版() {
        assertFail("{\"groups\":[]}", "schema", "schemaVersion");
        assertFail("{\"schemaVersion\":\"1\",\"groups\":[]}", "schema", "schemaVersion");
        assertFail("{\"schemaVersion\":0,\"groups\":[]}", "schema", "schemaVersion");
        assertFail("{\"schemaVersion\":2,\"groups\":[]}", "schema-version", "schemaVersion");
        assertTrue(parse("{\"schemaVersion\":1,\"groups\":[]}").ok());
    }

    @Test
    void 不正なリンクのスキームは項目の場所を示して断る() {
        for (String bad : new String[] {"javascript:alert(1)", "http://intra.example.org/a", "file:///etc/passwd",
                "data:text/html,x", "//intra.example.org/a", "/relative/path", "https://", "https://user:pw@intra.example.org/",
                "ftp://intra.example.org/", "https://intra example.org/", "mailto:"}) {
            String j = withGroup("{\"id\":\"g\",\"title\":\"G\",\"items\":[{\"type\":\"link\",\"title\":\"T\",\"url\":\"" + bad + "\"}]}");
            assertFail(j, "url", "groups[0].items[0].url");
        }
        // 大文字のスキームは正しいスキームとして扱う（https は https）
        assertTrue(parse(withGroup("{\"id\":\"g\",\"title\":\"G\",\"items\":[{\"type\":\"link\",\"title\":\"T\",\"url\":\"HTTPS://intra.example.org/\"}]}")).ok());
    }

    @Test
    void 連絡先は_mailto_だけ() {
        assertFail("{\"schemaVersion\":1,\"contact\":\"https://example.org\",\"groups\":[]}", "url", "contact");
        assertTrue(parse("{\"schemaVersion\":1,\"contact\":\"mailto:a@example.org\",\"groups\":[]}").ok());
    }

    @Test
    void リンクにはurl_カードにはbodyが要る_種類は2つだけ() {
        assertFail(withGroup("{\"id\":\"g\",\"title\":\"G\",\"items\":[{\"type\":\"link\",\"title\":\"T\"}]}"), "schema", "groups[0].items[0].url");
        assertFail(withGroup("{\"id\":\"g\",\"title\":\"G\",\"items\":[{\"type\":\"card\",\"title\":\"T\"}]}"), "schema", "groups[0].items[0].body");
        assertFail(withGroup("{\"id\":\"g\",\"title\":\"G\",\"items\":[{\"type\":\"image\",\"title\":\"T\"}]}"), "schema", "groups[0].items[0].type");
        assertFail(withGroup("{\"id\":\"g\",\"title\":\"G\",\"items\":[{\"type\":\"card\",\"title\":\"T\",\"body\":\"b\",\"url\":\"javascript:x\"}]}"), "url", "groups[0].items[0].url");
    }

    @Test
    void idの形と重複() {
        assertFail(withGroup("{\"id\":\"a b\",\"title\":\"G\"}"), "schema", "groups[0].id");
        assertFail(withGroup("{\"title\":\"G\"}"), "schema", "groups[0].id");
        assertFail(withGroup("{\"id\":\"g\",\"title\":\"G\"},{\"id\":\"g\",\"title\":\"H\"}"), "id-duplicate", "groups[1].id");
        assertFail(withGroup("{\"id\":\"g\",\"title\":\"G\",\"items\":[{\"type\":\"card\",\"id\":\"x\",\"title\":\"T\",\"body\":\"b\"},{\"type\":\"card\",\"id\":\"x\",\"title\":\"U\",\"body\":\"b\"}]}"),
                "id-duplicate", "groups[0].items[1].id");
    }

    @Test
    void 入れ子の深さは3段まで() {
        String l3 = "{\"id\":\"c\",\"title\":\"C\"}";
        String l2 = "{\"id\":\"b\",\"title\":\"B\",\"groups\":[" + l3 + "]}";
        String ok = withGroup("{\"id\":\"a\",\"title\":\"A\",\"groups\":[" + l2 + "]}");
        assertTrue(parse(ok).ok());
        String l4 = "{\"id\":\"d\",\"title\":\"D\"}";
        String deep = withGroup("{\"id\":\"a\",\"title\":\"A\",\"groups\":[{\"id\":\"b\",\"title\":\"B\",\"groups\":[{\"id\":\"c\",\"title\":\"C\",\"groups\":[" + l4 + "]}]}]}");
        assertFail(deep, "limit", "groups[0].groups[0].groups[0].groups");
    }

    @Test
    void 件数と長さの上限() {
        StringBuilder gs = new StringBuilder();
        for (int i = 0; i <= FacilityConfigParser.MAX_GROUPS; i++) {
            gs.append(i > 0 ? "," : "").append("{\"id\":\"g").append(i).append("\",\"title\":\"G\"}");
        }
        FacilityConfigParser.Result tooMany = parse(withGroup(gs.toString()));
        assertEquals("limit", tooMany.error());
        assertEquals("groups[" + FacilityConfigParser.MAX_GROUPS + "]", tooMany.errorPath());

        StringBuilder its = new StringBuilder();
        for (int i = 0; i <= FacilityConfigParser.MAX_ITEMS; i++) {
            its.append(i > 0 ? "," : "").append("{\"type\":\"card\",\"title\":\"T\",\"body\":\"b\"}");
        }
        assertEquals("limit", parse(withGroup("{\"id\":\"g\",\"title\":\"G\",\"items\":[" + its + "]}")).error());

        String longTitle = "あ".repeat(FacilityConfigParser.MAX_TITLE + 1);
        assertFail(withGroup("{\"id\":\"g\",\"title\":\"" + longTitle + "\"}"), "limit", "groups[0].title");
        assertTrue(parse(withGroup("{\"id\":\"g\",\"title\":\"" + "あ".repeat(FacilityConfigParser.MAX_TITLE) + "\"}")).ok());
        String longBody = "x".repeat(FacilityConfigParser.MAX_BODY + 1);
        assertFail(withGroup("{\"id\":\"g\",\"title\":\"G\",\"items\":[{\"type\":\"card\",\"title\":\"T\",\"body\":\"" + longBody + "\"}]}"), "limit", "groups[0].items[0].body");
    }

    @Test
    void 失敗の理由に_ファイルの内容は入らない() {
        String secret = "SECRET-VALUE-123";
        FacilityConfigParser.Result r = parse(withGroup("{\"id\":\"g\",\"title\":\"G\",\"items\":[{\"type\":\"link\",\"title\":\"T\",\"url\":\"javascript:" + secret + "\"}]}"));
        assertNotNull(r.error());
        assertFalse((r.error() + r.errorPath()).contains(secret));
    }
}

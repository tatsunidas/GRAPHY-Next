/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SkillSpecTest {

    private static final ObjectMapper M = new ObjectMapper();
    private static final List<String> OK = List.of("ai-tools");

    private static List<Map<String, Object>> parse(String json) throws Exception {
        return M.readValue(json, new TypeReference<>() {});
    }

    private static String skill(String id, String extra) {
        return "{\"id\":\"" + id + "\",\"title\":{\"ja\":\"題\",\"en\":\"T\"},\"description\":{\"ja\":\"説\",\"en\":\"D\"},"
                + "\"steps\":[{\"kind\":\"tool\",\"id\":\"plugin:go\",\"params\":{}}]" + extra + "}";
    }

    private static List<Map<String, Object>> run(String json, List<String> perms, List<String> why) throws Exception {
        return SkillSpec.sanitize(parse(json), perms, why::add);
    }

    @Test
    void validDeclarationIsRebuiltWithoutUnknownKeys() throws Exception {
        List<String> why = new ArrayList<>();
        var out = run("[" + skill("organ-volume", "") + "]", OK, why);
        assertEquals(1, out.size());
        assertEquals(List.of("id", "title", "description", "inputs", "steps"), List.copyOf(out.get(0).keySet()));
        assertTrue(why.isEmpty(), why.toString());
    }

    @Test
    void withoutPermissionNothingIsServed() throws Exception {
        List<String> why = new ArrayList<>();
        assertTrue(run("[" + skill("a", "") + "]", List.of(), why).isEmpty());
        assertTrue(why.get(0).contains("permission"));
    }

    @Test
    void badEntriesAreDroppedWithAReasonAndOthersSurvive() throws Exception {
        List<String> why = new ArrayList<>();
        String json = "[" + String.join(",",
                skill("Bad Id", ""),                                   // 不正な id
                skill("ok-one", ""),
                skill("ok-one", ""),                                   // 重複
                skill("extra-key", ",\"run\":\"calc\""),               // 未知のキー
                "{\"id\":\"no-title\",\"description\":{\"ja\":\"a\",\"en\":\"b\"},\"steps\":[{}]}",
                "{\"id\":\"no-steps\",\"title\":{\"ja\":\"a\",\"en\":\"b\"},\"description\":{\"ja\":\"a\",\"en\":\"b\"},\"steps\":[]}") + "]";
        var out = run(json, OK, why);
        assertEquals(List.of("ok-one"), out.stream().map(m -> (String) m.get("id")).toList());
        assertEquals(5, why.size(), why.toString());
    }

    @Test
    void fifthSkillAndOversizedSkillAreDropped() throws Exception {
        List<String> why = new ArrayList<>();
        var five = run("[" + String.join(",", skill("a", ""), skill("b", ""), skill("c", ""), skill("d", ""), skill("e", "")) + "]", OK, why);
        assertEquals(4, five.size());
        assertTrue(why.stream().anyMatch(w -> w.contains("more than 4")));
        List<String> why2 = new ArrayList<>();
        String big = "x".repeat(SkillSpec.MAX_BYTES);
        var out = run("[{\"id\":\"big\",\"title\":{\"ja\":\"" + big + "\",\"en\":\"t\"},\"description\":{\"ja\":\"d\",\"en\":\"d\"},\"steps\":[{\"kind\":\"confirm\"}]}]", OK, why2);
        assertTrue(out.isEmpty());
        assertTrue(why2.get(0).contains("larger than"));
    }

    @Test
    void manifestCarriesSkillsOnlyWhenPresent() throws Exception {
        var m = new PluginManifest("p", "P", "1", null, null, OK, null, null, run("[" + skill("a", "") + "]", OK, new ArrayList<>()));
        assertTrue(M.writeValueAsString(m).contains("\"skills\""));
        assertTrue(!M.writeValueAsString(new PluginManifest("p", "P", "1", null, null, List.of(), null)).contains("skills"));
    }
}

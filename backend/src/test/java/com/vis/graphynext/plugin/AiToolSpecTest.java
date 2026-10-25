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

class AiToolSpecTest {

    private static final ObjectMapper M = new ObjectMapper();
    private static final List<String> OK = List.of("ai-tools");

    private static List<Map<String, Object>> tools(String json) throws Exception {
        return M.readValue(json, new TypeReference<>() {});
    }

    private static List<AiToolSpec> run(String json, List<String> perms, List<String> why) throws Exception {
        return AiToolSpec.sanitize(tools(json), perms, why::add);
    }

    @Test
    void validDeclarationIsRebuilt() throws Exception {
        List<String> why = new ArrayList<>();
        var out = run("""
                [{"name":"measure_lesion","description":" Measure it. ","effect":"read",
                  "parameters":{"type":"object","properties":{
                    "label":{"type":"string","maxLength":40,"description":"x"},
                    "mode":{"type":"string","enum":["a","b"]},
                    "n":{"type":"integer","minimum":1,"maximum":9}},
                   "required":["n"]}}]""", OK, why);
        assertEquals(1, out.size());
        assertTrue(why.isEmpty(), why.toString());
        assertEquals("Measure it.", out.get(0).description());
        assertEquals(List.of("n"), out.get(0).parameters().get("required"));
    }

    @Test
    void withoutPermissionNothingIsExposed() throws Exception {
        List<String> why = new ArrayList<>();
        String t = "[{\"name\":\"a\",\"description\":\"d\",\"effect\":\"read\"}]";
        assertTrue(run(t, List.of("read-pixels"), why).isEmpty());
        assertTrue(run(t, null, why).isEmpty());
        assertEquals(2, why.size());
        assertEquals(1, run(t, OK, new ArrayList<>()).size()); // 正例: 権限があれば出る
    }

    @Test
    void writeIsAcceptedButUnknownEffectsAreDropped() throws Exception {
        List<String> why = new ArrayList<>();
        var out = run("""
                [{"name":"w","description":"d","effect":"write"},
                 {"name":"x","description":"d"},
                 {"name":"y","description":"d","effect":"Write"},
                 {"name":"z","description":"d","effect":"write "},
                 {"name":"ok","description":"d","effect":"display"}]""", OK, why);
        assertEquals(List.of("w", "ok"), out.stream().map(AiToolSpec::name).toList());
        assertEquals("write", out.get(0).effect());
        assertEquals(3, why.size());
    }

    @Test
    void badShapesAreDropped() throws Exception {
        String[] bad = {
                "{\"name\":\"Bad-Name\",\"description\":\"d\",\"effect\":\"read\"}",
                "{\"name\":\"a\",\"description\":\"\",\"effect\":\"read\"}",
                "{\"name\":\"a\",\"description\":\"" + "x".repeat(301) + "\",\"effect\":\"read\"}",
                "{\"name\":\"a\",\"description\":\"d\",\"effect\":\"read\",\"extra\":1}",
                "{\"name\":\"a\",\"description\":\"d\",\"effect\":\"read\",\"parameters\":{\"properties\":{\"p\":{\"type\":\"object\"}}}}",
                "{\"name\":\"a\",\"description\":\"d\",\"effect\":\"read\",\"parameters\":{\"properties\":{\"p\":{\"type\":\"array\"}}}}",
                "{\"name\":\"a\",\"description\":\"d\",\"effect\":\"read\",\"parameters\":{\"properties\":{\"p\":{\"type\":\"string\"}}}}",
                "{\"name\":\"a\",\"description\":\"d\",\"effect\":\"read\",\"parameters\":{\"properties\":{\"p\":{\"type\":\"number\",\"minimum\":5,\"maximum\":1}}}}",
                "{\"name\":\"a\",\"description\":\"d\",\"effect\":\"read\",\"parameters\":{\"properties\":{\"p\":{\"type\":\"number\",\"minimum\":0}}}}",
                "{\"name\":\"a\",\"description\":\"d\",\"effect\":\"read\",\"parameters\":{\"properties\":{\"p\":{\"type\":\"string\",\"maxLength\":5,\"pattern\":\".*\"}}}}",
                "{\"name\":\"a\",\"description\":\"d\",\"effect\":\"read\",\"parameters\":{\"required\":[\"nope\"]}}",
                "{\"name\":\"a\",\"description\":\"d\",\"effect\":\"read\",\"parameters\":{\"additionalProperties\":true}}",
        };
        for (String b : bad) {
            List<String> why = new ArrayList<>();
            assertTrue(run("[" + b + "]", OK, why).isEmpty(), b);
            assertEquals(1, why.size(), b);
        }
    }

    @Test
    void limitsAndDuplicates() throws Exception {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < 10; i++) {
            if (i > 0) sb.append(',');
            sb.append("{\"name\":\"t").append(i).append("\",\"description\":\"d\",\"effect\":\"read\"}");
        }
        sb.append(']');
        List<String> why = new ArrayList<>();
        assertEquals(AiToolSpec.MAX_TOOLS_PER_PLUGIN, run(sb.toString(), OK, why).size());
        assertEquals(1, why.size());
        why.clear();
        var dup = run("[{\"name\":\"a\",\"description\":\"d\",\"effect\":\"read\"},{\"name\":\"a\",\"description\":\"e\",\"effect\":\"read\"}]", OK, why);
        assertEquals(1, dup.size());
        assertEquals(1, why.size());
    }

    @Test
    void descriptorJsonRoundTripExposesAiToolsOnlyWhenAllowed() throws Exception {
        PluginDescriptor d = M.readValue("""
                {"id":"p","name":"P","version":"1","permissions":["ai-tools"],
                 "aiTools":[{"name":"a","description":"d","effect":"read"}],"somethingNew":1}""", PluginDescriptor.class);
        assertEquals(1, AiToolSpec.sanitize(d.aiTools(), d.permissions(), s -> {}).size());
        String json = M.writeValueAsString(new PluginManifest("p", "P", "1", null, null, d.permissions(), null,
                AiToolSpec.sanitize(d.aiTools(), d.permissions(), s -> {})));
        assertTrue(json.contains("\"aiTools\""));
        assertTrue(!M.writeValueAsString(new PluginManifest("p", "P", "1", null, null, List.of(), null)).contains("aiTools"));
    }
}

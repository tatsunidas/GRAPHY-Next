/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

/** plugin.json の category は本体が知っている値だけを配り、未知の値・未指定は null（平置き）になる。 */
class PluginCategoryTest {

    @TempDir
    Path tmp;

    private void plugin(String id, String categoryJson) throws IOException {
        Path dir = tmp.resolve("plugins").resolve(id);
        Files.createDirectories(dir);
        String cat = categoryJson == null ? "" : ", \"category\": " + categoryJson;
        Files.writeString(dir.resolve("plugin.json"),
                "{\"id\":\"" + id + "\",\"name\":\"" + id + "\",\"version\":\"0.1.0\","
                        + "\"contributes\":[\"viewer2d.menu.analysis\"],\"ui\":\"ui.js\"" + cat + "}");
    }

    private Map<String, PluginManifest> manifests() {
        PluginProperties props = new PluginProperties();
        props.setDir(tmp.resolve("plugins").toString());
        return new StandalonePluginRegistry(new ObjectMapper(), props).manifests().stream()
                .collect(Collectors.toMap(PluginManifest::id, Function.identity()));
    }

    @Test
    void knownCategoryIsPassedThroughAndOthersBecomeNull() throws IOException {
        plugin("ai-one", "\"ai\"");
        plugin("odd", "\"games\"");
        plugin("plain", null);

        Map<String, PluginManifest> m = manifests();
        assertEquals(3, m.size());
        assertEquals("ai", m.get("ai-one").category());
        assertNull(m.get("odd").category());
        assertNull(m.get("plain").category());
    }

    @Test
    void nullCategoryIsOmittedFromJson() throws IOException {
        plugin("plain", null);
        String json = new ObjectMapper().writeValueAsString(manifests().get("plain"));
        assertFalse(json.contains("category"), json);
    }
}

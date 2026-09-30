/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** H58: プラグインのデータ置き場はプラグインのフォルダの外にあり、引数で本体が渡す。 */
class PluginDataDirTest {

    @TempDir
    Path tmp;

    private StandalonePluginRegistry registry() {
        PluginProperties props = new PluginProperties();
        props.setDir(tmp.resolve("plugins").toString());
        return new StandalonePluginRegistry(new ObjectMapper(), props);
    }

    @Test
    void dataDirIsOutsideThePluginFolder() {
        Path dir = registry().dataDirFor("uvs");
        assertEquals(tmp.resolve("plugin-data").resolve("uvs").toAbsolutePath().normalize(), dir);
        assertTrue(!dir.startsWith(tmp.resolve("plugins").toAbsolutePath().normalize()));
    }

    @Test
    void argsCarryTheDataDirAndTheScreenCannotOverrideIt() {
        StandalonePluginRegistry r = registry();
        Map<String, Object> args = r.withDataDir("uvs", Map.of("op", "x", StandalonePluginRegistry.DATA_DIR_KEY, "C:/elsewhere"));
        assertEquals("x", args.get("op"));
        assertEquals(r.dataDirFor("uvs").toString(), args.get(StandalonePluginRegistry.DATA_DIR_KEY));
        assertTrue(Files.isDirectory(r.dataDirFor("uvs")));
    }

    @Test
    void rejectsIdsThatEscape() {
        assertThrows(IllegalArgumentException.class, () -> registry().dataDirFor("../x"));
    }
}

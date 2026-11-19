/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import io.github.tatsunidas.radiomics.main.RadiomicsJ;
import io.github.tatsunidas.radiomics.main.SettingParams;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 詳細設定の入力検査に使う、RadiomicsJ の設定キーの一覧と既定値。 */
class RadiomicsSettingsSchemaTest {

    @Test
    void listsEveryKeyRadiomicsJKnowsWithItsTypeAndDefault() throws Exception {
        List<RadiomicsSettingsSchema.Entry> e = RadiomicsSettingsSchema.entries();
        assertEquals(SettingParams.values().length, e.size(), "知っているキーを全部返す");
        Map<String, RadiomicsSettingsSchema.Entry> byKey = e.stream().collect(Collectors.toMap(RadiomicsSettingsSchema.Entry::key, x -> x));
        assertEquals("int", byKey.get("INT_deltaGLCM").type());
        assertEquals("boolean", byKey.get("BOOL_removeOutliers").type());
        assertEquals("double", byKey.get("DOUBLE_zScore").type());
        assertEquals("array", byKey.get("DOUBLEARRAY_resamplingFactorXYZ").type());
        assertEquals("string", byKey.get("STRING_weightingNorm").type());
    }

    @Test
    void defaultsAreTheRadiomicsJDefaultsNotTheCurrentState() throws Exception {
        // 設定を書き換えた直後でも、既定値は初期化後の値（IVH のビン数 1000・GLCM の距離 1）
        RadiomicsJ.IVH_binCount = 77;
        RadiomicsJ.deltaGLCM = 5;
        try {
            Map<String, String> d = RadiomicsSettingsSchema.entries().stream()
                    .filter(x -> x.defaultValue() != null).collect(Collectors.toMap(RadiomicsSettingsSchema.Entry::key, RadiomicsSettingsSchema.Entry::defaultValue));
            assertEquals("1000", d.get("INT_IVH_binCount"));
            assertEquals("1", d.get("INT_deltaGLCM"));
        } finally {
            RadiomicsJ.resetSettings();
        }
        assertEquals(1, RadiomicsJ.deltaGLCM, "呼び出しのあとも初期化されている（static を汚さない）");
    }

    @Test
    void typeFollowsThePrefix() {
        assertEquals("long", RadiomicsSettingsSchema.typeOf("LONG_GLAM_randomSeed"));
        assertEquals("array", RadiomicsSettingsSchema.typeOf("INTARRAY_box_sizes"));
        assertTrue(List.of("boolean", "int", "long", "double", "array", "string").contains(RadiomicsSettingsSchema.typeOf("X")));
    }
}

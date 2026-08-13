/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Radiomics が standalone 専用であることの明示。
 *
 * <p>可視化マップも GLAM 解析も、画素をローカル保管庫の {@code file:} URI から直接読む。
 * web モードのデータは外部 PACS にあるのでその経路に乗らない。判定を入れる前は
 * 「スライスをデコードできません（圧縮転送構文の可能性）」という、<b>原因がモードだと
 * 分からないメッセージ</b>で失敗していた。
 */
class RadiomicsModeTest {

    private static RadiomicsMode withProfiles(String... profiles) {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles(profiles);
        return new RadiomicsMode(env);
    }

    @Test
    void standaloneIsSupported() {
        RadiomicsMode mode = withProfiles("standalone");
        assertTrue(mode.isSupported());
        mode.require("テクスチャ可視化マップ"); // 例外にならないこと
    }

    @Test
    void webIsRefusedWithAReasonSomeoneCanActOn() {
        RadiomicsMode mode = withProfiles("web");
        assertFalse(mode.isSupported());
        IllegalStateException e = assertThrows(IllegalStateException.class, () -> mode.require("GLAM 解析"));
        assertTrue(e.getMessage().contains("GLAM 解析"), e.getMessage());
        assertTrue(e.getMessage().contains("standalone"), "which mode does work should be named");
        assertTrue(e.getMessage().contains("web"), "which mode failed should be named");
    }

    @Test
    void publicDemoIsRefusedToo() {
        // 公開デモは web,demo で動く。DemoModeFilter でも塞いでいるが、二重に押さえる。
        assertFalse(withProfiles("web", "demo").isSupported());
    }

    @Test
    void noProfileIsRefused() {
        // プロファイル未指定で起動した場合に「たまたま動く」ことがないように。
        assertFalse(withProfiles().isSupported());
    }

    @Test
    void theFeatureNameIsCarriedIntoTheMessage() {
        RadiomicsMode mode = withProfiles("web");
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> mode.require("テクスチャ可視化マップ"));
        assertEquals(true, e.getMessage().startsWith("テクスチャ可視化マップ"), e.getMessage());
    }
}

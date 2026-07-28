/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.util.Base64;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@code application.yml} の公式署名鍵が、実際に {@link PluginProperties} へ束縛されることを固定する。
 *
 * <p>この鍵で署名されたプラグインは確認画面なしで導入される（{@code trust=verified}）ため、
 * 設定ミスやリスト構文の崩れで<b>黙って無効化される</b>と、公式配布が `first-use` 扱いに
 * 退行して気づきにくい。書式（42 バイト・{@code Ed} 始まり）まで検証する。
 * 手順は fw/plugin-signing-runbook.md。
 */
@SpringBootTest
class OfficialTrustedKeyTest {

    /** 公式配布鍵の鍵 ID（minisign 表示と同じ逆順大文字）。 */
    private static final String OFFICIAL_KEY_ID = "98EA7C6BA2D50118";

    @Autowired
    private PluginProperties props;

    @Test
    void officialSigningKeyIsConfigured() {
        assertFalse(props.getTrustedKeys().isEmpty(), "trusted-keys が空。application.yml の登録が外れている");

        boolean found = props.getTrustedKeys().stream().anyMatch(k -> {
            byte[] blob = Base64.getDecoder().decode(k.trim());
            if (blob.length != 42 || blob[0] != 'E' || blob[1] != 'd') return false;
            StringBuilder id = new StringBuilder();
            for (int i = 9; i >= 2; i--) id.append(String.format("%02X", blob[i])); // minisign は逆順表示
            return id.toString().equals(OFFICIAL_KEY_ID);
        });
        assertTrue(found, "公式署名鍵 " + OFFICIAL_KEY_ID + " が trusted-keys に見当たらない");
    }

    @Test
    void everyTrustedKeyIsAWellFormedPublicKey() {
        for (String k : props.getTrustedKeys()) {
            byte[] blob = Base64.getDecoder().decode(k.trim());
            // 秘密鍵を誤って貼ると長さが違う。ここで落として気づけるようにする。
            assertEquals(42, blob.length, "minisign 公開鍵は 42 バイトのはず: " + k);
            assertEquals('E', blob[0]);
            assertEquals('d', blob[1]);
        }
    }
}

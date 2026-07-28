/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link Minisign}: minisign 署名（Ed25519）の検証。
 *
 * <p>固定ベクタは<b>別実装</b>で作った: 鍵生成と署名は OpenSSL 3.5
 * （{@code openssl genpkey -algorithm ed25519} / {@code openssl pkeyutl -sign -rawin}）、
 * prehash は {@code openssl dgst -blake2b512}。自作コードで作った署名を自作コードで検証する
 * 循環にならないようにしている。
 */
class MinisignTest {

    private static final String PUBLIC_KEY = """
            untrusted comment: graphy test public key
            RWQBAgMEBQYHCA+VSW4vfKC4a6a8/ZwMupFFEnX1MrDZaMnSIoQtjfGO
            """;

    /** 本体をそのまま署名（algo "Ed"）。 */
    private static final String LEGACY_SIG = """
            untrusted comment: signature from graphy test key
            RWQBAgMEBQYHCPld5Pp8JhG2YFal5iwLLxtp4svd1bxM6f5ItGLGYPTvoY3gSp4vBTv4RoFjShdTA5u872o0rqJlzMi9ALTvMgI=
            trusted comment: timestamp:1 file:plugin.zip
            65Ac6Y8/BGiN4M1MYDhwi8Y5YsofdAA2IzbDspZ6jSas/NU54pR8qoSToLKzhhlAA7I6yhemnrMAoiDc1hKzBw==
            """;

    /** BLAKE2b-512 ハッシュに署名（algo "ED"・prehashed）。 */
    private static final String PREHASHED_SIG = """
            untrusted comment: signature from graphy test key
            RUQBAgMEBQYHCPh/ANA0cqVtzmuP0nshnUlRJTqD49+fwcfKb+8atS5UehIXMFfZFLh/9HmEGq7T1RGhwwa84OLF17EVVm4ajQU=
            trusted comment: timestamp:2 file:plugin.zip
            U0oBDvcT2Q7+H0GsfHVzdkY/Naj8izH2jibhcr63Kp3y00iQTzvGIEFVizk/rmRexYsq23M+OPkD+uSUNHrGBA==
            """;

    /** 署名対象（フィクスチャ生成時と同じ決定的な内容）。 */
    private static byte[] payload() {
        return "GRAPHY-Next plugin package fixture\n".repeat(10).getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void parsesPublicKey() {
        Minisign.Key key = Minisign.parseKey(PUBLIC_KEY);
        assertEquals("0102030405060708", key.keyId());
        assertEquals(32, key.raw().length);
    }

    @Test
    void verifiesLegacySignature() {
        assertTrue(Minisign.verify(payload(), Minisign.parseSig(LEGACY_SIG), Minisign.parseKey(PUBLIC_KEY)));
        assertFalse(Minisign.parseSig(LEGACY_SIG).prehashed());
    }

    @Test
    void verifiesPrehashedSignature() {
        assertTrue(Minisign.verify(payload(), Minisign.parseSig(PREHASHED_SIG), Minisign.parseKey(PUBLIC_KEY)));
        assertTrue(Minisign.parseSig(PREHASHED_SIG).prehashed());
    }

    @Test
    void rejectsTamperedContent() {
        byte[] tampered = payload();
        tampered[0] ^= 0x01; // 1 ビット変えるだけで落ちること
        assertFalse(Minisign.verify(tampered, Minisign.parseSig(LEGACY_SIG), Minisign.parseKey(PUBLIC_KEY)));
        assertFalse(Minisign.verify(tampered, Minisign.parseSig(PREHASHED_SIG), Minisign.parseKey(PUBLIC_KEY)));
    }

    @Test
    void rejectsTamperedTrustedComment() {
        // trusted comment を差し替えると global 署名が合わなくなる（本体署名だけ見ていると見逃す）。
        String forged = LEGACY_SIG.replace("timestamp:1 file:plugin.zip", "timestamp:1 file:evil.zip");
        assertFalse(Minisign.verify(payload(), Minisign.parseSig(forged), Minisign.parseKey(PUBLIC_KEY)));
    }

    @Test
    void rejectsSignatureFromAnotherKey() {
        // 鍵 ID が違えば内容を見るまでもなく不一致。
        String otherKey = PUBLIC_KEY.replace("RWQBAgMEBQYHCA", "RWQBAgMEBQYHCQ");
        assertFalse(Minisign.verify(payload(), Minisign.parseSig(LEGACY_SIG), Minisign.parseKey(otherKey)));
    }

    @Test
    void rejectsMalformedInput() {
        assertThrows(PluginInstallException.class, () -> Minisign.parseKey("untrusted comment: only\n"));
        assertThrows(PluginInstallException.class, () -> Minisign.parseKey("not-base64!!"));
        assertThrows(PluginInstallException.class, () -> Minisign.parseSig("untrusted comment: x\nAAAA\n"));
    }
}

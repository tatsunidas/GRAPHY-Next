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
 * <p>固定ベクタは<b>すべて別実装</b>で作った。自作コードで作った署名を自作コードで検証する
 * 循環にならないようにしている。
 * <ul>
 *   <li><b>実物の minisign CLI</b>（0.12・使い捨て鍵）が出力した署名 … 実運用と同じ経路の担保</li>
 *   <li>OpenSSL 3.5（{@code genpkey -algorithm ed25519} / {@code pkeyutl -sign -rawin} /
 *       {@code dgst -blake2b512}）で組み立てた legacy・prehashed 両方の署名 … 分岐の網羅</li>
 * </ul>
 *
 * <p>鍵 ID は minisign CLI の表示に合わせてバイト逆順・大文字 hex で持つ
 * （利用者が同意画面と {@code minisign} の出力を見比べられるようにするため）。
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

    // --- 実物の minisign が出力したベクタ（minisign 0.12・使い捨て鍵） --------------
    // 0.12 は -H を付けなくても prehashed（algo "ED"）で署名する。つまり BLAKE2b が無いと
    // 実運用の署名を丸ごと弾いてしまう。この事実をテストで固定しておく。

    private static final String REAL_PUBLIC_KEY = """
            untrusted comment: minisign public key E8F18C554EEC1FE7
            RWTnH+xOVYzx6MvEjdb4M3ZWyKrXSihjAFnTHBbgwwJM4k6DYzBIfZhv
            """;

    private static final String REAL_SIG = """
            untrusted comment: signature from minisign secret key
            RUTnH+xOVYzx6DLPicHIoImmpIKirA6LEyJJcqUzpEdq/9paKlsv7KRXWcHBYwu+oQZUxeJbXhWTW9n5HJUyUrIi6VKEXw02nwA=
            trusted comment: graphy fixture
            pmmI2XnkoRWtyIV53bvXaigroLafqx9mxwoN5N7S+AjlVtPRN7TUl7PfrBRFB+8YBueLzP94r7ZLzHOKnS4pAA==
            """;

    private static byte[] realPayload() {
        return "GRAPHY-Next real-minisign fixture\n".getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void verifiesSignatureProducedByTheRealMinisignCli() {
        Minisign.Sig sig = Minisign.parseSig(REAL_SIG);
        assertTrue(sig.prehashed(), "minisign 0.12 は既定で prehashed のはず");
        assertEquals("E8F18C554EEC1FE7", sig.keyId());
        assertTrue(Minisign.verify(realPayload(), sig, Minisign.parseKey(REAL_PUBLIC_KEY)));
    }

    @Test
    void rejectsTamperedContentAgainstRealMinisignSignature() {
        byte[] tampered = realPayload();
        tampered[0] ^= 0x01;
        assertFalse(Minisign.verify(tampered, Minisign.parseSig(REAL_SIG), Minisign.parseKey(REAL_PUBLIC_KEY)));
    }

    @Test
    void parsesPublicKey() {
        Minisign.Key key = Minisign.parseKey(PUBLIC_KEY);
        assertEquals("0807060504030201", key.keyId());
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

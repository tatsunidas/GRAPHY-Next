/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.Signature;
import java.util.Base64;
import java.util.HexFormat;

/**
 * テスト用の minisign 署名生成（実行時に鍵を作って署名する）。
 *
 * <p>zip はテスト内で生成され内容が固定できないため、事前に外部ツールで署名しておけない。
 * ここでは JDK の Ed25519 で署名を作るが、<b>暗号と書式の正しさ自体は {@link MinisignTest} が
 * OpenSSL 製の固定ベクタで担保している</b>。このクラスが検証するのはサービス側の配線と方針
 * （信頼鍵・TOFU・不正署名の扱い）であって、暗号の実装ではない。
 */
final class MinisignFixture {

    private final KeyPair keyPair;
    private final byte[] keyId;

    MinisignFixture(String keyIdHex) {
        try {
            this.keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        this.keyId = HexFormat.of().parseHex(keyIdHex);
    }

    /** minisign 公開鍵ファイルの中身。 */
    String publicKey() {
        byte[] spki = keyPair.getPublic().getEncoded();
        byte[] raw = new byte[32];
        System.arraycopy(spki, spki.length - 32, raw, 0, 32); // SPKI 末尾 32 バイトが生の鍵
        byte[] blob = new byte[42];
        blob[0] = 'E';
        blob[1] = 'd';
        System.arraycopy(keyId, 0, blob, 2, 8);
        System.arraycopy(raw, 0, blob, 10, 32);
        return "untrusted comment: test key\n" + Base64.getEncoder().encodeToString(blob) + "\n";
    }

    /** {@code content} に対する {@code .minisig}（legacy モード）。 */
    String sign(byte[] content, String trustedComment) {
        byte[] sig = ed25519(content);
        byte[] blob = new byte[74];
        blob[0] = 'E';
        blob[1] = 'd';
        System.arraycopy(keyId, 0, blob, 2, 8);
        System.arraycopy(sig, 0, blob, 10, 64);

        byte[] tc = trustedComment.getBytes(StandardCharsets.UTF_8);
        byte[] globalMessage = new byte[sig.length + tc.length];
        System.arraycopy(sig, 0, globalMessage, 0, sig.length);
        System.arraycopy(tc, 0, globalMessage, sig.length, tc.length);

        return "untrusted comment: test signature\n"
                + Base64.getEncoder().encodeToString(blob) + "\n"
                + "trusted comment: " + trustedComment + "\n"
                + Base64.getEncoder().encodeToString(ed25519(globalMessage)) + "\n";
    }

    private byte[] ed25519(byte[] message) {
        try {
            Signature s = Signature.getInstance("Ed25519");
            s.initSign((PrivateKey) keyPair.getPrivate());
            s.update(message);
            return s.sign();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}

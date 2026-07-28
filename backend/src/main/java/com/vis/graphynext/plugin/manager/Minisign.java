/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;

/**
 * minisign 署名の検証（Ed25519）。鍵生成・署名は行わない（配布側の仕事）。
 *
 * <p>ユーザーは鍵を一切扱わない。信頼する公開鍵は本体設定
 * （{@code graphy.plugins.trusted-keys}）に置き、検証は導入時に自動で走る。
 *
 * <h2>フォーマット</h2>
 * 公開鍵ファイル: コメント行＋base64({@code "Ed"(2) || keyId(8) || pk(32)})。<br>
 * 署名ファイル {@code .minisig}:
 * <pre>
 * untrusted comment: ...
 * base64( algo(2) || keyId(8) || sig(64) )
 * trusted comment: ...
 * base64( globalSig(64) )
 * </pre>
 * {@code algo} は {@code "Ed"}＝本体をそのまま署名、{@code "ED"}＝本体の BLAKE2b-512 に署名
 * （prehashed）。global 署名は {@code sig || trusted comment 本文} を署名したもので、
 * これを検証しないと trusted comment を差し替えられるため必ず併せて検証する。
 *
 * <p>JDK 21 の {@code Signature.getInstance("Ed25519")} を使う（外部依存なし）。
 */
final class Minisign {

    /** Ed25519 の SubjectPublicKeyInfo（X.509）前置。生の 32 バイト公開鍵をこれで包む。 */
    private static final byte[] SPKI_PREFIX = HexFormat.of().parseHex("302a300506032b6570032100");

    private Minisign() {}

    /** minisign 公開鍵。 */
    record Key(String keyId, byte[] raw) {}

    /** minisign 署名ファイルの中身。 */
    record Sig(String keyId, boolean prehashed, byte[] signature, String trustedComment, byte[] globalSignature) {}

    /** 公開鍵行（コメント行は任意）をパースする。 */
    static Key parseKey(String text) {
        String b64 = lastNonCommentLine(text);
        byte[] blob = decode(b64, "public key");
        if (blob.length != 42) throw new PluginInstallException("invalid minisign public key length: " + blob.length);
        String algo = new String(blob, 0, 2, StandardCharsets.US_ASCII);
        if (!algo.equals("Ed")) throw new PluginInstallException("unsupported minisign key algorithm: " + algo);
        return new Key(HexFormat.of().formatHex(Arrays.copyOfRange(blob, 2, 10)),
                Arrays.copyOfRange(blob, 10, 42));
    }

    /** {@code .minisig} をパースする。 */
    static Sig parseSig(String text) {
        String[] lines = text.replace("\r\n", "\n").split("\n");
        String sigB64 = null;
        String trustedComment = null;
        String globalB64 = null;
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            if (line.isEmpty()) continue;
            if (line.startsWith("untrusted comment:")) continue;
            if (line.startsWith("trusted comment:")) {
                trustedComment = line.substring("trusted comment:".length()).trim();
                continue;
            }
            if (sigB64 == null) sigB64 = line;
            else if (globalB64 == null) globalB64 = line;
        }
        if (sigB64 == null) throw new PluginInstallException("invalid .minisig: signature line not found");
        byte[] blob = decode(sigB64, "signature");
        if (blob.length != 74) throw new PluginInstallException("invalid .minisig signature length: " + blob.length);
        String algo = new String(blob, 0, 2, StandardCharsets.US_ASCII);
        boolean prehashed;
        if (algo.equals("ED")) prehashed = true;
        else if (algo.equals("Ed")) prehashed = false;
        else throw new PluginInstallException("unsupported minisign signature algorithm: " + algo);

        byte[] global = globalB64 == null ? null : decode(globalB64, "global signature");
        if (global != null && global.length != 64) {
            throw new PluginInstallException("invalid .minisig global signature length: " + global.length);
        }
        return new Sig(HexFormat.of().formatHex(Arrays.copyOfRange(blob, 2, 10)), prehashed,
                Arrays.copyOfRange(blob, 10, 74), trustedComment == null ? "" : trustedComment, global);
    }

    /**
     * 署名を検証する。鍵 ID の一致・本体署名・global 署名（trusted comment）をすべて満たすときだけ true。
     *
     * @param content 署名対象（プラグイン zip のバイト列）
     */
    static boolean verify(byte[] content, Sig sig, Key key) {
        if (!sig.keyId().equalsIgnoreCase(key.keyId())) return false;
        byte[] message = sig.prehashed() ? Blake2b.digest512(content) : content;
        if (!ed25519Verify(key.raw(), message, sig.signature())) return false;
        if (sig.globalSignature() == null) return false; // trusted comment 未署名は不正として扱う
        byte[] tc = sig.trustedComment().getBytes(StandardCharsets.UTF_8);
        byte[] globalMessage = new byte[sig.signature().length + tc.length];
        System.arraycopy(sig.signature(), 0, globalMessage, 0, sig.signature().length);
        System.arraycopy(tc, 0, globalMessage, sig.signature().length, tc.length);
        return ed25519Verify(key.raw(), globalMessage, sig.globalSignature());
    }

    private static boolean ed25519Verify(byte[] rawPublicKey, byte[] message, byte[] signature) {
        try {
            byte[] spki = new byte[SPKI_PREFIX.length + rawPublicKey.length];
            System.arraycopy(SPKI_PREFIX, 0, spki, 0, SPKI_PREFIX.length);
            System.arraycopy(rawPublicKey, 0, spki, SPKI_PREFIX.length, rawPublicKey.length);
            PublicKey pk = KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(spki));
            java.security.Signature v = java.security.Signature.getInstance("Ed25519");
            v.initVerify(pk);
            v.update(message);
            return v.verify(signature);
        } catch (GeneralSecurityException e) {
            return false; // 壊れた鍵・壊れた署名は「検証できなかった」＝不正扱い
        }
    }

    private static String lastNonCommentLine(String text) {
        String[] lines = text.replace("\r\n", "\n").split("\n");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].trim();
            if (!line.isEmpty() && !line.startsWith("untrusted comment:") && !line.startsWith("trusted comment:")) {
                return line;
            }
        }
        throw new PluginInstallException("invalid minisign public key: no base64 line");
    }

    private static byte[] decode(String b64, String what) {
        try {
            return Base64.getDecoder().decode(b64.trim());
        } catch (IllegalArgumentException e) {
            throw new PluginInstallException("invalid base64 in minisign " + what);
        }
    }
}

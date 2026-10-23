/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.time.Instant;

/**
 * 受信時の匿名化で「いつ届いても同じ仮名になる」ための、インストールごとの秘密鍵。
 *
 * <p>32 バイトの乱数を 1 度だけ作ってファイルに置き、以後はそれを読む。鍵つきハッシュ（HMAC-SHA256）で
 * UID・患者 ID・日付の種を導くので、対応表を持たずに済む。鍵が無ければ同じ元の値でも別の仮名になる。
 *
 * <p>🔴 <b>鍵ファイルが壊れていたら作り直さず止める。</b>黙って作り直すと、以前の仮名と食い違う新しい
 * 仮名で受信が続き、同じ検査が 2 つに分かれる。
 */
public final class PseudonymKey {

    static final int KEY_BYTES = 32;

    private final byte[] key;
    private final boolean created;
    private final Instant createdAt;

    private PseudonymKey(byte[] key, boolean created, Instant createdAt) {
        this.key = key;
        this.created = created;
        this.createdAt = createdAt;
    }

    /** 鍵ファイルを読む。無ければ新しく作る（{@link #wasCreated()} で見分けられる）。 */
    public static PseudonymKey loadOrCreate(Path file) throws IOException {
        if (Files.exists(file)) {
            byte[] bytes = Files.readAllBytes(file);
            if (bytes.length != KEY_BYTES) {
                throw new IllegalStateException(
                        "仮名の鍵ファイルが壊れています（" + bytes.length + " バイト）。作り直すと以前と別の仮名になるため止めます: " + file);
            }
            return new PseudonymKey(bytes, false, creationTimeOf(file));
        }
        byte[] bytes = new byte[KEY_BYTES];
        new SecureRandom().nextBytes(bytes);
        Path parent = file.toAbsolutePath().getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        Path tmp = Files.createTempFile(parent, "pseudonym-key", ".tmp");
        try {
            Files.write(tmp, bytes);
            ownerOnly(tmp);
            try {
                Files.move(tmp, file, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tmp, file);
            }
        } finally {
            Files.deleteIfExists(tmp);
        }
        return new PseudonymKey(bytes, true, creationTimeOf(file));
    }

    /** 持ち主だけが読み書きできるようにする。POSIX でない FS（Windows）はユーザーのフォルダの ACL に任せる。 */
    private static void ownerOnly(Path file) {
        try {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException | IOException ignore) {
            // POSIX 以外では設定できない
        }
    }

    private static Instant creationTimeOf(Path file) throws IOException {
        var attrs = Files.readAttributes(file, java.nio.file.attribute.BasicFileAttributes.class);
        return attrs.creationTime().toInstant();
    }

    /** この呼び出しで新しく作ったか（鍵が消えた・別の PC へ移した場合の警告に使う）。 */
    public boolean wasCreated() {
        return created;
    }

    public Instant createdAt() {
        return createdAt;
    }

    /**
     * 用途（domain）を分けた HMAC-SHA256。同じ値でも用途が違えば無関係な出力になる
     * （UID から患者 ID を逆算できないように）。
     */
    byte[] hmac(String domain, String value) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            mac.update(domain.getBytes(StandardCharsets.UTF_8));
            mac.update((byte) 0);
            return mac.doFinal((value == null ? "" : value).getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 は JRE に必ずある", e);
        }
    }

    /** 鍵の書き出し（バックアップ用）。呼び出し側が扱いに注意すること。 */
    public byte[] exportBytes() {
        return key.clone();
    }
}

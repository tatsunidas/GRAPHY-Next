/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import com.vis.graphynext.config.AuthProperties;
import org.springframework.stereotype.Service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Optional;

/**
 * ログインセッションCookieの発行・検証。
 *
 * <p>JWTライブラリは使わず、JDK標準の HMAC-SHA256 だけで完結させる（このバックエンドは
 * 既存依存を最小限に保つ方針。ペイロードは {@code email|expiresEpochSeconds} をBase64url化した
 * ものに、その HMAC 署名（16進）を {@code .} で連結するだけの単純な形式）。
 */
@Service
public class SessionTokenService {

    private static final String HMAC_ALGORITHM = "HmacSHA256";
    private final byte[] secretKey;
    private final AuthProperties properties;

    public SessionTokenService(AuthProperties properties) {
        this.properties = properties;
        this.secretKey = properties.getSessionSecret().getBytes(StandardCharsets.UTF_8);
    }

    public String issue(String email) {
        long expiresAt = Instant.now().plusSeconds(properties.getSessionTtlDays() * 86_400L).getEpochSecond();
        String payload = email + "|" + expiresAt;
        String encodedPayload = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(payload.getBytes(StandardCharsets.UTF_8));
        return encodedPayload + "." + sign(encodedPayload);
    }

    /**
     * Cookie値を検証し、有効ならメールアドレスを返す。無効・改ざん・期限切れなら空を返す。
     */
    public Optional<String> verify(String cookieValue) {
        if (cookieValue == null) {
            return Optional.empty();
        }
        int dot = cookieValue.lastIndexOf('.');
        if (dot < 0) {
            return Optional.empty();
        }
        String encodedPayload = cookieValue.substring(0, dot);
        String signature = cookieValue.substring(dot + 1);

        String expectedSignature = sign(encodedPayload);
        if (!MessageDigest.isEqual(
                signature.getBytes(StandardCharsets.US_ASCII),
                expectedSignature.getBytes(StandardCharsets.US_ASCII))) {
            return Optional.empty();
        }

        String payload;
        try {
            payload = new String(Base64.getUrlDecoder().decode(encodedPayload), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
        int sep = payload.lastIndexOf('|');
        if (sep < 0) {
            return Optional.empty();
        }
        String email = payload.substring(0, sep);
        long expiresAt;
        try {
            expiresAt = Long.parseLong(payload.substring(sep + 1));
        } catch (NumberFormatException e) {
            return Optional.empty();
        }
        if (Instant.now().getEpochSecond() >= expiresAt) {
            return Optional.empty();
        }
        return Optional.of(email);
    }

    public int sessionMaxAgeSeconds() {
        return properties.getSessionTtlDays() * 86_400;
    }

    private String sign(String data) {
        try {
            Mac mac = Mac.getInstance(HMAC_ALGORITHM);
            mac.init(new SecretKeySpec(secretKey, HMAC_ALGORITHM));
            byte[] raw = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(raw);
        } catch (NoSuchAlgorithmException | java.security.InvalidKeyException e) {
            throw new IllegalStateException(e);
        }
    }

    /** マジックリンクの生トークン（32バイト・Base64url）を新規生成する。 */
    public static String newRawToken() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /** 生トークンをDB保存用にSHA-256ハッシュ（16進）へ変換する。 */
    public static String hashToken(String rawToken) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(rawToken.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.share;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * 共有リンクの発行・引換・取り消しと、閲覧セッション（Cookie）の署名・検証。
 *
 * <p>流れ: 管理 API が {@link #issue} で生トークンを 1 回だけ返す → 受け手が {@code GET /s/{token}} で
 * {@link #redeem} → 署名つき Cookie に切り替える。以降の要求は Cookie だけで、URL にトークンは出ない。
 * Cookie は <b>要求のたびに DB で取り消し・期限を確かめる</b>ので、取り消しが即時に効く。
 */
@Service
@ConditionalOnProperty(prefix = "graphy.share", name = "enabled", havingValue = "true")
public class ShareService {

    /** 発行時の検査 UID の形（DICOM UID の文字だけ。URL・ログへ入り込む余地を残さない）。 */
    private static final Pattern UID = Pattern.compile("[0-9.]{1,64}");
    /** 生トークン（32 バイトの base64url、パディングなし）の形。 */
    private static final Pattern RAW_TOKEN = Pattern.compile("[A-Za-z0-9_-]{43}");
    private static final String HMAC = "HmacSHA256";
    /** 期限切れの行を残す日数（これを過ぎたら発行のついでに消す）。 */
    private static final Duration PURGE_AFTER = Duration.ofDays(7);

    private final ShareGrantRepository repo;
    private final ShareProperties props;
    private final Clock clock;
    private final byte[] secret;
    private final SecureRandom random = new SecureRandom();

    @Autowired
    public ShareService(ShareGrantRepository repo, ShareProperties props) {
        this(repo, props, Clock.systemUTC());
    }

    ShareService(ShareGrantRepository repo, ShareProperties props, Clock clock) {
        props.validate();
        this.repo = repo;
        this.props = props;
        this.clock = clock;
        this.secret = props.getSessionSecret().getBytes(StandardCharsets.UTF_8);
    }

    /** 発行の結果。{@code rawToken} はこの 1 回しか得られない。 */
    public record Issued(ShareGrant grant, String rawToken) {
    }

    @Transactional
    public Issued issue(Set<String> studyUids, Integer ttlDays) {
        if (studyUids == null || studyUids.isEmpty()) {
            throw new IllegalArgumentException("共有する検査がありません");
        }
        for (String uid : studyUids) {
            if (uid == null || !UID.matcher(uid).matches()) {
                throw new IllegalArgumentException("検査 UID の形式が不正です");
            }
        }
        int days = ttlDays == null ? props.getDefaultTtlDays() : ttlDays;
        if (days < 1) {
            throw new IllegalArgumentException("有効日数は 1 以上が必要です");
        }
        days = Math.min(days, props.getMaxTtlDays());

        Instant now = clock.instant();
        purge(now);
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String raw = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        ShareGrant grant = new ShareGrant(UUID.randomUUID().toString(), hash(raw),
                new LinkedHashSet<>(studyUids), now, now.plus(Duration.ofDays(days)));
        repo.save(grant);
        return new Issued(grant, raw);
    }

    /** 生トークンを引き換える。不在・期限切れ・取り消し・形式違いはすべて空（理由は区別しない）。 */
    @Transactional(readOnly = true)
    public Optional<ShareGrant> redeem(String rawToken) {
        if (rawToken == null || !RAW_TOKEN.matcher(rawToken).matches()) {
            return Optional.empty();
        }
        return repo.findByTokenHash(hash(rawToken)).filter(g -> g.isActiveAt(clock.instant()));
    }

    @Transactional
    public boolean revoke(String id) {
        return repo.findById(id).map(g -> {
            if (g.getRevokedAt() == null) {
                g.setRevokedAt(clock.instant());
                repo.save(g);
            }
            return true;
        }).orElse(false);
    }

    @Transactional(readOnly = true)
    public List<ShareGrant> list() {
        return repo.findAll();
    }

    /** 閲覧セッション Cookie の値。有効期限は、リンクの残り期限と最長時間の短いほう。 */
    public String sessionCookie(ShareGrant grant) {
        Instant now = clock.instant();
        Instant exp = now.plus(Duration.ofHours(props.getSessionMaxHours()));
        if (grant.getExpiresAt().isBefore(exp)) {
            exp = grant.getExpiresAt();
        }
        String payload = Base64.getUrlEncoder().withoutPadding()
                .encodeToString((grant.getId() + "|" + exp.getEpochSecond()).getBytes(StandardCharsets.UTF_8));
        return payload + "." + sign(payload);
    }

    public int sessionMaxAgeSeconds(ShareGrant grant) {
        long toGrantEnd = Duration.between(clock.instant(), grant.getExpiresAt()).getSeconds();
        return (int) Math.max(0, Math.min(props.getSessionMaxHours() * 3600L, toGrantEnd));
    }

    /** Cookie の署名・期限を見て、DB で取り消し・期限を再確認する。無効はすべて空。 */
    @Transactional(readOnly = true)
    public Optional<ShareGrant> verifySession(String cookieValue) {
        if (cookieValue == null) {
            return Optional.empty();
        }
        int dot = cookieValue.lastIndexOf('.');
        if (dot < 0) {
            return Optional.empty();
        }
        String payload = cookieValue.substring(0, dot);
        if (!MessageDigest.isEqual(cookieValue.substring(dot + 1).getBytes(StandardCharsets.US_ASCII),
                sign(payload).getBytes(StandardCharsets.US_ASCII))) {
            return Optional.empty();
        }
        String decoded;
        try {
            decoded = new String(Base64.getUrlDecoder().decode(payload), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
        int sep = decoded.lastIndexOf('|');
        if (sep < 0) {
            return Optional.empty();
        }
        long exp;
        try {
            exp = Long.parseLong(decoded.substring(sep + 1));
        } catch (NumberFormatException e) {
            return Optional.empty();
        }
        Instant now = clock.instant();
        if (now.getEpochSecond() >= exp) {
            return Optional.empty();
        }
        return repo.findById(decoded.substring(0, sep)).filter(g -> g.isActiveAt(now));
    }

    /** 期限切れから一定日数を過ぎた行を消す。 */
    private void purge(Instant now) {
        repo.deleteAll(repo.findByExpiresAtBefore(now.minus(PURGE_AFTER)));
    }

    static String hash(String raw) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private String sign(String data) {
        try {
            Mac mac = Mac.getInstance(HMAC);
            mac.init(new SecretKeySpec(secret, HMAC));
            return HexFormat.of().formatHex(mac.doFinal(data.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException | java.security.InvalidKeyException e) {
            throw new IllegalStateException(e);
        }
    }
}

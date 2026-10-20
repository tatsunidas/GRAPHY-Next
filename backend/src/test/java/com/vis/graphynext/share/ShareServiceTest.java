/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.share;

import jakarta.persistence.EntityManager;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DataJpaTest
class ShareServiceTest {

    private static final String S = "1.2.3.4";

    @Autowired
    ShareGrantRepository repo;
    @Autowired
    JdbcTemplate jdbc;
    @Autowired
    EntityManager em;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-10-20T00:00:00Z"));
    private ShareService service;

    @BeforeEach
    void setUp() {
        ShareProperties p = new ShareProperties();
        p.setEnabled(true);
        p.setAdminKey("a".repeat(32));
        p.setSessionSecret("s".repeat(32));
        service = new ShareService(repo, p, clock);
    }

    @Test
    void issuedTokenRedeemsAndOnlyTheHashIsStored() {
        var issued = service.issue(Set.of(S), null);
        assertThat(issued.rawToken()).matches("[A-Za-z0-9_-]{43}");
        assertThat(service.redeem(issued.rawToken())).isPresent();
        em.flush();
        // 先に行が実在することを確かめてから、生トークンが無いことを見る
        assertThat(jdbc.queryForObject("select count(*) from share_grant", Integer.class)).isEqualTo(1);
        String stored = jdbc.queryForObject("select token_hash from share_grant", String.class);
        assertThat(stored).hasSize(64).isNotEqualTo(issued.rawToken());
        assertThat(jdbc.queryForList("select * from share_grant").toString()).doesNotContain(issued.rawToken());
    }

    @Test
    void invalidTokensAreRefused() {
        var issued = service.issue(Set.of(S), null);
        String raw = issued.rawToken();
        String oneOff = (raw.charAt(0) == 'A' ? "B" : "A") + raw.substring(1);
        assertThat(service.redeem(oneOff)).isEmpty();
        assertThat(service.redeem(raw.substring(1))).isEmpty();
        assertThat(service.redeem("")).isEmpty();
        assertThat(service.redeem(null)).isEmpty();
        assertThat(service.redeem("../etc/passwd")).isEmpty();
    }

    @Test
    void expiredAndRevokedTokensAreRefused() {
        var a = service.issue(Set.of(S), 1);
        var b = service.issue(Set.of(S), 7);
        assertThat(service.redeem(a.rawToken())).isPresent();
        clock.advance(Duration.ofDays(1).plusSeconds(1));
        assertThat(service.redeem(a.rawToken())).as("期限切れ").isEmpty();
        assertThat(service.redeem(b.rawToken())).isPresent();
        assertThat(service.revoke(b.grant().getId())).isTrue();
        assertThat(service.redeem(b.rawToken())).as("取り消し").isEmpty();
        assertThat(service.revoke("no-such-id")).isFalse();
    }

    @Test
    void ttlIsClampedAndInputsValidated() {
        var issued = service.issue(Set.of(S), 9999);
        assertThat(Duration.between(clock.instant(), issued.grant().getExpiresAt())).isEqualTo(Duration.ofDays(30));
        assertThat(Duration.between(clock.instant(), service.issue(Set.of(S), null).grant().getExpiresAt()))
                .isEqualTo(Duration.ofDays(7));
        assertThatThrownBy(() -> service.issue(Set.of(), null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.issue(null, null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.issue(Set.of(S), 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.issue(Set.of("1.2/../x"), null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void sessionCookieIsVerifiedOnEveryUseAgainstTheLedger() {
        var issued = service.issue(Set.of(S), 7);
        String cookie = service.sessionCookie(issued.grant());
        assertThat(service.verifySession(cookie)).isPresent();
        // 改ざん
        assertThat(service.verifySession(cookie + "0")).isEmpty();
        assertThat(service.verifySession("x" + cookie)).isEmpty();
        assertThat(service.verifySession("")).isEmpty();
        assertThat(service.verifySession(null)).isEmpty();
        assertThat(service.verifySession("abc.def")).isEmpty();
        // 取り消しが即時に効く
        service.revoke(issued.grant().getId());
        assertThat(service.verifySession(cookie)).isEmpty();
    }

    @Test
    void sessionExpiresAtTheShorterOfLinkAndMaxHours() {
        var issued = service.issue(Set.of(S), 7);
        String cookie = service.sessionCookie(issued.grant());
        clock.advance(Duration.ofHours(11));
        assertThat(service.verifySession(cookie)).isPresent();
        clock.advance(Duration.ofHours(2));
        assertThat(service.verifySession(cookie)).as("12 時間を過ぎた").isEmpty();
        assertThat(service.sessionMaxAgeSeconds(issued.grant())).isEqualTo(12 * 3600);
    }

    @Test
    void cookieSignedWithAnotherSecretIsRefused() {
        ShareProperties other = new ShareProperties();
        other.setEnabled(true);
        other.setAdminKey("a".repeat(32));
        other.setSessionSecret("z".repeat(32));
        var issued = service.issue(Set.of(S), 7);
        String foreign = new ShareService(repo, other, clock).sessionCookie(issued.grant());
        assertThat(service.verifySession(foreign)).isEmpty();
    }

    @Test
    void oldExpiredRowsArePurgedOnIssue() {
        var old = service.issue(Set.of(S), 1);
        clock.advance(Duration.ofDays(9));
        service.issue(Set.of(S), 1);
        em.flush();
        List<String> ids = jdbc.queryForList("select id from share_grant", String.class);
        assertThat(ids).doesNotContain(old.grant().getId()).hasSize(1);
    }

    @Test
    void startupRefusesMissingOrShortSecrets() {
        ShareProperties p = new ShareProperties();
        p.setEnabled(true);
        assertThatThrownBy(() -> new ShareService(repo, p, clock)).isInstanceOf(IllegalStateException.class);
        p.setAdminKey("a".repeat(32));
        assertThatThrownBy(() -> new ShareService(repo, p, clock)).isInstanceOf(IllegalStateException.class);
        p.setSessionSecret("short");
        assertThatThrownBy(() -> new ShareService(repo, p, clock)).isInstanceOf(IllegalStateException.class);
        p.setSessionSecret("s".repeat(32));
        new ShareService(repo, p, clock); // 通る（正例）
    }

    static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant now) {
            this.now = now;
        }

        void advance(Duration d) {
            now = now.plus(d);
        }

        @Override
        public java.time.ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}

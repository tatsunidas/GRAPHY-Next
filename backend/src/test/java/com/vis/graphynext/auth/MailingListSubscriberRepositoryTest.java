/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import com.vis.graphynext.config.AuthProperties;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.EnumSet;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * お知らせメール登録者の永続化（アプリ本体のH2とは別DB・素のJDBC）の検証。
 *
 * <p>ここが壊れると「配信停止したはずの相手に送ってしまう」「登録が失われる」「興味のない製品の
 * 通知が届く」という、気づきにくく実害の大きい事故に直結するため、往復を明示的に押さえておく。
 */
class MailingListSubscriberRepositoryTest {

    private SubscriberDatabase database;
    private MailingListSubscriberRepository repository;

    @BeforeEach
    void setUp() {
        AuthProperties properties = new AuthProperties();
        // テスト毎に独立したインメモリDB（接続が残る間だけ生存）。
        properties.setSubscriberDbUrl(
                "jdbc:h2:mem:subscribers-" + System.nanoTime() + ";DB_CLOSE_DELAY=-1");
        database = new SubscriberDatabase(properties);
        repository = new MailingListSubscriberRepository(database);
    }

    @AfterEach
    void tearDown() {
        database.close();
    }

    @Test
    void save_thenFindByEmail_roundTripsTimestampAndProducts() {
        Instant subscribedAt = Instant.parse("2026-07-27T10:00:00.123456Z");
        repository.save(new MailingListSubscriber("a@example.com", subscribedAt, null,
                EnumSet.of(SubscriptionProduct.GRAPHY_NEXT)));

        MailingListSubscriber found = repository.findByEmail("a@example.com").orElseThrow();
        assertEquals("a@example.com", found.getEmail());
        // マイクロ秒まで保持されること（TIMESTAMP(6) WITH TIME ZONE）。
        assertEquals(subscribedAt, found.getSubscribedAt());
        assertNull(found.getUnsubscribedAt());
        assertFalse(found.isUnsubscribed());
        assertEquals(EnumSet.of(SubscriptionProduct.GRAPHY_NEXT), found.getProducts());
    }

    @Test
    void findByEmail_returnsEmptyForUnknownAddress() {
        assertEquals(Optional.empty(), repository.findByEmail("nobody@example.com"));
    }

    @Test
    void unsubscribe_isPersisted() {
        MailingListSubscriber subscriber =
                new MailingListSubscriber("b@example.com", SubscriptionProduct.all());
        repository.save(subscriber);

        subscriber.unsubscribe();
        repository.save(subscriber);

        MailingListSubscriber found = repository.findByEmail("b@example.com").orElseThrow();
        assertTrue(found.isUnsubscribed(), "配信停止が保存されていること");
        assertNotNull(found.getUnsubscribedAt());
    }

    /**
     * 配信停止 → 再オプトインで {@code unsubscribedAt} を NULL に戻す経路。
     * NULL のバインドは JDBC ドライバによっては素通りしないため、明示的に検証する
     * （ここが失敗すると「解除したまま」扱いになり、再登録した人に届かなくなる）。
     */
    @Test
    void resubscribe_clearsUnsubscribedAt() {
        MailingListSubscriber subscriber =
                new MailingListSubscriber("c@example.com", SubscriptionProduct.all());
        subscriber.unsubscribe();
        repository.save(subscriber);
        assertTrue(repository.findByEmail("c@example.com").orElseThrow().isUnsubscribed());

        subscriber.resubscribe();
        repository.save(subscriber);

        MailingListSubscriber found = repository.findByEmail("c@example.com").orElseThrow();
        assertNull(found.getUnsubscribedAt(), "再オプトインで配信停止が解除されること");
        assertFalse(found.isUnsubscribed());
    }

    @Test
    void save_isUpsertKeyedByEmail() {
        Instant first = Instant.now().truncatedTo(ChronoUnit.MICROS);
        Instant second = first.plusSeconds(3600);

        repository.save(new MailingListSubscriber("d@example.com", first, null,
                SubscriptionProduct.all()));
        repository.save(new MailingListSubscriber("d@example.com", second, null,
                SubscriptionProduct.all()));

        // 主キー重複で落ちず、後勝ちで1件に収まること。
        MailingListSubscriber found = repository.findByEmail("d@example.com").orElseThrow();
        assertEquals(second, found.getSubscribedAt());
    }

    /**
     * "graphy" は "graphy-next" の部分文字列。素朴な部分一致で絞ると、GRAPHY だけを購読している
     * つもりの人に GRAPHY-Next の通知が混ざる（逆も同様）。区切り込みで一致させていることの確認。
     */
    @Test
    void findActiveByProduct_doesNotMatchOnSubstring() {
        repository.save(new MailingListSubscriber("next-only@example.com",
                EnumSet.of(SubscriptionProduct.GRAPHY_NEXT)));
        repository.save(new MailingListSubscriber("classic-only@example.com",
                EnumSet.of(SubscriptionProduct.GRAPHY)));
        repository.save(new MailingListSubscriber("both@example.com", SubscriptionProduct.all()));

        assertEquals(Set.of("classic-only@example.com", "both@example.com"),
                emailsOf(SubscriptionProduct.GRAPHY),
                "GRAPHY の配信に graphy-next だけの登録者が混ざらないこと");
        assertEquals(Set.of("next-only@example.com", "both@example.com"),
                emailsOf(SubscriptionProduct.GRAPHY_NEXT));
    }

    @Test
    void findActiveByProduct_excludesUnsubscribed() {
        MailingListSubscriber stopped =
                new MailingListSubscriber("stopped@example.com", SubscriptionProduct.all());
        stopped.unsubscribe();
        repository.save(stopped);
        repository.save(new MailingListSubscriber("active@example.com", SubscriptionProduct.all()));

        assertEquals(Set.of("active@example.com"), emailsOf(SubscriptionProduct.GRAPHY_NEXT));
        assertEquals(Set.of("active@example.com"), emailsOf(SubscriptionProduct.GRAPHY));
    }

    /** 別ページから登録し直したときに、先に登録していた製品の通知が消えないこと。 */
    @Test
    void addProducts_unionsInsteadOfReplacing() {
        repository.save(new MailingListSubscriber("e@example.com",
                EnumSet.of(SubscriptionProduct.GRAPHY_NEXT)));

        MailingListSubscriber existing = repository.findByEmail("e@example.com").orElseThrow();
        existing.addProducts(EnumSet.of(SubscriptionProduct.GRAPHY));
        repository.save(existing);

        assertEquals(SubscriptionProduct.all(),
                repository.findByEmail("e@example.com").orElseThrow().getProducts());
    }

    private Set<String> emailsOf(SubscriptionProduct product) {
        return repository.findActiveByProduct(product).stream()
                .map(MailingListSubscriber::getEmail)
                .collect(Collectors.toSet());
    }
}

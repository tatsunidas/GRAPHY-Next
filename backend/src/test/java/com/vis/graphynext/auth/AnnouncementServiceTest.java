/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import com.vis.graphynext.config.AuthProperties;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.EnumSet;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 更新通知の配信。cron（auto-deploy.sh）起点で何度でも呼ばれうる前提のため、
 * 「二度送らない」「送るべきでない相手に送らない」を中心に検証する。
 */
class AnnouncementServiceTest {

    private SubscriberDatabase database;
    private MailingListSubscriberRepository subscribers;
    private AnnouncementDeliveryRepository deliveries;
    private MailerClient mailer;
    private AnnouncementService service;

    @BeforeEach
    void setUp() {
        AuthProperties properties = new AuthProperties();
        properties.setSubscriberDbUrl(
                "jdbc:h2:mem:announce-" + System.nanoTime() + ";DB_CLOSE_DELAY=-1");
        properties.setPublicBaseUrl("https://demo.example.com");
        properties.setSiteBaseUrl("https://site.example.com");
        // テストを待たせないため間隔なし。実環境では既定の30通/分を使う。
        properties.setAnnounceRatePerMinute(0);

        database = new SubscriberDatabase(properties);
        subscribers = new MailingListSubscriberRepository(database);
        deliveries = new AnnouncementDeliveryRepository(database);
        mailer = mock(MailerClient.class);
        when(mailer.send(anyString(), anyString(), anyString(), any()))
                .thenReturn(new MailerClient.SendResult(true));

        service = new AnnouncementService(properties, mailer, subscribers, deliveries);
    }

    @AfterEach
    void tearDown() {
        database.close();
    }

    @Test
    void claim_succeedsOnceThenReportsAlreadySent() {
        assertEquals(AnnouncementService.Acceptance.ACCEPTED,
                service.claim(SubscriptionProduct.GRAPHY_NEXT, "0.1.8"));
        assertEquals(AnnouncementService.Acceptance.ALREADY_SENT,
                service.claim(SubscriptionProduct.GRAPHY_NEXT, "0.1.8"),
                "同じリリースの通知は二度受け付けないこと");
        // 別バージョン・別製品は独立していること。
        assertEquals(AnnouncementService.Acceptance.ACCEPTED,
                service.claim(SubscriptionProduct.GRAPHY_NEXT, "0.1.9"));
        assertEquals(AnnouncementService.Acceptance.ACCEPTED,
                service.claim(SubscriptionProduct.GRAPHY, "0.0.21"));
    }

    @Test
    void deliver_sendsOnlyToSubscribersOfThatProduct() {
        subscribers.save(new MailingListSubscriber("next@example.com",
                EnumSet.of(SubscriptionProduct.GRAPHY_NEXT)));
        subscribers.save(new MailingListSubscriber("classic@example.com",
                EnumSet.of(SubscriptionProduct.GRAPHY)));
        subscribers.save(new MailingListSubscriber("both@example.com", SubscriptionProduct.all()));

        service.claim(SubscriptionProduct.GRAPHY_NEXT, "0.1.8");
        service.deliver(SubscriptionProduct.GRAPHY_NEXT, "0.1.8", "https://example.com/releases/v0.1.8");

        assertEquals(List.of("both@example.com", "next@example.com"), sentRecipients());
        verify(mailer, never()).send(eq("classic@example.com"), anyString(), anyString(), any());
    }

    @Test
    void deliver_skipsUnsubscribed() {
        MailingListSubscriber stopped =
                new MailingListSubscriber("stopped@example.com", SubscriptionProduct.all());
        stopped.unsubscribe();
        subscribers.save(stopped);
        subscribers.save(new MailingListSubscriber("active@example.com", SubscriptionProduct.all()));

        service.claim(SubscriptionProduct.GRAPHY, "0.0.21");
        service.deliver(SubscriptionProduct.GRAPHY, "0.0.21", null);

        assertEquals(List.of("active@example.com"), sentRecipients());
    }

    /** 本文とヘッダの配信停止URLが、その宛先本人のものになっていること。 */
    @Test
    void deliver_includesPerRecipientUnsubscribeLink() {
        subscribers.save(new MailingListSubscriber("a+tag@example.com", SubscriptionProduct.all()));

        service.claim(SubscriptionProduct.GRAPHY_NEXT, "0.1.8");
        service.deliver(SubscriptionProduct.GRAPHY_NEXT, "0.1.8", null);

        ArgumentCaptor<String> body = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> listUnsubscribe = ArgumentCaptor.forClass(String.class);
        verify(mailer).send(eq("a+tag@example.com"), anyString(), body.capture(),
                listUnsubscribe.capture());

        String expected = "https://demo.example.com/unsubscribe?email=a%2Btag%40example.com";
        assertEquals(expected, listUnsubscribe.getValue());
        assertTrue(body.getValue().contains(expected), "本文にも配信停止リンクがあること");
        assertTrue(body.getValue().contains("https://site.example.com/next/download"),
                "ダウンロード導線が製品に対応していること");
    }

    /**
     * 宛先0件で「送信済み」として記録してしまうと、登録者が増えた後に送り直せなくなる。
     * 確保を取り消して、次回の呼び出しが通るようにしていることの確認。
     */
    @Test
    void deliver_withNoRecipients_releasesTheClaimSoItCanBeRetried() {
        assertEquals(AnnouncementService.Acceptance.ACCEPTED,
                service.claim(SubscriptionProduct.GRAPHY, "0.0.21"));
        service.deliver(SubscriptionProduct.GRAPHY, "0.0.21", null);

        assertTrue(deliveries.find(SubscriptionProduct.GRAPHY, "0.0.21").isEmpty());
        assertEquals(AnnouncementService.Acceptance.ACCEPTED,
                service.claim(SubscriptionProduct.GRAPHY, "0.0.21"));
    }

    /** 1件の失敗で残り全員への配信が止まらないこと。 */
    @Test
    void deliver_continuesAfterAFailedSendAndRecordsTheCount() {
        subscribers.save(new MailingListSubscriber("ok1@example.com", SubscriptionProduct.all()));
        subscribers.save(new MailingListSubscriber("bad@example.com", SubscriptionProduct.all()));
        subscribers.save(new MailingListSubscriber("ok2@example.com", SubscriptionProduct.all()));
        when(mailer.send(eq("bad@example.com"), anyString(), anyString(), any()))
                .thenReturn(new MailerClient.SendResult(false));

        service.claim(SubscriptionProduct.GRAPHY_NEXT, "0.1.8");
        service.deliver(SubscriptionProduct.GRAPHY_NEXT, "0.1.8", null);

        assertEquals(3, sentRecipients().size(), "失敗した宛先の後も送信を続けること");

        AnnouncementDelivery record =
                deliveries.find(SubscriptionProduct.GRAPHY_NEXT, "0.1.8").orElseThrow();
        assertEquals(3, record.recipientCount());
        assertEquals(1, record.failedCount());
        assertFalse(record.finishedAt() == null, "完了時刻が記録されること");
    }

    private List<String> sentRecipients() {
        ArgumentCaptor<String> to = ArgumentCaptor.forClass(String.class);
        verify(mailer, org.mockito.Mockito.atLeast(0))
                .send(to.capture(), anyString(), anyString(), any());
        return to.getAllValues().stream().sorted().collect(Collectors.toList());
    }
}

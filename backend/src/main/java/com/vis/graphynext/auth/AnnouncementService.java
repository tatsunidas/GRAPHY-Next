/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import com.vis.graphynext.config.AuthProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * 新バージョン公開時に、その製品を購読している登録者へお知らせメールを送る。
 *
 * <p>呼び出し元は {@link AnnouncementController}（{@code POST /admin/announce}）で、さらにその先は
 * 製品サイトの {@code auto-deploy.sh}（GitHub Releases の変化を検知して叩く）。cron 起点である以上、
 * 同じリリースについて何度も呼ばれうるため、<b>送信前に</b>
 * {@link AnnouncementDeliveryRepository#claim} で排他してから送る。
 *
 * <p>送信は mailer サイドカー経由の1通ずつ。SMTP の送信上限に配慮して
 * {@code graphy.auth.announce-rate-per-minute} で間隔を空ける。件数が増えると時間がかかるため、
 * HTTP リクエストの中では走らせない（{@link AnnouncementController} が別スレッドで起動する）。
 */
@Service
@ConditionalOnProperty(prefix = "graphy.auth", name = "enabled", havingValue = "true")
public class AnnouncementService {

    private static final Logger log = LoggerFactory.getLogger(AnnouncementService.class);

    private final AuthProperties properties;
    private final MailerClient mailerClient;
    private final MailingListSubscriberRepository subscriberRepository;
    private final AnnouncementDeliveryRepository deliveryRepository;

    public AnnouncementService(AuthProperties properties, MailerClient mailerClient,
            MailingListSubscriberRepository subscriberRepository,
            AnnouncementDeliveryRepository deliveryRepository) {
        this.properties = properties;
        this.mailerClient = mailerClient;
        this.subscriberRepository = subscriberRepository;
        this.deliveryRepository = deliveryRepository;
    }

    /** 配信の受付結果。 */
    public enum Acceptance {
        /** 受け付けた（別スレッドで配信を開始する）。 */
        ACCEPTED,
        /** この製品・バージョンの配信は既に行われている（何もしない）。 */
        ALREADY_SENT
    }

    /**
     * 配信権を確保する。実際の送信は {@link #deliver} を別スレッドで呼ぶこと。
     * 確保と送信を分けているのは、二重送信の排他だけは同期的に済ませたいため
     * （呼び出し元に ALREADY_SENT を即答できる）。
     */
    public Acceptance claim(SubscriptionProduct product, String version) {
        return deliveryRepository.claim(product, version) ? Acceptance.ACCEPTED : Acceptance.ALREADY_SENT;
    }

    /**
     * 実際に送る。{@link #claim} が {@link Acceptance#ACCEPTED} を返した後にのみ呼ぶ。
     *
     * @param releaseUrl リリースノートのURL（GitHub Releases）。null なら本文から省く
     */
    public void deliver(SubscriptionProduct product, String version, String releaseUrl) {
        List<MailingListSubscriber> recipients = subscriberRepository.findActiveByProduct(product);
        if (recipients.isEmpty()) {
            // 宛先0件で履歴を残すと「送信済み」と区別できず、登録者が増えてからの再送ができない。
            deliveryRepository.release(product, version);
            log.info("更新通知: {} {} は宛先0件のため送信しませんでした", product.token(), version);
            return;
        }

        long intervalMillis = intervalMillis();
        String subject = subject(product, version);
        int failed = 0;

        log.info("更新通知: {} {} を {} 件へ送信開始（{} 通/分）",
                product.token(), version, recipients.size(), properties.getAnnounceRatePerMinute());

        for (int i = 0; i < recipients.size(); i++) {
            MailingListSubscriber recipient = recipients.get(i);
            String unsubscribeUrl = unsubscribeUrl(recipient.getEmail());
            String body = body(product, version, releaseUrl, unsubscribeUrl);

            if (!mailerClient.send(recipient.getEmail(), subject, body, unsubscribeUrl).success()) {
                failed++;
                // 個別の失敗で全体を止めない。1件のアドレス不備で残り全員に届かない方が損失が大きい。
                log.warn("更新通知: 送信に失敗しました（{} 件目/{} 件）", i + 1, recipients.size());
            }

            if (intervalMillis > 0 && i < recipients.size() - 1) {
                try {
                    Thread.sleep(intervalMillis);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    log.warn("更新通知: 中断されました（{} / {} 件送信済み）", i + 1, recipients.size());
                    break;
                }
            }
        }

        deliveryRepository.complete(product, version, recipients.size(), failed);
        log.info("更新通知: {} {} の送信完了（{} 件中 {} 件失敗）",
                product.token(), version, recipients.size(), failed);
    }

    private long intervalMillis() {
        int perMinute = properties.getAnnounceRatePerMinute();
        return perMinute <= 0 ? 0 : 60_000L / perMinute;
    }

    private String unsubscribeUrl(String email) {
        return properties.getPublicBaseUrl() + "/unsubscribe?email="
                + URLEncoder.encode(email, StandardCharsets.UTF_8);
    }

    private static String subject(SubscriptionProduct product, String version) {
        return "[" + displayName(product) + "] v" + version + " を公開しました";
    }

    private String body(SubscriptionProduct product, String version, String releaseUrl,
            String unsubscribeUrl) {
        StringBuilder sb = new StringBuilder();
        sb.append(displayName(product)).append(" の新しいバージョン v").append(version)
                .append(" を公開しました。\n\n");
        sb.append("ダウンロード:\n").append(downloadUrl(product)).append("\n\n");
        if (releaseUrl != null && !releaseUrl.isBlank()) {
            sb.append("変更点:\n").append(releaseUrl).append("\n\n");
        }
        sb.append("――――――\n");
        sb.append("このメールは、更新のお知らせを希望されたアドレスにお送りしています。\n");
        sb.append("配信停止:\n").append(unsubscribeUrl).append("\n");
        return sb.toString();
    }

    private String downloadUrl(SubscriptionProduct product) {
        String base = properties.getSiteBaseUrl();
        return switch (product) {
            case GRAPHY -> base + "/classic/download";
            case GRAPHY_NEXT -> base + "/next/download";
        };
    }

    private static String displayName(SubscriptionProduct product) {
        return switch (product) {
            case GRAPHY -> "GRAPHY";
            case GRAPHY_NEXT -> "GRAPHY-Next";
        };
    }
}

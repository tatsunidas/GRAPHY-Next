/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import com.vis.graphynext.config.AuthProperties;
import jakarta.annotation.PreDestroy;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * 新バージョン公開時の更新通知を起動するエンドポイント。
 *
 * <p>呼び出し元は製品サイトの {@code auto-deploy.sh}（別リポジトリ vis-ionary-web）。
 * GitHub Releases の最新タグの変化を検知し、<b>サイトの再ビルド・再デプロイに成功した後で</b>
 * ここを叩く。順序が逆だと「新版のお知らせが届いたのにダウンロードページは旧版のまま」に
 * なるため、トリガーをサイト側に置いている。
 *
 * <p>ブラウザから叩かれる想定はないためCORSは設定せず、共有鍵（{@code Authorization: Bearer}）
 * のみで保護する。鍵は {@code /subscribe} 用とは別（登録者全員へ送れる権限のため）。
 */
@RestController
@ConditionalOnProperty(prefix = "graphy.auth", name = "enabled", havingValue = "true")
public class AnnouncementController {

    private static final Logger log = LoggerFactory.getLogger(AnnouncementController.class);

    /** バージョン文字列。メール件名とDBに入るため、想定外の文字は受け取らない。 */
    private static final Pattern VERSION_PATTERN = Pattern.compile("^[0-9A-Za-z.\\-+]{1,64}$");

    private final AuthProperties properties;
    private final AnnouncementService announcementService;

    /**
     * 配信は分単位で時間がかかるためリクエストスレッドでは走らせない。
     * 単一スレッドにしてあるのは、GRAPHY と GRAPHY-Next を同時にリリースした場合でも
     * 配信が並行せず、SMTP の送信レートが設定値の2倍にならないようにするため。
     */
    private final ExecutorService deliveryExecutor =
            Executors.newSingleThreadExecutor(runnable -> {
                Thread thread = new Thread(runnable, "announcement-delivery");
                thread.setDaemon(true);
                return thread;
            });

    public AnnouncementController(AuthProperties properties, AnnouncementService announcementService) {
        this.properties = properties;
        this.announcementService = announcementService;
    }

    @PreDestroy
    void shutdown() {
        deliveryExecutor.shutdown();
    }

    @PostMapping("/admin/announce")
    public ResponseEntity<Map<String, String>> announce(
            @RequestParam String product,
            @RequestParam String version,
            @RequestParam(required = false) String releaseUrl,
            HttpServletRequest request) {

        if (!isAuthorized(request)) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }

        Optional<SubscriptionProduct> target = SubscriptionProduct.fromToken(product);
        if (target.isEmpty()) {
            // ここは parse() の「分からなければ全製品」とは逆に、厳密に弾く。
            // 打ち間違いで全登録者へ送ってしまう方が、送れずに気づく方より遥かに危険。
            return ResponseEntity.unprocessableEntity()
                    .body(Map.of("error", "unknown product: " + product));
        }
        String normalizedVersion = version.startsWith("v") ? version.substring(1) : version;
        if (!VERSION_PATTERN.matcher(normalizedVersion).matches()) {
            return ResponseEntity.unprocessableEntity()
                    .body(Map.of("error", "invalid version"));
        }
        if (releaseUrl != null && !releaseUrl.isBlank() && !releaseUrl.startsWith("https://")) {
            return ResponseEntity.unprocessableEntity()
                    .body(Map.of("error", "releaseUrl must be https"));
        }

        SubscriptionProduct subscriptionProduct = target.get();
        AnnouncementService.Acceptance acceptance =
                announcementService.claim(subscriptionProduct, normalizedVersion);
        if (acceptance == AnnouncementService.Acceptance.ALREADY_SENT) {
            log.info("更新通知: {} {} は配信済みのため何もしません", product, normalizedVersion);
            return ResponseEntity.ok(Map.of("status", "already_sent"));
        }

        deliveryExecutor.submit(() -> {
            try {
                announcementService.deliver(subscriptionProduct, normalizedVersion, releaseUrl);
            } catch (RuntimeException e) {
                // 配信スレッドで握り潰すと、記録が「開始したまま」で残り原因が追えなくなる。
                log.error("更新通知: {} {} の配信中に失敗しました", product, normalizedVersion, e);
            }
        });

        return ResponseEntity.accepted().body(Map.of("status", "accepted"));
    }

    private boolean isAuthorized(HttpServletRequest request) {
        String configured = properties.getAnnounceApiKey();
        if (configured == null || configured.isBlank()) {
            // 鍵が未設定の環境では、誰でも一斉配信できてしまわないよう常に拒否する。
            log.warn("更新通知: announce-api-key が未設定のため拒否しました");
            return false;
        }
        String auth = request.getHeader(HttpHeaders.AUTHORIZATION);
        return auth != null && auth.equals("Bearer " + configured);
    }
}

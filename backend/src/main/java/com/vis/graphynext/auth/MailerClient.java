/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import com.vis.graphynext.config.AuthProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * mailer サイドカー（deploy/demo/mailer）への内部API呼び出し。
 *
 * <p>graphy-backend コンテナは demo_internal（internal ネットワーク）にしか属さずインターネットに
 * 出られない設計のため、外部SMTP送信・Cloudflare Turnstile検証は、demo_edge にも属する mailer に
 * 中継させる。mailer はトークン・DICOM等の意味を一切知らない「送信/検証専用の薄い中継」に留める。
 */
@Component
public class MailerClient {

    private static final Logger log = LoggerFactory.getLogger(MailerClient.class);

    private final RestClient restClient;

    public MailerClient(AuthProperties properties) {
        this.restClient = RestClient.builder()
                .baseUrl(properties.getMailerBaseUrl())
                .defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + properties.getInternalApiKey())
                .build();
    }

    public record SendResult(boolean success) {
    }

    public record VerifyCaptchaResult(boolean success) {
    }

    public SendResult send(String to, String subject, String text) {
        try {
            restClient.post()
                    .uri("/send")
                    .body(new SendRequest(to, subject, text))
                    .retrieve()
                    .toBodilessEntity();
            return new SendResult(true);
        } catch (Exception e) {
            log.warn("mailer /send 呼び出しに失敗しました: {}", e.getMessage());
            return new SendResult(false);
        }
    }

    public VerifyCaptchaResult verifyCaptcha(String turnstileToken, String remoteIp) {
        try {
            VerifyCaptchaResult result = restClient.post()
                    .uri("/verify-captcha")
                    .body(new VerifyCaptchaRequest(turnstileToken, remoteIp))
                    .retrieve()
                    .body(VerifyCaptchaResult.class);
            return result != null ? result : new VerifyCaptchaResult(false);
        } catch (Exception e) {
            log.warn("mailer /verify-captcha 呼び出しに失敗しました: {}", e.getMessage());
            return new VerifyCaptchaResult(false);
        }
    }

    private record SendRequest(String to, String subject, String text) {
    }

    private record VerifyCaptchaRequest(String token, String remoteip) {
    }
}

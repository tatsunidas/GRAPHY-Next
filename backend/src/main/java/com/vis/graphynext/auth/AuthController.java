/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import com.vis.graphynext.config.AuthProperties;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * 公開デモ（demo.vis-ionary.com）のログインゲートと、お知らせメールの配信停止。
 *
 * <p>メールアドレス宛のマジックリンクのみでログインする（パスワードは持たない）。
 * {@code AuthFilter} が未ログイン時にここへ誘導する。graphy-backend 自身は外部と通信できないため、
 * メール送信とCAPTCHA検証は {@link MailerClient} 経由で mailer サイドカーに中継させる。
 */
@RestController
public class AuthController {

    private static final Pattern EMAIL_PATTERN = Pattern.compile("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");

    private final AuthProperties properties;
    private final MailerClient mailerClient;
    private final MagicLinkTokenRepository tokenRepository;
    private final SessionTokenService sessionTokenService;
    private final MailingListSubscriberRepository subscriberRepository;

    public AuthController(AuthProperties properties, MailerClient mailerClient,
            MagicLinkTokenRepository tokenRepository, SessionTokenService sessionTokenService,
            MailingListSubscriberRepository subscriberRepository) {
        this.properties = properties;
        this.mailerClient = mailerClient;
        this.tokenRepository = tokenRepository;
        this.sessionTokenService = sessionTokenService;
        this.subscriberRepository = subscriberRepository;
    }

    @GetMapping(value = "/login", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> loginPage(
            @RequestParam(required = false) String next,
            @RequestParam(required = false) String error) {
        return htmlResponse(renderLoginPage(sanitizeNext(next), error));
    }

    @PostMapping(value = "/auth/request-link", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> requestLink(
            @RequestParam String email,
            @RequestParam("cf-turnstile-response") String turnstileToken,
            @RequestParam(required = false) String next,
            @RequestParam(required = false) String subscribe,
            HttpServletRequest request) {
        String safeNext = sanitizeNext(next);
        boolean wantsSubscribe = "true".equals(subscribe);

        if (!EMAIL_PATTERN.matcher(email).matches()) {
            return htmlResponse(renderLoginPage(safeNext, "メールアドレスの形式が正しくありません"));
        }

        MailerClient.VerifyCaptchaResult captcha = mailerClient.verifyCaptcha(turnstileToken, clientIp(request));
        if (!captcha.success()) {
            return htmlResponse(renderLoginPage(safeNext, "ロボットではないことの確認に失敗しました。もう一度お試しください"));
        }

        String rawToken = SessionTokenService.newRawToken();
        String tokenHash = SessionTokenService.hashToken(rawToken);
        Instant expiresAt = Instant.now().plusSeconds(properties.getTokenTtlMinutes() * 60L);
        tokenRepository.save(new MagicLinkToken(tokenHash, email, expiresAt));

        // お知らせメールへのオプトイン意思は、メールアドレスの実在が確認できる /auth/verify 側で
        // 初めて登録する（この時点ではまだ本人がメールを受け取れるか確認できていない）。
        String verifyUrl = properties.getPublicBaseUrl() + "/auth/verify?token=" + rawToken
                + (safeNext.equals("/") ? "" : "&next=" + urlEncode(safeNext))
                + (wantsSubscribe ? "&subscribe=1" : "");
        String body = "以下のリンクから" + properties.getTokenTtlMinutes() + "分以内にログインしてください:\n\n"
                + verifyUrl + "\n\nこのメールに心当たりがない場合は無視してください。";
        mailerClient.send(email, "GRAPHY-Next デモへのログインリンク", body);

        return htmlResponse(renderSentPage(escapeHtml(email)));
    }

    @GetMapping("/auth/verify")
    public ResponseEntity<Void> verify(
            @RequestParam String token,
            @RequestParam(required = false) String next,
            @RequestParam(required = false) String subscribe,
            HttpServletResponse response) {
        String safeNext = sanitizeNext(next);
        String tokenHash = SessionTokenService.hashToken(token);
        Optional<MagicLinkToken> found = tokenRepository.findByTokenHash(tokenHash);

        if (found.isEmpty() || !found.get().isValid(Instant.now())) {
            return redirect("/login?error=" + urlEncode("リンクが無効か期限切れです。もう一度お試しください"));
        }

        MagicLinkToken magicLinkToken = found.get();
        magicLinkToken.markUsed();
        tokenRepository.save(magicLinkToken);

        if ("1".equals(subscribe)) {
            subscriberRepository.findById(magicLinkToken.getEmail())
                    .ifPresentOrElse(existing -> {
                        if (existing.isUnsubscribed()) {
                            existing.resubscribe();
                            subscriberRepository.save(existing);
                        }
                    }, () -> subscriberRepository.save(new MailingListSubscriber(magicLinkToken.getEmail())));
        }

        String sessionCookieValue = sessionTokenService.issue(magicLinkToken.getEmail());
        ResponseCookie cookie = ResponseCookie.from("graphy_session", sessionCookieValue)
                .httpOnly(true)
                .secure(true)
                .sameSite("Lax")
                .path("/")
                .maxAge(sessionTokenService.sessionMaxAgeSeconds())
                .build();
        response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString());

        return redirect(safeNext);
    }

    @PostMapping("/auth/logout")
    public ResponseEntity<Void> logout(HttpServletResponse response) {
        ResponseCookie cookie = ResponseCookie.from("graphy_session", "")
                .httpOnly(true)
                .secure(true)
                .sameSite("Lax")
                .path("/")
                .maxAge(0)
                .build();
        response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString());
        return redirect("/login");
    }

    /**
     * 確認画面のみを表示し、まだ状態は変更しない。メールクライアント/セキュリティソフトによる
     * リンクの事前フェッチで意図せず配信停止されてしまう事故を避けるため、実際の停止は
     * {@link #unsubscribeConfirm} 側（POST）でのみ行う。
     */
    @GetMapping(value = "/unsubscribe", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> unsubscribePage(@RequestParam(required = false) String email) {
        return htmlResponse(renderUnsubscribePage(email, null));
    }

    @PostMapping(value = "/unsubscribe", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> unsubscribeConfirm(@RequestParam String email) {
        if (!EMAIL_PATTERN.matcher(email).matches()) {
            return htmlResponse(renderUnsubscribePage(email, "メールアドレスの形式が正しくありません"));
        }

        subscriberRepository.findById(email).ifPresent(subscriber -> {
            if (!subscriber.isUnsubscribed()) {
                subscriber.unsubscribe();
                subscriberRepository.save(subscriber);
            }
        });

        // リストに存在しない/既に停止済みのメールアドレスでも、内部の登録有無を外部に漏らさないため
        // 常に同じ「完了」画面を返す（メールアドレス列挙対策）。
        return htmlResponse(renderUnsubscribedPage());
    }

    private static ResponseEntity<Void> redirect(String location) {
        return ResponseEntity.status(HttpStatus.FOUND).location(java.net.URI.create(location)).build();
    }

    private static ResponseEntity<String> htmlResponse(String html) {
        return ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(html);
    }

    /**
     * オープンリダイレクト対策: 相対パス（"/"始まり、"//"や"://"を含まない）以外は既定値 "/" にする。
     */
    private static String sanitizeNext(String next) {
        if (next == null || next.isBlank()) {
            return "/";
        }
        if (!next.startsWith("/") || next.startsWith("//") || next.contains("://") || next.contains("\\")) {
            return "/";
        }
        return next;
    }

    private static String urlEncode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static String escapeHtml(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&#39;");
    }

    private static String clientIp(HttpServletRequest request) {
        String cfIp = request.getHeader("CF-Connecting-IP");
        if (cfIp != null && !cfIp.isBlank()) {
            return cfIp;
        }
        String forwardedFor = request.getHeader("X-Forwarded-For");
        if (forwardedFor != null && !forwardedFor.isBlank()) {
            return forwardedFor.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }

    private String renderLoginPage(String next, String error) {
        String errorHtml = (error == null || error.isBlank())
                ? ""
                : "<p class=\"error\">" + escapeHtml(error) + "</p>";
        return """
                <!doctype html>
                <html lang="ja">
                <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>ログイン - GRAPHY-Next デモ</title>
                <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
                <style>
                  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 10vh auto; padding: 0 1.5rem; color: #1a1a1a; }
                  h1 { font-size: 1.25rem; }
                  input[type=email] { width: 100%%; padding: 0.6rem; font-size: 1rem; box-sizing: border-box; margin: 0.5rem 0 1rem; }
                  button { padding: 0.6rem 1.2rem; font-size: 1rem; cursor: pointer; }
                  .error { color: #b00020; }
                  .cf-turnstile { margin-bottom: 1rem; }
                  .subscribe { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.9rem; margin: 0 0 1rem; }
                  .subscribe input { margin-top: 0.2rem; }
                </style>
                </head>
                <body>
                <h1>GRAPHY-Next 実働デモへのログイン</h1>
                <p>メールアドレス宛にログイン用リンクをお送りします。</p>
                %s
                <form method="post" action="/auth/request-link">
                  <label for="email">メールアドレス</label>
                  <input type="email" id="email" name="email" required autofocus>
                  <input type="hidden" name="next" value="%s">
                  <label class="subscribe">
                    <input type="checkbox" name="subscribe" value="true">
                    <span>GRAPHY-Next のお知らせメールを受け取る（任意）</span>
                  </label>
                  <div class="cf-turnstile" data-sitekey="%s"></div>
                  <button type="submit">ログインリンクを送る</button>
                </form>
                </body>
                </html>
                """.formatted(errorHtml, escapeHtml(next), escapeHtml(properties.getTurnstileSiteKey()));
    }

    private String renderSentPage(String escapedEmail) {
        return """
                <!doctype html>
                <html lang="ja">
                <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>メールを確認してください - GRAPHY-Next デモ</title>
                <style>
                  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 10vh auto; padding: 0 1.5rem; color: #1a1a1a; }
                </style>
                </head>
                <body>
                <h1>メールを確認してください</h1>
                <p><strong>%s</strong> 宛にログインリンクを送信しました。届いたメール内のリンクをクリックしてログインを完了してください（リンクの有効期限は %d 分です）。</p>
                </body>
                </html>
                """.formatted(escapedEmail, properties.getTokenTtlMinutes());
    }

    private String renderUnsubscribePage(String email, String error) {
        String errorHtml = (error == null || error.isBlank())
                ? ""
                : "<p class=\"error\">" + escapeHtml(error) + "</p>";
        String safeEmail = email == null ? "" : escapeHtml(email);
        return """
                <!doctype html>
                <html lang="ja">
                <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>配信停止 - GRAPHY-Next デモ</title>
                <style>
                  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 10vh auto; padding: 0 1.5rem; color: #1a1a1a; }
                  h1 { font-size: 1.25rem; }
                  input[type=email] { width: 100%%; padding: 0.6rem; font-size: 1rem; box-sizing: border-box; margin: 0.5rem 0 1rem; }
                  button { padding: 0.6rem 1.2rem; font-size: 1rem; cursor: pointer; }
                  .error { color: #b00020; }
                </style>
                </head>
                <body>
                <h1>お知らせメールの配信停止</h1>
                <p>配信を停止するメールアドレスを確認してください。</p>
                %s
                <form method="post" action="/unsubscribe">
                  <label for="email">メールアドレス</label>
                  <input type="email" id="email" name="email" value="%s" required autofocus>
                  <button type="submit">配信を停止する</button>
                </form>
                </body>
                </html>
                """.formatted(errorHtml, safeEmail);
    }

    private String renderUnsubscribedPage() {
        return """
                <!doctype html>
                <html lang="ja">
                <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>配信停止しました - GRAPHY-Next デモ</title>
                <style>
                  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 10vh auto; padding: 0 1.5rem; color: #1a1a1a; }
                </style>
                </head>
                <body>
                <h1>配信停止しました</h1>
                <p>今後、このメールアドレスへお知らせメールをお送りすることはありません。</p>
                </body>
                </html>
                """;
    }
}

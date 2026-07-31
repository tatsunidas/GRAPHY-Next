/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import com.vis.graphynext.config.AuthProperties;
import com.vis.graphynext.config.CorsProperties;
import com.vis.graphynext.config.RateLimitProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.CacheControl;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.ViewControllerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.time.Duration;

/**
 * Web 層の共通設定。
 *
 * <ul>
 *   <li>CORS: 許可オリジン・メソッドは {@code graphy.cors.*}（application.yml）から読む。</li>
 *   <li>SPA フォワード: React Router 等のクライアントルーティング用に、API・静的資産以外を
 *       index.html へフォワードする（Web 本番で backend が React を配信するケース）。</li>
 * </ul>
 */
@Configuration
@EnableConfigurationProperties({CorsProperties.class, RateLimitProperties.class, AuthProperties.class})
public class WebConfig implements WebMvcConfigurer {

    private final CorsProperties cors;

    public WebConfig(CorsProperties cors) {
        this.cors = cors;
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                .allowedOriginPatterns(cors.getAllowedOriginPatterns().toArray(String[]::new))
                .allowedMethods(cors.getAllowedMethods().toArray(String[]::new));
    }

    @Override
    public void addViewControllers(ViewControllerRegistry registry) {
        // 拡張子を持たない（= ルーティングパス）かつ API でないパスを index.html へ。
        registry.addViewController("/{path:[^\\.]*}").setViewName("forward:/index.html");
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        // Vite のハッシュ付き資産（例: /assets/index-ab12cd34.js）は内容が変われば名前も変わるので、
        // 無期限・immutable で再検証すら不要にする。index.html 等は application.yml の
        // spring.web.resources...no-cache=true で毎回再検証され、デプロイが即反映される。
        registry.addResourceHandler("/assets/**")
                .addResourceLocations("classpath:/static/assets/")
                .setCacheControl(CacheControl.maxAge(Duration.ofDays(365)).cachePublic().immutable());
    }
}

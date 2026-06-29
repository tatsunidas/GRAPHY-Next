/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import com.vis.graphynext.config.CorsProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.ViewControllerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

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
@EnableConfigurationProperties(CorsProperties.class)
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
}

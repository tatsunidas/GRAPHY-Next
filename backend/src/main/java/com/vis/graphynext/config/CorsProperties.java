package com.vis.graphynext.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.List;

/**
 * {@code graphy.cors.*}（application.yml）を束縛する設定。
 *
 * <p>CORS の許可オリジン・メソッドを外部設定化し、コードからハードコードを排除する。
 */
@ConfigurationProperties(prefix = "graphy.cors")
public class CorsProperties {

    /** /api/** に対する許可オリジンパターン。 */
    private List<String> allowedOriginPatterns = List.of();

    /** 許可する HTTP メソッド。 */
    private List<String> allowedMethods = List.of("GET", "POST", "PUT", "DELETE", "OPTIONS");

    public List<String> getAllowedOriginPatterns() {
        return allowedOriginPatterns;
    }

    public void setAllowedOriginPatterns(List<String> allowedOriginPatterns) {
        this.allowedOriginPatterns = allowedOriginPatterns;
    }

    public List<String> getAllowedMethods() {
        return allowedMethods;
    }

    public void setAllowedMethods(List<String> allowedMethods) {
        this.allowedMethods = allowedMethods;
    }
}

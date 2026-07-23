package com.example.graphyplugin;

import com.vis.graphynext.plugin.spi.GraphyPlugin;
import java.util.Map;

/**
 * バックエンド面のサンプル（standalone のみ実行可・web は 501）。
 *
 * <p>UI から {@code host.runBackend(payload)}（= POST /api/plugins/{id}/run）で呼ばれ、
 * 戻り値は JSON 化されて UI に返る。GRAPHY-Next が SPI をランタイムで供給するため、
 * この実装は {@code graphy-plugin-api} に <b>provided</b> スコープで依存する（jar に同梱しない）。
 */
public class HelloBackendPlugin implements GraphyPlugin {
    @Override
    public Object run(Map<String, Object> args) {
        return Map.of(
                "ok", true,
                "echo", args == null ? Map.of() : args,
                "msg", "hello from backend plugin jar");
    }
}

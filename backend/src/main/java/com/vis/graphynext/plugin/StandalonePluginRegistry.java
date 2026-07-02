/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.plugin.spi.GraphyPlugin;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;

/**
 * standalone モードのプラグインレジストリ。
 *
 * <p>ローカルの {@code graphy.plugins.dir} を走査し、各プラグインの JAR を
 * {@link URLClassLoader} で読み込み、{@code backend.entrypoint} が指す
 * {@link GraphyPlugin} 実装を実行する（GRAPHY の {@code PluginShelf} 方式）。
 * 単一ユーザー＝自己責任のため任意 JAR ロードを許容する。
 */
@Service
@Profile("standalone")
public class StandalonePluginRegistry extends FileSystemPluginRegistry {

    private static final Logger log = LoggerFactory.getLogger(StandalonePluginRegistry.class);

    /** id 毎にクラスローダをキャッシュ（毎回ロードし直さない）。 */
    private final Map<String, URLClassLoader> loaders = new ConcurrentHashMap<>();

    public StandalonePluginRegistry(ObjectMapper mapper, PluginProperties props) {
        super(mapper, props.isEnabled(), props.getDir());
    }

    @Override
    protected String modeName() {
        return "standalone";
    }

    @Override
    public Object run(String id, Map<String, Object> payload) {
        Discovered d = discover(id).orElseThrow(() -> new NoSuchElementException("plugin not found: " + id));
        String entry = d.descriptor().entrypoint();
        if (entry == null || entry.isBlank()) {
            throw new UnsupportedOperationException("plugin has no backend: " + id);
        }
        try {
            GraphyPlugin plugin = instantiate(id, d, entry);
            return plugin.run(payload == null ? Map.of() : payload);
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException("plugin run failed: " + id, e);
        }
    }

    private GraphyPlugin instantiate(String id, Discovered d, String entrypoint) throws Exception {
        URLClassLoader cl = loaders.computeIfAbsent(id, k -> newLoader(d.dir()));
        Class<?> c = cl.loadClass(entrypoint);
        Object obj = c.getDeclaredConstructor().newInstance();
        if (!(obj instanceof GraphyPlugin plugin)) {
            throw new UnsupportedOperationException(
                    "entrypoint " + entrypoint + " does not implement GraphyPlugin");
        }
        return plugin;
    }

    /** フォルダ直下の *.jar を親=このアプリのローダにして URLClassLoader を作る。 */
    private URLClassLoader newLoader(Path dir) {
        List<URL> urls = new ArrayList<>();
        try (Stream<Path> files = Files.list(dir)) {
            for (Path p : (Iterable<Path>) files.filter(f -> f.toString().endsWith(".jar"))::iterator) {
                urls.add(p.toUri().toURL());
            }
        } catch (IOException e) {
            log.warn("[plugins] failed to enumerate jars in {}: {}", dir, e.getMessage());
        }
        return new URLClassLoader(urls.toArray(new URL[0]), getClass().getClassLoader());
    }
}

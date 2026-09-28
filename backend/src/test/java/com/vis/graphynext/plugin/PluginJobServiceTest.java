/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;
import java.util.function.BooleanSupplier;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** H45: プラグインのバックエンド面をジョブとして走らせる。 */
class PluginJobServiceTest {

    /** run の中身だけ差し替えられるレジストリ。 */
    private static PluginRegistry registry(Function<Map<String, Object>, Object> body, boolean runnable) {
        return new PluginRegistry() {
            @Override
            public List<PluginManifest> manifests() {
                return List.of();
            }

            @Override
            public Optional<byte[]> uiBundle(String id) {
                return Optional.empty();
            }

            @Override
            public void checkRunnable(String id) {
                if (!"p".equals(id)) throw new NoSuchElementException(id);
                if (!runnable) throw new UnsupportedOperationException("web mode");
            }

            @Override
            public Object run(String id, Map<String, Object> payload) {
                return body.apply(payload);
            }
        };
    }

    private static PluginJobService.Status await(PluginJobService s, String jobId) throws InterruptedException {
        for (int i = 0; i < 200; i++) {
            PluginJobService.Status st = s.status(jobId).orElseThrow();
            if (st.ended()) return st;
            Thread.sleep(20);
        }
        throw new AssertionError("job did not finish");
    }

    @Test
    @SuppressWarnings("unchecked")
    void 進み具合を通知でき結果を返す() throws Exception {
        CountDownLatch reported = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        PluginJobService s = new PluginJobService(registry(args -> {
            ((BiConsumer<Double, String>) args.get(PluginJobService.PROGRESS_KEY)).accept(0.5, "half");
            reported.countDown();
            try {
                release.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return Map.of("echo", args.get("x"));
        }, true));
        String id = s.submit("p", Map.of("x", 7)).jobId();
        assertTrue(reported.await(5, TimeUnit.SECONDS));
        PluginJobService.Status mid = s.status(id).orElseThrow();
        assertEquals(PluginJobService.State.RUNNING, mid.state());
        assertEquals(0.5, mid.progress(), 1e-9);
        assertEquals("half", mid.message());
        release.countDown();
        PluginJobService.Status done = await(s, id);
        assertEquals(PluginJobService.State.DONE, done.state());
        assertEquals(1.0, done.progress(), 1e-9);
        assertEquals(Map.of("echo", 7), done.result());
    }

    @Test
    void 取り消すとプラグインが見て止まりCANCELLEDになる() throws Exception {
        CountDownLatch started = new CountDownLatch(1);
        PluginJobService s = new PluginJobService(registry(args -> {
            BooleanSupplier cancelled = (BooleanSupplier) args.get(PluginJobService.CANCELLED_KEY);
            started.countDown();
            while (!cancelled.getAsBoolean()) Thread.onSpinWait();
            return Map.of("partial", true);
        }, true));
        String id = s.submit("p", Map.of()).jobId();
        assertTrue(started.await(5, TimeUnit.SECONDS));
        s.cancel(id);
        assertEquals(PluginJobService.State.CANCELLED, await(s, id).state());
    }

    @Test
    void 例外はFAILEDとして原因を返す() throws Exception {
        PluginJobService s = new PluginJobService(registry(args -> {
            throw new RuntimeException("wrapped", new IllegalStateException("boom"));
        }, true));
        PluginJobService.Status st = await(s, s.submit("p", null).jobId());
        assertEquals(PluginJobService.State.FAILED, st.state());
        assertEquals("boom", st.error());
    }

    @Test
    void 要求本文の同名キーは本体の関数で上書きされる() throws Exception {
        PluginJobService s = new PluginJobService(registry(
                args -> Map.of("isFn", args.get(PluginJobService.PROGRESS_KEY) instanceof BiConsumer), true));
        PluginJobService.Status st = await(s, s.submit("p", Map.of(PluginJobService.PROGRESS_KEY, "x")).jobId());
        assertEquals(Map.of("isFn", true), st.result());
    }

    @Test
    void 実行できないモードでは投入の時点で弾く() {
        PluginJobService s = new PluginJobService(registry(args -> null, false));
        assertThrows(UnsupportedOperationException.class, () -> s.submit("p", Map.of()));
        assertThrows(NoSuchElementException.class, () -> s.submit("nope", Map.of()));
        assertFalse(s.status("unknown").isPresent());
    }
}

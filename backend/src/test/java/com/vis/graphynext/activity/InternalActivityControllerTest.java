/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.activity;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import com.vis.graphynext.compute.MainChannelFilter;

import jakarta.annotation.PreDestroy;

import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class InternalActivityControllerTest {

    private static final String SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

    private static final RequestPostProcessor MAIN = req -> {
        req.setRemoteAddr("127.0.0.1");
        req.addHeader("Authorization", "Bearer " + SECRET);
        return req;
    };

    private static final class Running implements ActiveWork {
        final AtomicInteger n = new AtomicInteger(1);
        @Override public String kind() { return "export"; }
        @Override public int activeCount() { return n.get(); }
        @Override public void cancelAll() { n.set(0); }
    }

    /** 終了処理（@PreDestroy）が走ったことを数える Bean。 */
    static final AtomicInteger PRE_DESTROY = new AtomicInteger();

    @Configuration
    static class Cfg {
        @Bean Closer closer() { return new Closer(); }
    }

    static class Closer {
        @PreDestroy void close() { PRE_DESTROY.incrementAndGet(); }
    }

    private static MockMvc mvc(InternalActivityController c) {
        return MockMvcBuilders.standaloneSetup(c).addFilters(new MainChannelFilter(SECRET)).build();
    }

    @Test
    void activityListsRunningWorkAndCancelAllStopsIt() throws Exception {
        Running r = new Running();
        ActivityService svc = new ActivityService(List.of(r), new InFlightRequests());
        InternalActivityController c = new InternalActivityController(svc, new AnnotationConfigApplicationContext(), code -> {});
        MockMvc m = mvc(c);

        m.perform(get("/api/internal/activity").with(MAIN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].kind").value("export"))
                .andExpect(jsonPath("$.items[0].count").value(1))
                .andExpect(jsonPath("$.items[0].cancellable").value(true));
        m.perform(post("/api/internal/cancel-all").with(MAIN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true));
        assertEquals(0, r.activeCount());
        m.perform(get("/api/internal/activity").with(MAIN)).andExpect(jsonPath("$.items").isEmpty());
    }

    @Test
    void withoutTheMainSecretTheDoorDoesNotExist() throws Exception {
        Running r = new Running();
        ActivityService svc = new ActivityService(List.of(r), new InFlightRequests());
        CountDownLatch exited = new CountDownLatch(1);
        InternalActivityController c = new InternalActivityController(svc, new AnnotationConfigApplicationContext(), code -> exited.countDown());
        MockMvc m = mvc(c);
        // レンダラ（＝プラグイン）は secret を知らない。404 で、何も起きない
        m.perform(get("/api/internal/activity")).andExpect(status().isNotFound());
        m.perform(post("/api/internal/cancel-all")).andExpect(status().isNotFound());
        m.perform(post("/api/internal/shutdown")).andExpect(status().isNotFound());
        assertEquals(1, r.activeCount(), "中止されていない");
        assertFalse(exited.await(500, TimeUnit.MILLISECONDS), "終了していない");
    }

    @Test
    void shutdownClosesTheContextRunsPreDestroyThenExitsTheProcess() throws Exception {
        PRE_DESTROY.set(0);
        AnnotationConfigApplicationContext ctx = new AnnotationConfigApplicationContext(Cfg.class);
        CountDownLatch exited = new CountDownLatch(1);
        AtomicInteger code = new AtomicInteger(-1);
        InternalActivityController c = new InternalActivityController(
                new ActivityService(List.of(), new InFlightRequests()), ctx, rc -> {
                    code.set(rc);
                    exited.countDown();
                });
        mvc(c).perform(post("/api/internal/shutdown").with(MAIN)).andExpect(status().isAccepted());
        assertTrue(exited.await(10, TimeUnit.SECONDS), "終了処理のあとにプロセスを終える");
        assertEquals(0, code.get());
        assertFalse(ctx.isActive(), "Spring の context が閉じている");
        assertEquals(1, PRE_DESTROY.get(), "@PreDestroy が走った（Windows の kill() では走らない後始末）");
    }
}

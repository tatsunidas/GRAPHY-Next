/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.activity;

import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * アプリを終えるときの、Electron main 専用の口（{@code /api/internal/**} は MainChannelFilter が main だけに開く）。
 * <ul>
 *   <li>GET  /activity   … いま走っている処理の一覧</li>
 *   <li>POST /cancel-all … 中止できるものを全部中止</li>
 *   <li>POST /shutdown   … 穏当に停止（Spring の終了処理 → @PreDestroy → プロセス終了）</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/internal")
public class InternalActivityController {

    private static final Logger log = LoggerFactory.getLogger(InternalActivityController.class);

    private final ActivityService activity;
    private final ConfigurableApplicationContext context;
    private final ProcessExiter exiter;

    public InternalActivityController(ActivityService activity, ConfigurableApplicationContext context, ProcessExiter exiter) {
        this.activity = activity;
        this.context = context;
        this.exiter = exiter;
    }

    @GetMapping("/activity")
    public Map<String, Object> activity() {
        return Map.of("items", activity.snapshot());
    }

    @PostMapping("/cancel-all")
    public Map<String, Object> cancelAll() {
        List<String> failed = activity.cancelAll();
        return Map.of("ok", failed.isEmpty(), "failed", failed);
    }

    /** 応答を返したあとに、別スレッドで終了処理を始める（応答の途中でプロセスが消えないように）。 */
    @PostMapping("/shutdown")
    public ResponseEntity<Map<String, Object>> shutdown() {
        Thread t = new Thread(() -> {
            try {
                Thread.sleep(200);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            int code = SpringApplication.exit(context, () -> 0);
            log.info("shutdown: 終了処理が済みました（code={}）", code);
            exiter.exit(code);
        }, "graphy-shutdown");
        t.setDaemon(false);
        t.start();
        return ResponseEntity.accepted().body(Map.of("ok", true));
    }
}

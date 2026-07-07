/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.system;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * バックエンドログの払い出しエンドポイント。フロントの System＞ログ ビューアが差分ポーリングし、
 * DIMSE / DICOMweb 等のサーバ側ログを画面に取り込む。
 *
 * <p>{@code GET /api/system/logs?afterSeq=<seq>&limit=<n>}: {@code seq > afterSeq} のエントリと、
 * 応答内の最大 seq（{@code lastSeq}）を返す。フロントは次回 {@code afterSeq=lastSeq} で呼び、重複なく差分取得する。
 */
@RestController
@RequestMapping("/api/system")
public class SystemLogController {

    @GetMapping("/logs")
    public Map<String, Object> logs(@RequestParam(defaultValue = "-1") long afterSeq,
                                    @RequestParam(defaultValue = "1000") int limit) {
        int lim = Math.max(1, Math.min(limit, 3000));
        List<SystemLogStore.Entry> entries = SystemLogStore.since(afterSeq, lim);
        long lastSeq = entries.isEmpty() ? afterSeq : entries.get(entries.size() - 1).seq();
        return Map.of("entries", entries, "lastSeq", lastSeq);
    }
}

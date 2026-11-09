/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 定時の判定（枠・猶予・取りこぼし・再試行）。時計を固定して 1 回ずつ tick() を呼ぶ。 */
class PrefetchRunnerTest {

    private static final ZoneId Z = ZoneId.of("Asia/Tokyo");

    private PrefetchService service;
    private PrefetchRunRepository runs;
    private final Map<String, String> settings = new HashMap<>();

    @BeforeEach
    void setUp() {
        service = mock(PrefetchService.class);
        runs = mock(PrefetchRunRepository.class);
        settings.clear();
        settings.put(PrefetchConfig.KEY_ENABLED, "true");
        settings.put(PrefetchConfig.KEY_SOURCE, "mwl");
        settings.put(PrefetchConfig.KEY_MWL_AE, "RIS");
        settings.put(PrefetchConfig.KEY_TARGET_DAY, "tomorrow");
        settings.put(PrefetchConfig.KEY_TIMES, "07:00,18:00");
        settings.put(PrefetchConfig.KEY_PACS_AE, "PACS");
        settings.put(PrefetchConfig.KEY_RETRIEVE, "move");
        settings.put(PrefetchConfig.KEY_TIMEOUT, "600");
    }

    private PrefetchRunner runnerAt(String isoLocal) {
        when(service.config()).thenAnswer(i -> PrefetchConfig.from(settings));
        Clock c = Clock.fixed(LocalDateTime.parse(isoLocal).atZone(Z).toInstant(), Z);
        return new PrefetchRunner(service, runs, c, false);
    }

    @Test
    void 枠の時刻の直後に実行する() {
        assertTrue(runnerAt("2026-11-09T07:03:00").tick());
        verify(service).run(eq(PrefetchService.SCHEDULE), eq("2026-11-09T07:00"));
    }

    @Test
    void 最初の枠より前には実行しない() {
        assertFalse(runnerAt("2026-11-09T06:59:00").tick());
        verify(service, never()).run(anyString(), anyString());
    }

    @Test
    void 同じ枠が完了済みなら二度走らせない() {
        when(runs.existsBySlotKeyAndStatus("2026-11-09T07:00", PrefetchRun.COMPLETE)).thenReturn(true);
        assertFalse(runnerAt("2026-11-09T07:04:00").tick());
        verify(service, never()).run(anyString(), anyString());
    }

    @Test
    void 猶予を過ぎて起動したときは_取りこぼし設定がなければ実行しない() {
        assertFalse(runnerAt("2026-11-09T09:00:00").tick());
        verify(service, never()).run(anyString(), anyString());
    }

    @Test
    void 猶予を過ぎて起動したときは_取りこぼし設定があれば直近の枠を実行する() {
        settings.put(PrefetchConfig.KEY_CATCH_UP, "true");
        assertTrue(runnerAt("2026-11-09T09:00:00").tick());
        verify(service).run(eq(PrefetchService.SCHEDULE), eq("2026-11-09T07:00"));
    }

    @Test
    void 夜の枠を過ぎたら_その日の最後の枠が対象() {
        settings.put(PrefetchConfig.KEY_CATCH_UP, "true");
        assertTrue(runnerAt("2026-11-09T22:00:00").tick());
        verify(service).run(eq(PrefetchService.SCHEDULE), eq("2026-11-09T18:00"));
    }

    @Test
    void 障害で中断した枠は_15分たつまで再試行しない() {
        settings.put(PrefetchConfig.KEY_CATCH_UP, "true");
        PrefetchRun last = mock(PrefetchRun.class);
        LocalDateTime now = LocalDateTime.parse("2026-11-09T07:10:00");
        when(last.getFinishedAt()).thenReturn(now.minusMinutes(5).atZone(Z).toInstant().toEpochMilli());
        when(runs.findTopBySlotKeyOrderByIdDesc("2026-11-09T07:00")).thenReturn(last);
        assertFalse(runnerAt("2026-11-09T07:10:00").tick());

        when(last.getFinishedAt()).thenReturn(now.minusMinutes(16).atZone(Z).toInstant().toEpochMilli());
        assertTrue(runnerAt("2026-11-09T07:10:00").tick());
    }

    @Test
    void 負例_無効や不備の設定では実行しない() {
        settings.put(PrefetchConfig.KEY_ENABLED, "false");
        assertFalse(runnerAt("2026-11-09T07:03:00").tick());
        settings.put(PrefetchConfig.KEY_ENABLED, "true");
        settings.remove(PrefetchConfig.KEY_PACS_AE);
        assertFalse(runnerAt("2026-11-09T07:03:00").tick());
        verify(service, never()).run(anyString(), anyString());
    }

    @Test
    void 走行中なら実行しない() {
        when(service.isRunning()).thenReturn(true);
        assertFalse(runnerAt("2026-11-09T07:03:00").tick());
        verify(service, never()).run(anyString(), anyString());
    }
}

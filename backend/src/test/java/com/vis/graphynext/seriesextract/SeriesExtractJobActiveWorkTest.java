/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.seriesextract;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 終了前の「いま走っている処理」（ActiveWork）: シリーズ抽出ジョブ。 */
class SeriesExtractJobActiveWorkTest {

    private static void waitUntil(BooleanSupplier cond, String what) throws InterruptedException {
        for (int i = 0; i < 500 && !cond.getAsBoolean(); i++) {
            Thread.sleep(20);
        }
        assertTrue(cond.getAsBoolean(), what);
    }

    @Test
    void 実行中を数え_cancelAllで止まり_完了と空は数えない() throws Exception {
        SeriesExtractService service = mock(SeriesExtractService.class);
        CountDownLatch entered = new CountDownLatch(1);
        boolean[] block = {true};
        when(service.verify(any(), any(), any(), any())).thenAnswer(inv -> {
            SeriesExtractService.Progress p = inv.getArgument(3);
            entered.countDown();
            for (int i = 0; block[0] && i < 500; i++) {
                if (p.cancelled()) {
                    throw new SeriesExtractService.CancelledException();
                }
                Thread.sleep(20);
            }
            return mock(SeriesExtractService.VerifyResult.class);
        });
        SeriesExtractJobService svc = new SeriesExtractJobService(service);
        assertEquals("seriesExtract", svc.kind());
        assertTrue(svc.cancellable());
        assertEquals(0, svc.activeCount(), "何も無いとき");
        svc.cancelAll();

        String id = svc.submitVerify(List.of("1.2.3"), List.of(), null).jobId();
        String queued = svc.submitVerify(List.of("1.2.4"), List.of(), null).jobId(); // 1 本ずつなので QUEUED
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        assertEquals(SeriesExtractJobService.State.RUNNING, svc.get(id).state());
        assertEquals(SeriesExtractJobService.State.QUEUED, svc.get(queued).state());
        assertEquals(2, svc.activeCount());

        svc.cancelAll();

        waitUntil(() -> svc.get(id).state() == SeriesExtractJobService.State.CANCELLED
                && svc.get(queued).state() == SeriesExtractJobService.State.CANCELLED, "両方 CANCELLED になる");
        assertEquals(0, svc.activeCount());

        // 負例: 完了したジョブは数えない
        block[0] = false;
        String done = svc.submitVerify(List.of("1.2.5"), List.of(), null).jobId();
        waitUntil(() -> svc.get(done).state() == SeriesExtractJobService.State.DONE, "DONE になる");
        assertEquals(0, svc.activeCount());
    }
}

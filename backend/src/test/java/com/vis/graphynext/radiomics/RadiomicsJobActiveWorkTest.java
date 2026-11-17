/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.junit.jupiter.api.Test;

import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 終了前の「いま走っている処理」（ActiveWork）: テクスチャ・フィルタ済みシリーズ・ROI 特徴量のジョブ。 */
class RadiomicsJobActiveWorkTest {

    private static void waitUntil(BooleanSupplier cond, String what) throws InterruptedException {
        for (int i = 0; i < 500 && !cond.getAsBoolean(); i++) {
            Thread.sleep(20);
        }
        assertTrue(cond.getAsBoolean(), what);
    }

    @Test
    void texture_実行中を数え_cancelAllで止まり_完了と空は数えない() throws Exception {
        TextureSeriesService service = mock(TextureSeriesService.class);
        CountDownLatch entered = new CountDownLatch(1);
        boolean[] block = {true};
        when(service.create(any(), any())).thenAnswer(inv -> {
            TextureProgress p = inv.getArgument(1);
            entered.countDown();
            // 中止されると update が例外を投げる（実際の計算と同じ止まり方）。block=false なら即完了
            for (int i = 0; block[0] && i < 500; i++) {
                p.update(0, 10);
                Thread.sleep(20);
            }
            return mock(TextureSeriesService.Result.class);
        });
        TextureJobService svc = new TextureJobService(service);
        assertEquals("texture", svc.kind());
        assertTrue(svc.cancellable());
        assertEquals(0, svc.activeCount(), "何も無いとき");
        svc.cancelAll();

        String id = svc.submit(mock(TextureSeriesRequest.class)).jobId();
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        assertEquals(TextureJobService.State.RUNNING, svc.get(id).state());
        assertEquals(1, svc.activeCount());

        svc.cancelAll();

        waitUntil(() -> svc.get(id).state() == TextureJobService.State.CANCELLED, "CANCELLED になる");
        assertEquals(0, svc.activeCount());

        // 負例: 完了したジョブは数えない
        block[0] = false;
        String done = svc.submit(mock(TextureSeriesRequest.class)).jobId();
        waitUntil(() -> svc.get(done).state() == TextureJobService.State.DONE, "DONE になる");
        assertEquals(0, svc.activeCount());
    }

    @Test
    void filteredSeries_実行中を数え_cancelAllで止まり_完了と空は数えない() throws Exception {
        FilteredSeriesService service = mock(FilteredSeriesService.class);
        CountDownLatch entered = new CountDownLatch(1);
        boolean[] block = {true};
        when(service.create(any(), any(), any(), any())).thenAnswer(inv -> {
            BooleanSupplier cancelled = inv.getArgument(2);
            entered.countDown();
            for (int i = 0; block[0] && i < 500; i++) {
                if (cancelled.getAsBoolean()) {
                    throw new CancellationException();
                }
                Thread.sleep(20);
            }
            return mock(FilteredSeriesService.Result.class);
        });
        FilteredSeriesJobService svc = new FilteredSeriesJobService(service);
        assertEquals("filteredSeries", svc.kind());
        assertTrue(svc.cancellable());
        assertEquals(0, svc.activeCount(), "何も無いとき");
        svc.cancelAll();

        String id = svc.submit(mock(FilteredSeriesRequest.class)).jobId();
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        assertEquals(1, svc.activeCount());

        svc.cancelAll();

        // 取り消した job の state は進まない（status は cancelled から CANCELLED を返す）ので、終わりは件数で見る
        waitUntil(() -> svc.activeCount() == 0, "止まって 0 になる");
        assertEquals(FilteredSeriesJobService.State.CANCELLED, svc.get(id).state());

        // 負例: 完了したジョブは数えない
        block[0] = false;
        String done = svc.submit(mock(FilteredSeriesRequest.class)).jobId();
        waitUntil(() -> svc.get(done).state() == FilteredSeriesJobService.State.DONE, "DONE になる");
        assertEquals(0, svc.activeCount());
    }

    @Test
    void roiFeature_実行中を数え_cancelAllで止まり_完了と空は数えない() throws Exception {
        RoiFeatureService service = mock(RoiFeatureService.class);
        CountDownLatch entered = new CountDownLatch(1);
        boolean[] block = {true};
        when(service.compute(any(), any(), any(), any(), any())).thenAnswer(inv -> {
            BooleanSupplier cancelled = inv.getArgument(3);
            entered.countDown();
            for (int i = 0; block[0] && i < 500; i++) {
                if (cancelled.getAsBoolean()) {
                    throw new CancellationException();
                }
                Thread.sleep(20);
            }
            return mock(RoiFeatureResult.class);
        });
        RoiFeatureJobService svc = new RoiFeatureJobService(service);
        assertEquals("roiFeature", svc.kind());
        assertTrue(svc.cancellable());
        assertEquals(0, svc.activeCount(), "何も無いとき");
        svc.cancelAll();

        String id = svc.submit(mock(RoiFeatureRequest.class)).jobId();
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        assertEquals(1, svc.activeCount());

        svc.cancelAll();

        waitUntil(() -> svc.activeCount() == 0, "止まって 0 になる");
        assertEquals(RoiFeatureJobService.State.CANCELLED, svc.get(id).state());

        // 負例: 完了したジョブは数えない
        block[0] = false;
        String done = svc.submit(mock(RoiFeatureRequest.class)).jobId();
        waitUntil(() -> svc.get(done).state() == RoiFeatureJobService.State.DONE, "DONE になる");
        assertEquals(0, svc.activeCount());
    }
}

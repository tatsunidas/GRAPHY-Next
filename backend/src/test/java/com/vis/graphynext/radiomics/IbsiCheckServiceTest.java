/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.tatsunidas.radiomics.main.RadiomicsJ;
import io.github.tatsunidas.radiomics.main.Validation;
import io.github.tatsunidas.radiomics.main.ValidationReport;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.*;

/** IBSI 照合: RadiomicsJ の結果をそのまま返すこと、static な設定を汚さないこと、web モードで断ること。 */
class IbsiCheckServiceTest {

    @BeforeAll
    static void headless() {
        System.setProperty("java.awt.headless", "true");
    }

    private static RadiomicsMode mode(boolean standalone) {
        MockEnvironment env = new MockEnvironment();
        if (standalone) env.setActiveProfiles("standalone");
        return new RadiomicsMode(env);
    }

    private static IbsiCheckService service(java.util.function.Supplier<ValidationReport> v) {
        return new IbsiCheckService(mode(true), new ObjectMapper(), "9.9.9-test", v);
    }

    private static ValidationReport phantom() {
        return Validation.report(Validation.ValidationConfigType.P);
    }

    @Test
    void phantomResultIsRadiomicsJsReportUnchanged() throws Exception {
        IbsiCheckService.Result r = service(IbsiCheckServiceTest::phantom).run(true);
        ValidationReport direct = phantom();
        // 再計算も判定の書き換えもしない: 件数と中身が RadiomicsJ の直呼びと同じ
        assertEquals(new ObjectMapper().readTree(direct.toJson()), r.report());
        assertEquals(direct.toCsv(), r.csv());
        assertEquals(RadiomicsJ.version, r.radiomicsjVersion());
        assertEquals("9.9.9-test", r.graphyVersion());
        // RadiomicsJ 2.5.x の実測（docs/benchmark）: 168 特徴を照合して不合格 0
        assertEquals(168, r.report().get("checked").asInt());
        assertEquals(0, r.report().get("counts").get("FAIL").asInt());
        assertFalse(r.report().get("referenceSha256").asText().isBlank());
    }

    @Test
    void secondRunIsRememberedUntilRefresh() {
        IbsiCheckService s = service(IbsiCheckServiceTest::phantom);
        IbsiCheckService.Result a = s.run(false);
        assertSame(a, s.run(false));
        assertNotSame(a, s.run(true));
    }

    @Test
    void settingsAreRestoredEvenWhenTheCheckFails() {
        RadiomicsJ.resetSettings();
        int defaultBins = RadiomicsJ.nBins;
        IbsiCheckService dirty = service(() -> {
            RadiomicsJ.nBins = 99;
            throw new IllegalStateException("データが無い");
        });
        assertThrows(IllegalStateException.class, () -> dirty.run(true));
        assertEquals(defaultBins, RadiomicsJ.nBins);
        // 成功したときも、照合の設定（ビン数 6）が残らない
        service(IbsiCheckServiceTest::phantom).run(true);
        assertEquals(defaultBins, RadiomicsJ.nBins);
    }

    @Test
    void webModeIsRefusedWithTheReason() {
        IbsiCheckService web = new IbsiCheckService(mode(false), new ObjectMapper(), "x", IbsiCheckServiceTest::phantom);
        IllegalStateException e = assertThrows(IllegalStateException.class, () -> web.run(true));
        assertTrue(e.getMessage().contains("standalone モード専用"), e.getMessage());
    }

    @Test
    void waitsWhileTheSharedRadiomicsLockIsHeld() throws Exception {
        IbsiCheckService s = service(IbsiCheckServiceTest::phantom);
        CompletableFuture<Void> release = new CompletableFuture<>();
        CompletableFuture<Void> held = new CompletableFuture<>();
        Thread holder = new Thread(() -> RadiomicsLock.get(() -> {
            held.complete(null);
            release.join();
            return null;
        }));
        holder.start();
        held.get(5, TimeUnit.SECONDS);
        CompletableFuture<IbsiCheckService.Result> run = CompletableFuture.supplyAsync(() -> s.run(true));
        assertThrows(TimeoutException.class, () -> run.get(1500, TimeUnit.MILLISECONDS));
        release.complete(null);
        assertNotNull(run.get(120, TimeUnit.SECONDS));
        holder.join();
    }

    @Test
    void ctRecordsAreTheReleaseRecordsNotRunHere() {
        List<JsonNode> records = service(IbsiCheckServiceTest::phantom).records();
        assertEquals(2, records.size());
        JsonNode c = records.get(0), d = records.get(1);
        assertEquals("configuration C", c.get("dataSet").asText());
        assertEquals("configuration D", d.get("dataSet").asText());
        // 構成 C は Intensity at 10% volume の 1 件が不合格、構成 D は 0（RadiomicsJ の記録どおり）
        assertEquals(1, c.get("counts").get("FAIL").asInt());
        assertEquals(0, d.get("counts").get("FAIL").asInt());
        // 記録の版が、載せている RadiomicsJ の版と食い違ったら取り直す（docs/benchmark の IbsiBenchmarkRecorder）
        assertEquals(RadiomicsJ.version, c.get("radiomicsjVersion").asText());
        assertEquals(RadiomicsJ.version, d.get("radiomicsjVersion").asText());
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 承認の札（fw/remote-compute-design.md §4.2）。破れると、利用者が見ていないものが外へ出る。
 * データセットは本物の {@link ComputeDatasetService} を使わず、作り済みの体で登録簿に直接置く。
 */
class ComputeEgressServiceTest {

    private static final String CODE = "import numpy as np\nv = np.load('inputs/a.npz')['volume']\nprint(v.mean())\n";

    @TempDir
    Path dir;

    private ComputeEndpointRegistry endpoints;
    private ComputeDatasetService datasets;
    private ComputeAuditLog audit;
    private ComputeEgressService svc;
    private final ObjectMapper mapper = new ObjectMapper();

    @BeforeEach
    void setUp() throws Exception {
        endpoints = new ComputeEndpointRegistry();
        endpoints.replaceAll(List.of(new ComputeEndpointRegistry.Incoming("lab", "Lab GPU",
                "https://gpu.example.org/", "SECRET-TOKEN")));
        datasets = new ComputeDatasetService(null, null, mapper);
        audit = new ComputeAuditLog(dir.resolve("compute-audit.jsonl").toString(), mapper);
        svc = new ComputeEgressService(endpoints, datasets, audit);
    }

    /** 作り済みのデータセットを登録簿へ直接置く（匿名化は ComputeDatasetServiceTest で見ている）。 */
    @SuppressWarnings("unchecked")
    private String putDataset(String name) throws Exception {
        Path d = Files.createDirectories(dir.resolve(name));
        Path f = Files.writeString(d.resolve("dataset.npz"), "fake");
        String handle = "dsh_" + name;
        Field field = ComputeDatasetService.class.getDeclaredField("datasets");
        field.setAccessible(true);
        ((Map<String, ComputeDatasetService.Dataset>) field.get(datasets)).put(handle,
                new ComputeDatasetService.Dataset(handle, ComputeDatasetService.Format.NPZ, f, 4, "ab".repeat(32),
                        3, 0, "1.2.3", "1.2.3.4", "CT", Instant.now()));
        return handle;
    }

    private ComputeEgressService.EgressRequest create() throws Exception {
        return svc.create("seg-plugin", "Segmentation", "lab", List.of(putDataset("a")), CODE,
                CodeInspector.MAX_JOB_CHARS);
    }

    private List<JsonNode> auditLines() throws Exception {
        return Files.readAllLines(audit.file()).stream().map(l -> {
            try {
                return mapper.readTree(l);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }).toList();
    }

    @Test
    void approvedTicketIsConsumedExactlyOnce() throws Exception {
        ComputeEgressService.EgressRequest r = create();
        assertTrue(svc.detail(r.id()).isPresent());
        assertTrue(svc.consume(r.id()).isEmpty(), "承認前は使えない");
        assertEquals(ComputeEgressService.Status.APPROVED, svc.decide(r.id(), true, r.contentHash()).orElseThrow());
        assertTrue(svc.detail(r.id()).isEmpty(), "決定済みは同意画面に出さない");
        assertTrue(svc.decide(r.id(), true, r.contentHash()).isEmpty(), "二度は決めない");
        assertTrue(svc.consume(r.id()).isPresent());
        assertTrue(svc.consume(r.id()).isEmpty(), "🔴 1 回きり");
    }

    @Test
    void codeOnlyRequestNeedsTheSameApproval() throws Exception {
        // データを送らない要求（例: モデルの説明を取りに行く）も、同意・1 回きり・監査は同じ
        ComputeEgressService.EgressRequest r = svc.create("seg-plugin", "Segmentation", "lab", List.of(), CODE,
                CodeInspector.MAX_JOB_CHARS);
        assertTrue(r.datasets().isEmpty());
        assertTrue(svc.consume(r.id()).isEmpty(), "承認前は使えない");
        assertEquals(ComputeEgressService.Status.APPROVED, svc.decide(r.id(), true, r.contentHash()).orElseThrow());
        assertTrue(svc.consume(r.id()).isPresent());
        assertTrue(svc.consume(r.id()).isEmpty());
        assertTrue(auditLines().stream().anyMatch(l -> l.path("event").asText().equals("egress-consumed")
                && l.path("datasets").isEmpty()));
    }

    @Test
    void approvalWithADifferentHashIsRejected() throws Exception {
        ComputeEgressService.EgressRequest r = create();
        assertTrue(svc.decide(r.id(), true, "0".repeat(64)).isEmpty(), "🔴 見せた内容と違えば通さない");
        assertTrue(svc.consume(r.id()).isEmpty());
        assertTrue(svc.detail(r.id()).isPresent(), "まだ決まっていない");
    }

    @Test
    void denialDiscardsTheDatasets() throws Exception {
        ComputeEgressService.EgressRequest r = create();
        Path file = datasets.get(r.datasets().get(0).handle()).orElseThrow().file();
        assertEquals(ComputeEgressService.Status.DENIED, svc.decide(r.id(), false, null).orElseThrow());
        assertTrue(svc.consume(r.id()).isEmpty());
        assertFalse(Files.exists(file), "断ったら作ったデータは消す");
    }

    @Test
    void ticketsExpire() throws Exception {
        ComputeEgressService.EgressRequest r = create();
        svc.decide(r.id(), true, r.contentHash());
        // 期限を過ぎたことにする
        @SuppressWarnings("unchecked")
        Map<String, ComputeEgressService.EgressRequest> reqs = (Map<String, ComputeEgressService.EgressRequest>)
                field(svc, "requests");
        ComputeEgressService.EgressRequest cur = reqs.get(r.id());
        reqs.put(r.id(), new ComputeEgressService.EgressRequest(cur.id(), cur.pluginId(), cur.pluginName(),
                cur.endpointId(), cur.endpointLabel(), cur.endpointUrl(), cur.plaintext(), cur.datasets(), cur.code(),
                cur.codeSha256(), cur.anonymization(), cur.contentHash(),
                Instant.now().minus(ComputeEgressService.TTL).minusSeconds(1), cur.status()));
        assertTrue(svc.consume(r.id()).isEmpty(), "🔴 5 分を過ぎた承認では送らない");
        assertEquals(ComputeEgressService.Status.EXPIRED, svc.status(r.id()).orElseThrow());
    }

    @Test
    void unknownEndpointDatasetOrBadCodeIsRefused() throws Exception {
        String h = putDataset("b");
        assertEquals("unknown-endpoint", assertThrows(ComputeEgressService.EgressRefused.class,
                () -> svc.create("p", "P", "nope", List.of(h), CODE, 1000)).reason());
        assertEquals("unknown-dataset", assertThrows(ComputeEgressService.EgressRefused.class,
                () -> svc.create("p", "P", "lab", List.of("dsh_none"), CODE, 1000)).reason());
        String embedded = "data = '" + "QUJD".repeat(2000) + "'";
        assertEquals("code-embedded-data", assertThrows(ComputeEgressService.EgressRefused.class,
                () -> svc.create("p", "P", "lab", List.of(h), embedded, CodeInspector.MAX_JOB_CHARS)).reason());
    }

    @Test
    void auditLogHasEveryStepButNoTokenNoCodeBodyNoPaths() throws Exception {
        ComputeEgressService.EgressRequest r = create();
        svc.decide(r.id(), true, r.contentHash());
        svc.consume(r.id());
        List<JsonNode> lines = auditLines();
        assertEquals(List.of("egress-requested", "egress-approved", "egress-consumed"),
                lines.stream().map(l -> l.path("event").asText()).toList());
        JsonNode first = lines.get(0);
        assertEquals("seg-plugin", first.path("pluginId").asText());
        assertEquals("gpu.example.org", first.path("host").asText());
        assertEquals(r.codeSha256(), first.path("codeSha256").asText());
        assertEquals("ab".repeat(32), first.path("datasets").get(0).path("sha256").asText());
        String all = Files.readString(audit.file());
        assertFalse(all.contains("SECRET-TOKEN"), "🔴 トークンを残さない");
        assertFalse(all.contains(dir.toString().replace("\\", "\\\\")), "ファイルの場所を残さない");
        assertTrue(first.path("codeHead").asText().startsWith("import numpy"), "コードは先頭だけ");
    }

    @Test
    void earlyRefusalsAreAudited() throws Exception {
        assertEquals("unknown-endpoint", svc.precheck("p", "nope", CODE, 1000));
        assertEquals("code-embedded-data", svc.precheck("p", "lab", "x = '" + "QUJD".repeat(2000) + "'",
                CodeInspector.MAX_JOB_CHARS));
        assertEquals(null, svc.precheck("p", "lab", CODE, 1000));
        svc.refused("q", "lab", "permission-denied");
        List<JsonNode> lines = auditLines();
        assertEquals(List.of("egress-refused", "egress-refused", "egress-refused"),
                lines.stream().map(l -> l.path("event").asText()).toList(), "通したものは残さず、弾いたものだけ残す");
        assertEquals("permission-denied", lines.get(2).path("reason").asText());
    }

    @Test
    void contentHashCoversDestinationCodeAndData() {
        var d = new ComputeEgressService.DatasetSummary("dsh_a", "npz", 4, "aa", 3, 0, "CT");
        String base = ComputeEgressService.contentHash("p", "lab", "https://a/", List.of(d), "c1");
        assertFalse(base.equals(ComputeEgressService.contentHash("p", "lab", "https://b/", List.of(d), "c1")));
        assertFalse(base.equals(ComputeEgressService.contentHash("p", "lab", "https://a/", List.of(d), "c2")));
        assertFalse(base.equals(ComputeEgressService.contentHash("p", "lab", "https://a/",
                List.of(new ComputeEgressService.DatasetSummary("dsh_a", "npz", 4, "bb", 3, 0, "CT")), "c1")));
    }

    @Test
    void codeInspectorCountsEmbeddedRuns() {
        assertEquals(null, CodeInspector.inspect(CODE, 1000));
        assertEquals("code-empty", CodeInspector.inspect("  ", 1000));
        assertEquals("code-too-large", CodeInspector.inspect("x".repeat(1001), 1000));
        // 普通の長いコード（識別子・短い数値）は埋め込みに数えない
        String normal = "for i in range(10):\n    print(i, 3.14159)\n".repeat(400);
        assertEquals(0, CodeInspector.embeddedChars(normal));
        // 数値の長い並び（画素を配列で書いたもの）
        String numbers = "px = [" + "1023, 1024, 998, ".repeat(400) + "]";
        assertEquals("code-embedded-data", CodeInspector.inspect(numbers, CodeInspector.MAX_JOB_CHARS));
    }

    private static Object field(Object o, String name) throws Exception {
        Field f = o.getClass().getDeclaredField(name);
        f.setAccessible(true);
        return f.get(o);
    }
}

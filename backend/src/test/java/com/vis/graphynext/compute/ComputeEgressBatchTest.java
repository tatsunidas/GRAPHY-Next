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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 一括の札（fw/remote-compute-design.md §26）。1 回の同意が全組を覆い、組の分け方を変えると承認が通らないこと、
 * 対話の 1 回（組名なし）の内容のハッシュ v1 が変わっていないことを固定する。
 */
class ComputeEgressBatchTest {

    private static final String CODE = "import numpy as np\nv = np.load('inputs/0.npz')['volume']\nprint(v.mean())\n";

    @TempDir
    Path dir;

    private ComputeDatasetService datasets;
    private ComputeAuditLog audit;
    private ComputeEgressService svc;
    private final ObjectMapper mapper = new ObjectMapper();

    @BeforeEach
    void setUp() {
        ComputeEndpointRegistry endpoints = new ComputeEndpointRegistry();
        endpoints.replaceAll(List.of(new ComputeEndpointRegistry.Incoming("lab", "Lab GPU",
                "https://gpu.example.org/", "SECRET-TOKEN")));
        datasets = new ComputeDatasetService(null, null, mapper);
        audit = new ComputeAuditLog(dir.resolve("compute-audit.jsonl").toString(), mapper);
        svc = new ComputeEgressService(endpoints, datasets, audit);
    }

    @SuppressWarnings("unchecked")
    private String putDataset(String name) throws Exception {
        Path d = Files.createDirectories(dir.resolve(name));
        Path f = Files.writeString(d.resolve("dataset.npz"), "fake-" + name);
        String handle = "dsh_" + name;
        Field field = ComputeDatasetService.class.getDeclaredField("datasets");
        field.setAccessible(true);
        ((Map<String, ComputeDatasetService.Dataset>) field.get(datasets)).put(handle,
                new ComputeDatasetService.Dataset(handle, ComputeDatasetService.Format.NPZ, f, 4,
                        ComputeEgressService.sha256("sha-" + name), 3, 0, "1.2.3", "1.2.3." + name, "CT",
                        Instant.now()));
        return handle;
    }

    private LinkedHashMap<String, List<String>> items(String... keyAndDatasets) throws Exception {
        LinkedHashMap<String, List<String>> m = new LinkedHashMap<>();
        for (int i = 0; i < keyAndDatasets.length; i += 2) {
            m.put(keyAndDatasets[i], List.of(putDataset(keyAndDatasets[i + 1])));
        }
        return m;
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
    void oneApprovalCoversEveryItemAndIsUsedOnce() throws Exception {
        ComputeEgressService.EgressRequest r = svc.createBatch("seg", "Seg", "lab",
                items("a", "d1", "b", "d2", "c", "d3"), CODE, CodeInspector.MAX_JOB_CHARS);
        assertEquals(3, r.items().size());
        assertEquals(3, r.datasets().size(), "同意画面に出す平らな一覧は全組のデータ");
        assertTrue(r.contentHash().length() == 64);
        assertEquals(ComputeEgressService.Status.APPROVED, svc.decide(r.id(), true, r.contentHash()).orElseThrow());
        assertTrue(svc.consumeFor("seg", r.id()).isPresent());
        assertTrue(svc.consumeFor("seg", r.id()).isEmpty(), "🔴 一括の承認も 1 回きり（組ごとに使い回せない）");
    }

    @Test
    void anotherPluginCannotUseTheBatchApproval() throws Exception {
        ComputeEgressService.EgressRequest r = svc.createBatch("seg", "Seg", "lab", items("a", "d1"), CODE,
                CodeInspector.MAX_JOB_CHARS);
        svc.decide(r.id(), true, r.contentHash());
        assertTrue(svc.consumeFor("other", r.id()).isEmpty());
        assertTrue(svc.consumeFor("seg", r.id()).isPresent(), "持ち主はまだ使える");
    }

    @Test
    void itemBoundariesAndNamesAreInTheContentHash() throws Exception {
        String h1 = putDataset("x1");
        String h2 = putDataset("x2");
        ComputeEgressService.DatasetSummary s1 = ComputeEgressService.DatasetSummary.of(datasets.get(h1).orElseThrow());
        ComputeEgressService.DatasetSummary s2 = ComputeEgressService.DatasetSummary.of(datasets.get(h2).orElseThrow());
        String url = "https://gpu.example.org/";
        String sha = ComputeEgressService.sha256(CODE);
        String twoItems = ComputeEgressService.contentHashBatch("seg", "lab", url,
                List.of(new ComputeEgressService.Item("a", List.of(s1)), new ComputeEgressService.Item("b", List.of(s2))), sha);
        String oneItem = ComputeEgressService.contentHashBatch("seg", "lab", url,
                List.of(new ComputeEgressService.Item("a", List.of(s1, s2))), sha);
        String renamed = ComputeEgressService.contentHashBatch("seg", "lab", url,
                List.of(new ComputeEgressService.Item("a", List.of(s1)), new ComputeEgressService.Item("c", List.of(s2))), sha);
        String swapped = ComputeEgressService.contentHashBatch("seg", "lab", url,
                List.of(new ComputeEgressService.Item("b", List.of(s2)), new ComputeEgressService.Item("a", List.of(s1))), sha);
        assertNotEquals(twoItems, oneItem, "同じデータでも組の分け方が違えばハッシュが違う");
        assertNotEquals(twoItems, renamed, "組名が違えばハッシュが違う");
        assertNotEquals(twoItems, swapped, "組の順が違えばハッシュが違う");
    }

    @Test
    void singleInteractiveRequestKeepsTheV1Hash() throws Exception {
        // 対話の 1 回（runJob）の内容のハッシュは変えない。旧い式をここに固定して突き合わせる
        String h = putDataset("solo");
        ComputeEgressService.EgressRequest r = svc.create("seg", "Seg", "lab", List.of(h), CODE,
                CodeInspector.MAX_JOB_CHARS);
        ComputeEgressService.DatasetSummary d = r.datasets().get(0);
        String legacy = ComputeEgressService.sha256("v1\nseg\nlab\nhttps://gpu.example.org/\n"
                + ComputeEgressService.sha256(CODE) + "\n"
                + d.handle() + " " + d.format() + " " + d.sha256() + " " + d.bytes() + "\n");
        assertEquals(legacy, r.contentHash());
        assertEquals(1, r.itemsOrSingle().size());
        assertEquals(null, r.itemsOrSingle().get(0).key());
    }

    @Test
    void denialDiscardsEveryItemsData() throws Exception {
        ComputeEgressService.EgressRequest r = svc.createBatch("seg", "Seg", "lab", items("a", "d1", "b", "d2"), CODE,
                CodeInspector.MAX_JOB_CHARS);
        List<Path> files = r.datasets().stream().map(d -> datasets.get(d.handle()).orElseThrow().file()).toList();
        assertEquals(ComputeEgressService.Status.DENIED, svc.decide(r.id(), false, null).orElseThrow());
        files.forEach(f -> assertFalse(Files.exists(f), "断ったら全組のデータを消す"));
    }

    @Test
    void approvalWithAnotherHashIsRejected() throws Exception {
        ComputeEgressService.EgressRequest r = svc.createBatch("seg", "Seg", "lab", items("a", "d1", "b", "d2"), CODE,
                CodeInspector.MAX_JOB_CHARS);
        assertTrue(svc.decide(r.id(), true, "0".repeat(64)).isEmpty());
        assertTrue(svc.consume(r.id()).isEmpty());
    }

    @Test
    void itemKeysAreChecked() throws Exception {
        for (String bad : new String[] {"", "山田太郎", "a b", "a/b", "x".repeat(65)}) {
            LinkedHashMap<String, List<String>> m = new LinkedHashMap<>();
            m.put(bad, List.of(putDataset("k" + Math.abs(bad.hashCode()))));
            String reason = assertThrows(ComputeEgressService.EgressRefused.class,
                    () -> svc.createBatch("seg", "Seg", "lab", m, CODE, CodeInspector.MAX_JOB_CHARS)).reason();
            assertEquals("bad-item-key", reason, "組名: '" + bad + "'");
        }
        assertEquals("no-items", assertThrows(ComputeEgressService.EgressRefused.class,
                () -> svc.createBatch("seg", "Seg", "lab", new LinkedHashMap<>(), CODE, CodeInspector.MAX_JOB_CHARS)).reason());
    }

    @Test
    void auditRecordsTheBatchWithoutPatientData() throws Exception {
        svc.createBatch("seg", "Seg", "lab", items("a", "d1", "b", "d2"), CODE, CodeInspector.MAX_JOB_CHARS);
        JsonNode line = auditLines().stream().filter(l -> l.path("event").asText().equals("compute-batch-requested"))
                .findFirst().orElseThrow();
        assertEquals(2, line.path("items").asInt());
        assertEquals(2, line.path("datasets").asInt());
        assertEquals(8, line.path("totalBytes").asLong());
        assertFalse(line.toString().contains("1.2.3"), "元の UID を監査に出さない");
    }
}

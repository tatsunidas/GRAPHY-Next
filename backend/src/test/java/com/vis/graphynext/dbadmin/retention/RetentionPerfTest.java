/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.plugin.store.PluginDocument;
import com.vis.graphynext.plugin.store.PluginDocumentRepository;
import com.vis.graphynext.roi.RoiDocument;
import com.vis.graphynext.roi.RoiDocumentRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 保護の収集と試算の所要時間の実測（合成の大きな索引）。時間の上限は緩い（回帰の目安）で、測った値は出力に出す。
 * 索引の行だけを作る（ファイルは作らない。試算はファイルを読まない）。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:retentionperf;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false",
                "graphy.retention.auto-run=false"
        })
class RetentionPerfTest {

    private static final int STUDIES = 5_000;
    private static final int PER_STUDY = 10;   // 50,000 行
    private static final long DAY = 24L * 60 * 60 * 1000;

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired DicomInstanceRepository repo;
    @Autowired RoiDocumentRepository rois;
    @Autowired PluginDocumentRepository plugins;
    @Autowired RetentionService service;

    @Test
    void 五万行の索引と二千の患者文書でも試算が終わる() {
        long now = System.currentTimeMillis();
        List<DicomInstance> batch = new ArrayList<>();
        for (int s = 0; s < STUDIES; s++) {
            for (int i = 0; i < PER_STUDY; i++) {
                DicomInstance d = new DicomInstance("1.8." + s + "." + i);
                d.setPatientId("P" + (s % 2000));
                d.setStudyInstanceUid("1.8." + s);
                d.setSeriesInstanceUid("1.8." + s + ".s");
                d.setSopClassUid("1.2.840.10008.5.1.4.1.1.7");
                d.setModality("CT");
                d.setSizeBytes(500_000L);
                d.setReceivedAt(now - (long) (s % 400) * DAY);
                d.setUri("x/" + s + "/" + i);
                batch.add(d);
            }
            if (batch.size() >= 5_000) {
                repo.saveAll(batch);
                batch.clear();
            }
        }
        repo.saveAll(batch);
        for (int p = 0; p < 2000; p++) {
            StringBuilder json = new StringBuilder("{\"rois\":[");
            for (int k = 0; k < 5; k++) {
                json.append(k > 0 ? "," : "").append("{\"sopInstanceUid\":\"1.8.").append((p * 2 + k) % STUDIES).append(".0\"}");
            }
            rois.save(new RoiDocument("P" + p, json.append("],\"analyses\":[]}").toString(), 5));
            if (p % 4 == 0) {
                plugins.save(new PluginDocument("pl", "P" + p, "{}"));
            }
        }
        service.saveConfig(new RetentionConfig(30, null, null));

        long t0 = System.nanoTime();
        RetentionPlan plan = service.preview();
        long ms = (System.nanoTime() - t0) / 1_000_000;
        System.out.println("PERF retention preview: rows=" + repo.count() + " studies=" + STUDIES
                + " rois=2000 plugins=500 -> " + ms + " ms, plan=" + plan.items().size() + " items, skips=" + plan.protectedSkips());
        assertEquals(STUDIES, service.stats().size());
        assertTrue(ms < 120_000, "試算が極端に遅い: " + ms + " ms");
    }
}

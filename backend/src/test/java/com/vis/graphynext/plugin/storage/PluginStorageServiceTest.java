/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.storage;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.StorageBackend;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.dicom.store.StorageUnavailableException;
import com.vis.graphynext.gdrive.GdriveSyncService;
import com.vis.graphynext.plugin.PluginJobService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;
import org.springframework.beans.factory.ObjectProvider;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * プラグインが検査・シリーズを手元に確保する（H67）。手元に無いものだけを取り寄せ、失敗は例外でなく理由コードで返し、
 * パスは返さない。取り寄せ先（Drive）は、保存しておいた内容を書き戻す偽物。
 */
class PluginStorageServiceTest {

    @TempDir
    Path root;

    final Map<String, DicomInstance> db = new HashMap<>();
    final Map<String, byte[]> remote = new HashMap<>();
    final List<String> fetchedRels = new ArrayList<>();
    StorageLayout layout;
    PluginStorageService svc;
    volatile String failWith;
    boolean cacheMode = true;

    /** 取り寄せ先の偽物: 保存しておいた内容を書き戻す。failWith があれば失敗させる。 */
    private final StorageBackend backend = new StorageBackend() {
        @Override public boolean cacheMode() { return cacheMode; }

        @Override public Path ensureLocal(String rel) {
            byte[] b = remote.get(rel);
            if (b == null) return null;
            if (failWith != null) throw new StorageUnavailableException(failWith);
            try {
                Path p = root.resolve(rel);
                Files.createDirectories(p.getParent());
                Files.write(p, b);
                synchronized (fetchedRels) { fetchedRels.add(rel); }
                return p;
            } catch (IOException e) {
                throw new java.io.UncheckedIOException(e);
            }
        }

        @Override public void prefetch(Collection<String> rels, BooleanSupplier cancelled) { rels.forEach(this::ensureLocal); }

        @Override public void touch(String rel) { }
    };

    @SuppressWarnings("unchecked")
    private static ObjectProvider<GdriveSyncService> provider(GdriveSyncService g) {
        ObjectProvider<GdriveSyncService> p = Mockito.mock(ObjectProvider.class);
        Mockito.when(p.getIfAvailable()).thenReturn(g);
        return p;
    }

    @BeforeEach
    void setUp() throws IOException {
        layout = new StorageLayout(root);
        layout.setBackend(backend);
        PluginStorageService.Instances inst = new PluginStorageService.Instances() {
            @Override public List<DicomInstance> byStudy(String studyUid) {
                return db.values().stream().filter(i -> studyUid.equals(i.getStudyInstanceUid())).sorted(java.util.Comparator.comparing(DicomInstance::getSopInstanceUid)).toList();
            }
            @Override public List<DicomInstance> bySeries(String studyUid, String seriesUid) {
                return byStudy(studyUid).stream().filter(i -> seriesUid.equals(i.getSeriesInstanceUid())).toList();
            }
            @Override public Optional<DicomInstance> bySop(String sopUid) { return Optional.ofNullable(db.get(sopUid)); }
        };
        svc = new PluginStorageService(inst, layout, provider(null));
        // 検査 S1: シリーズ A に 3 枚（a1 は手元にある、a2・a3 は Drive にだけある）、シリーズ B に 2 枚（Drive にだけある）
        add("S1", "A", "a1", true);
        add("S1", "A", "a2", false);
        add("S1", "A", "a3", false);
        add("S1", "B", "b1", false);
        add("S1", "B", "b2", false);
    }

    private void add(String study, String series, String sop, boolean local) throws IOException {
        DicomInstance i = new DicomInstance(sop);
        i.setStudyInstanceUid(study);
        i.setSeriesInstanceUid(series);
        String rel = study + "/" + series + "/" + sop + ".dcm";
        i.setUri(rel);
        db.put(sop, i);
        byte[] bytes = ("DICOM-" + sop).getBytes();
        remote.put(rel, bytes);
        if (local) {
            Path p = root.resolve(rel);
            Files.createDirectories(p.getParent());
            Files.write(p, bytes);
        }
    }

    private PluginJobService.TaskContext ctx(List<Double> progress, BooleanSupplier cancelled) {
        return new PluginJobService.TaskContext((p, m) -> progress.add(p), cancelled);
    }

    // ── 正例 ──

    @Test
    void 検査を確保すると_手元に無いものだけ取り寄せ_内容が一致し_パスは返さない() throws Exception {
        List<Double> progress = new ArrayList<>();
        Map<String, Object> r = svc.ensure("S1", null, ctx(progress, () -> false));
        assertEquals(true, r.get("ok"));
        assertEquals(5, r.get("total"));
        assertEquals(4, r.get("fetched"));
        assertEquals(1, r.get("alreadyLocal"));
        assertEquals(List.of("S1/A/a2.dcm", "S1/A/a3.dcm", "S1/B/b1.dcm", "S1/B/b2.dcm"), fetchedRels.stream().sorted().toList());
        for (String sop : List.of("a1", "a2", "a3", "b1", "b2")) {
            assertEquals("DICOM-" + sop, Files.readString(root.resolve("S1/" + (sop.startsWith("a") ? "A" : "B") + "/" + sop + ".dcm")));
        }
        assertEquals(1.0, progress.get(progress.size() - 1), "最後は 100%");
        assertFalse(r.toString().contains(root.toString()), "結果にパスは含めない");
        assertFalse(r.containsKey("path") || r.containsKey("paths"));
    }

    @Test
    void シリーズを指定すると_そのシリーズだけ取り寄せる() {
        Map<String, Object> r = svc.ensure("S1", List.of("B"), ctx(new ArrayList<>(), () -> false));
        assertEquals(true, r.get("ok"));
        assertEquals(2, r.get("total"));
        assertEquals(2, r.get("fetched"));
        assertTrue(Files.exists(root.resolve("S1/B/b1.dcm")));
        assertFalse(Files.exists(root.resolve("S1/A/a2.dcm")), "指定しなかったシリーズは取らない");
    }

    @Test
    void すべて手元にあれば何も取らない_2回目は取り寄せ0件() {
        svc.ensure("S1", null, ctx(new ArrayList<>(), () -> false));
        fetchedRels.clear();
        Map<String, Object> r = svc.ensure("S1", null, ctx(new ArrayList<>(), () -> false));
        assertEquals(true, r.get("ok"));
        assertEquals(0, r.get("fetched"));
        assertEquals(5, r.get("alreadyLocal"));
        assertTrue(fetchedRels.isEmpty());
    }

    @Test
    void 取り寄せの対象が多くても_単位ごとに進み具合を通知する() throws Exception {
        for (int i = 0; i < 40; i++) add("S2", "A", "s2-" + i, false);
        List<Double> progress = new ArrayList<>();
        Map<String, Object> r = svc.ensure("S2", null, ctx(progress, () -> false));
        assertEquals(40, r.get("fetched"));
        assertEquals(3, progress.size(), "16 件ずつ 3 回（16+16+8）");
        for (int i = 1; i < progress.size(); i++) assertTrue(progress.get(i) > progress.get(i - 1), "増えていく");
        assertEquals(1.0, progress.get(2));
    }

    @Test
    void モードBでは取り寄せず_cacheMode_false_を返す() {
        cacheMode = false;
        Map<String, Object> r = svc.ensure("S1", null, ctx(new ArrayList<>(), () -> false));
        assertEquals(true, r.get("ok"));
        assertEquals(false, r.get("cacheMode"));
        assertEquals(0, r.get("fetched"));
        assertTrue(fetchedRels.isEmpty());
    }

    // ── 負例 ──

    @Test
    void 取り寄せに失敗したら_例外でなく_理由コードで返し_そこまでの件数を残す() {
        for (int i = 0; i < 20; i++) add2("S3", "s3-" + i);
        failWith = "offline";
        Map<String, Object> r = svc.ensure("S3", null, ctx(new ArrayList<>(), () -> false));
        assertEquals(false, r.get("ok"));
        assertEquals("offline", r.get("error"));
        assertEquals(0, r.get("fetched"), "最初の単位で失敗");
        assertTrue(fetchedRels.isEmpty());
        failWith = null;
        Map<String, Object> again = svc.ensure("S3", null, ctx(new ArrayList<>(), () -> false));
        assertEquals(true, again.get("ok"), "直ったら続きから取れる");
        assertEquals(20, again.get("fetched"));
    }

    private void add2(String study, String sop) {
        try {
            add(study, "A", sop, false);
        } catch (IOException e) {
            throw new java.io.UncheckedIOException(e);
        }
    }

    @Test
    void 存在しない検査_シリーズは_not_found() {
        assertEquals("not-found", svc.ensure("NOPE", null, ctx(new ArrayList<>(), () -> false)).get("error"));
        assertEquals("not-found", svc.ensure("S1", List.of("NO-SERIES"), ctx(new ArrayList<>(), () -> false)).get("error"));
    }

    @Test
    void 取り消されたら_次の単位へ進まない() {
        for (int i = 0; i < 40; i++) add2("S4", "s4-" + i);
        AtomicBoolean cancel = new AtomicBoolean();
        List<Double> progress = new ArrayList<>();
        PluginJobService.TaskContext c = new PluginJobService.TaskContext((p, m) -> {
            progress.add(p);
            cancel.set(true); // 最初の単位のあとで取り消す
        }, cancel::get);
        Map<String, Object> r = svc.ensure("S4", null, c);
        assertEquals(16, r.get("fetched"), "最初の 16 件だけ");
        assertEquals(1, progress.size());
        assertFalse(Files.exists(root.resolve("S4/A/s4-39.dcm")));
    }

    // ── JAR に渡す関数 ──

    @Test
    void JAR用の関数は_SOP_から手元のパスを返し_追い出し済みなら取り寄せる() throws Exception {
        String p = svc.ensureLocalFunction().apply("a2");
        assertEquals(root.resolve("S1/A/a2.dcm").toAbsolutePath().toString(), p);
        assertEquals("DICOM-a2", Files.readString(Path.of(p)));
        assertEquals(root.resolve("S1/A/a1.dcm").toAbsolutePath().toString(), svc.ensureLocalFunction().apply("a1"), "手元にあればそのまま");
    }

    @Test
    void JAR用の関数は_知らない_SOP_で_null_取れなければ_JDK_の例外() {
        assertNull(svc.ensureLocalFunction().apply("no-such-sop"));
        assertNull(svc.ensureLocalFunction().apply(null));
        failWith = "md5-mismatch";
        IllegalStateException e = assertThrows(IllegalStateException.class, () -> svc.ensureLocalFunction().apply("b1"));
        assertEquals("storage-unavailable: md5-mismatch", e.getMessage());
        assertFalse(Files.exists(root.resolve("S1/B/b1.dcm")), "壊れた内容は置かない");
    }

    // ── 状態 ──

    @Test
    void 状態は_モード_使用量_上限_Drive_にだけある件数だけ() {
        Map<String, Object> none = svc.status();
        assertEquals(false, none.get("cacheMode"));
        assertEquals(0L, ((Number) none.get("usedBytes")).longValue());
        GdriveSyncService g = Mockito.mock(GdriveSyncService.class);
        Mockito.when(g.status()).thenReturn(new GdriveSyncService.Status(GdriveSyncService.State.CONNECTED, null, 0, 0, 10, null, null,
                null, null, "cache", 6_000L, 15_000L, 6, 4, 0, 99L));
        PluginStorageService withDrive = new PluginStorageService(new PluginStorageService.Instances() {
            @Override public List<DicomInstance> byStudy(String s) { return List.of(); }
            @Override public List<DicomInstance> bySeries(String s, String t) { return List.of(); }
            @Override public Optional<DicomInstance> bySop(String s) { return Optional.empty(); }
        }, layout, provider(g));
        Map<String, Object> st = withDrive.status();
        assertEquals(true, st.get("cacheMode"));
        assertEquals(6_000L, st.get("usedBytes"));
        assertEquals(15_000L, st.get("limitBytes"));
        assertEquals(4L, st.get("remoteOnlyCount"));
        assertEquals(List.of("cacheMode", "limitBytes", "remoteOnlyCount", "usedBytes"), st.keySet().stream().sorted().toList(), "余計な項目（ID・パス）を含めない");
        Mockito.when(g.status()).thenReturn(new GdriveSyncService.Status(GdriveSyncService.State.CONNECTED, null, 0, 0, 10, null, null,
                null, null, "backup", 0, 0, 0, 0, 0, 0));
        assertEquals(false, withDrive.status().get("cacheMode"));
    }

    @Test
    void 要求の形の検査() {
        assertNull(PluginStorageController.validate(new PluginStorageController.EnsureRequest("1.2.3", null)));
        assertNull(PluginStorageController.validate(new PluginStorageController.EnsureRequest("1.2.3", List.of("4.5"))));
        for (PluginStorageController.EnsureRequest bad : List.of(
                new PluginStorageController.EnsureRequest(null, null),
                new PluginStorageController.EnsureRequest("", null),
                new PluginStorageController.EnsureRequest("  ", null),
                new PluginStorageController.EnsureRequest("1".repeat(65), null))) {
            assertEquals("invalid-study-uid", PluginStorageController.validate(bad));
        }
        assertEquals("invalid-study-uid", PluginStorageController.validate(null));
        assertEquals("invalid-series-uid", PluginStorageController.validate(new PluginStorageController.EnsureRequest("1", java.util.Arrays.asList("ok", null))));
        assertEquals("invalid-series-uid", PluginStorageController.validate(new PluginStorageController.EnsureRequest("1", List.of(""))));
        assertEquals("too-many-series", PluginStorageController.validate(new PluginStorageController.EnsureRequest("1", java.util.Collections.nCopies(1001, "x"))));
    }
}

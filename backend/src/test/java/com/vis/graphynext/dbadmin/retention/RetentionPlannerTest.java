/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 自動削除の計画（純粋関数）。時計・空き容量は引数で与える。 */
class RetentionPlannerTest {

    private static final long DAY = 24L * 60 * 60 * 1000;
    private static final long GB = RetentionConfig.GB;
    private static final long NOW = 1_800_000_000_000L;

    private static StudyStat study(String uid, long daysAgo, long bytes) {
        return new StudyStat(uid, "P-" + uid, "P-" + uid, "name-" + uid, "20260101", "CT", 10, bytes, NOW - daysAgo * DAY, 0);
    }

    private static RetentionPlan plan(List<StudyStat> s, Map<String, Set<ProtectionReason>> prot, RetentionConfig c,
                                      long free, long store) {
        return RetentionPlanner.plan(s, prot, c, free, store, NOW, NOW);
    }

    private static List<String> uids(RetentionPlan p) {
        return p.items().stream().map(RetentionPlan.Item::studyUid).toList();
    }

    @Test
    void 条件が無ければ何も選ばない_空きが0でも() {
        var s = List.of(study("a", 400, GB), study("b", 1, GB));
        var p = plan(s, Map.of(), new RetentionConfig(null, null, null), 0, 2 * GB);
        assertTrue(p.items().isEmpty());
        assertTrue(p.satisfied());
    }

    @Test
    void 日数_31日前は消え29日前は残る() {
        var s = List.of(study("old31", 31, GB), study("new29", 29, GB));
        var p = plan(s, Map.of(), new RetentionConfig(30, null, null), 100 * GB, 2 * GB);
        assertEquals(List.of("old31"), uids(p));
        assertEquals("days", p.items().get(0).reason());
    }

    @Test
    void 空き容量_古い順に下限以上になったところで止まる() {
        // 空き 5GB・下限 10GB。古い順に 3・4・2 GB → 3GB で 8GB（未達）→ 4GB で 12GB（達成）→ 2GB は消さない
        var s = List.of(study("a", 30, 3 * GB), study("b", 20, 4 * GB), study("c", 10, 2 * GB));
        var p = plan(s, Map.of(), new RetentionConfig(null, null, 10.0), 5 * GB, 9 * GB);
        assertEquals(List.of("a", "b"), uids(p));
        assertEquals(7 * GB, p.totalBytes());
        assertTrue(p.satisfied());
    }

    @Test
    void 空きが下限以上なら1件も消えない() {
        var s = List.of(study("a", 30, 3 * GB));
        var p = plan(s, Map.of(), new RetentionConfig(null, null, 10.0), 10 * GB, 3 * GB);
        assertTrue(p.items().isEmpty());
        assertTrue(p.satisfied());
    }

    @Test
    void 保管庫の上限_合計が上限以下になったところで止まる() {
        // 合計 9GB・上限 5GB。古い順に 3・4・2 → 3GB で 6GB（超過）→ 4GB で 2GB（以下）→ 止まる
        var s = List.of(study("a", 30, 3 * GB), study("b", 20, 4 * GB), study("c", 10, 2 * GB));
        var p = plan(s, Map.of(), new RetentionConfig(null, 5.0, null), 100 * GB, 9 * GB);
        assertEquals(List.of("a", "b"), uids(p));
        assertTrue(p.satisfied());
    }

    @Test
    void 検査日ではなく受信日時の古い順に並べる() {
        var older = new StudyStat("rcvOld", "k1", "k1", "n", "20260101", "CT", 1, GB, NOW - 40 * DAY, 0);
        var newer = new StudyStat("rcvNew", "k2", "k2", "n", "19900101", "CT", 1, GB, NOW - 10 * DAY, 0); // 検査日は古いが受信は新しい
        var p = plan(List.of(newer, older), Map.of(), new RetentionConfig(null, null, 5.0), 4 * GB, 2 * GB);
        assertEquals(List.of("rcvOld"), uids(p));
    }

    @Test
    void 保護の理由を1つずつ付けると_その検査は飛ばされ次に古い検査が選ばれる() {
        for (ProtectionReason r : ProtectionReason.values()) {
            if (r == ProtectionReason.RECEIVED_AFTER_PLAN_START || r == ProtectionReason.UNKNOWN_RECEIVED) {
                continue; // この 2 つは計画の側で付く（別のテストで見る）
            }
            var s = List.of(study("oldest", 50, GB), study("next", 40, GB), study("recent", 1, GB));
            Map<String, Set<ProtectionReason>> prot = new HashMap<>();
            prot.put("oldest", EnumSet.of(r));
            var p = plan(s, prot, new RetentionConfig(null, null, 1.0), 0, 3 * GB);
            assertEquals(List.of("next"), uids(p), "理由 " + r + " の検査は消えない");
            assertEquals(1, p.protectedSkips().get(r.key()), "理由 " + r + " が除外に数えられる");
        }
    }

    @Test
    void 保護だけが残って満たせないときは_消さずに警告() {
        var s = List.of(study("a", 50, GB), study("b", 40, GB));
        Map<String, Set<ProtectionReason>> prot = new HashMap<>();
        prot.put("a", EnumSet.of(ProtectionReason.LOCK));
        prot.put("b", EnumSet.of(ProtectionReason.ROI));
        var p = plan(s, prot, new RetentionConfig(null, null, 10.0), 0, 2 * GB);
        assertTrue(p.items().isEmpty());
        assertFalse(p.satisfied());
        assertTrue(p.warnings().contains("free"));
        assertTrue(p.warnings().contains("protected:2"));
    }

    @Test
    void 判定の開始後に受信した検査は_条件に当たっても消えない() {
        // 空きの条件は、受信が新しい検査にも当たる。開始より後に受信した検査だけが、保護で外れる。
        var late = new StudyStat("late", "k", "k", "n", "20260101", "CT", 1, GB, NOW + 1, 0);
        var early = study("early", 5, GB);
        var p = RetentionPlanner.plan(List.of(late, early), Map.of(), new RetentionConfig(null, null, 10.0),
                0, 2 * GB, NOW + 10, NOW);
        assertEquals(List.of("early"), uids(p));
        assertEquals(1, p.protectedSkips().get(ProtectionReason.RECEIVED_AFTER_PLAN_START.key()));
        assertFalse(p.satisfied());
    }

    @Test
    void 受信日時が不明の画像を含む検査は_条件に当たっても消えない() {
        var unknownSome = new StudyStat("unk1", "k", "k", "n", "20260101", "CT", 1, GB, NOW - 90 * DAY, 1); // 一部の画像が不明
        var unknownAll = new StudyStat("unk2", "k", "k", "n", "20260101", "CT", 1, GB, null, 1);
        var ok = study("ok", 20, GB);
        // 下限 2GB は、消せる検査（1GB）だけでは満たせない → 不明の 2 件には手を付けず、満たせない警告になる
        var p = plan(List.of(unknownSome, unknownAll, ok), Map.of(), new RetentionConfig(null, null, 2.0), 0, 3 * GB);
        assertEquals(List.of("ok"), uids(p));
        assertEquals(2, p.protectedSkips().get(ProtectionReason.UNKNOWN_RECEIVED.key()));
        assertFalse(p.satisfied());
    }

    @Test
    void 日数と空きの条件を重ねても_同じ検査を二重に選ばない() {
        var s = new ArrayList<>(List.of(study("a", 90, GB), study("b", 80, GB), study("c", 5, GB)));
        var p = plan(s, Map.of(), new RetentionConfig(30, null, 3.0), 2 * GB, 3 * GB);
        // 日数で a・b → 空き 2+2=4GB ≥ 3GB なので c は選ばない
        assertEquals(List.of("a", "b"), uids(p));
        assertEquals(2, p.items().size());
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 自動削除の計画を立てる純粋関数（時計・ディスク・DB に触れない）。試算も本番も同じ関数を通る。
 *
 * <p>規則:
 * <ul>
 *   <li>並びは<b>最後の受信日時の古い順</b>。検査日では並べない（比較のために取り寄せた過去検査が、
 *       取り寄せた直後に消えるため）。</li>
 *   <li>条件は日数 → 保管庫の上限 → 空きの下限の順に、消す検査の容量を差し引きながら判定する。
 *       止める所は条件をちょうど満たしたところ（余裕は付けない）。</li>
 *   <li>保護された検査は、どの条件でも選ばない。条件に当たったのに保護で外した検査は理由別に数える。
 *       保護だけが残って条件を満たせないときは、足さずに警告を返す。</li>
 *   <li>条件が 1 つも無ければ、常に何も選ばない（既定オフ）。</li>
 * </ul>
 */
public final class RetentionPlanner {

    private static final long DAY_MS = 24L * 60 * 60 * 1000;

    private RetentionPlanner() {
    }

    /**
     * @param external       検査 UID → 保護の理由（ロック・ROI など。受信日時に関わるものはここで足す）
     * @param freeBytes      ディスクの空き
     * @param storeBytes     保管庫の合計（検査の容量の合計と同じ集計）
     * @param nowMs          今の時刻
     * @param planStartMs    判定の開始時刻（これ以降に受信があった検査は守る）
     */
    public static RetentionPlan plan(List<StudyStat> studies, Map<String, Set<ProtectionReason>> external,
                                     RetentionConfig cfg, long freeBytes, long storeBytes, long nowMs, long planStartMs) {
        if (cfg == null || !cfg.any()) {
            return new RetentionPlan(List.of(), 0, Map.of(), true, List.of(), Set.of());
        }
        // 受信日時が分かる検査を古い順に。分からない検査は保護の理由「不明」を付けて別に数える。
        List<StudyStat> ordered = new ArrayList<>(studies);
        ordered.sort(Comparator.comparing((StudyStat s) -> s.lastReceivedAt() == null ? Long.MAX_VALUE : s.lastReceivedAt())
                .thenComparing(StudyStat::studyUid));

        Map<String, Set<ProtectionReason>> prot = new LinkedHashMap<>();
        for (StudyStat s : ordered) {
            Set<ProtectionReason> r = EnumSet.noneOf(ProtectionReason.class);
            Set<ProtectionReason> ext = external.get(s.studyUid());
            if (ext != null) {
                r.addAll(ext);
            }
            if (s.lastReceivedAt() == null || s.unknownReceived() > 0) {
                r.add(ProtectionReason.UNKNOWN_RECEIVED);
            }
            if (s.lastReceivedAt() != null && s.lastReceivedAt() >= planStartMs) {
                r.add(ProtectionReason.RECEIVED_AFTER_PLAN_START);
            }
            prot.put(s.studyUid(), r);
        }

        Set<String> chosen = new HashSet<>();
        List<RetentionPlan.Item> items = new ArrayList<>();
        Map<String, Set<ProtectionReason>> skipped = new LinkedHashMap<>(); // 条件に当たったが保護で外した検査
        long[] total = {0};

        // 1. 日数
        if (cfg.days() != null) {
            long limit = nowMs - cfg.days() * DAY_MS;
            for (StudyStat s : ordered) {
                if (s.lastReceivedAt() != null && s.lastReceivedAt() < limit) {
                    consider(s, "days", prot, chosen, items, skipped, total);
                }
            }
        }
        // 2. 保管庫の上限
        boolean satisfied = true;
        List<String> warnings = new ArrayList<>();
        Long maxBytes = cfg.maxBytes();
        if (maxBytes != null) {
            for (StudyStat s : ordered) {
                if (storeBytes - total[0] <= maxBytes) {
                    break;
                }
                if (!chosen.contains(s.studyUid())) {
                    consider(s, "size", prot, chosen, items, skipped, total);
                }
            }
            if (storeBytes - total[0] > maxBytes) {
                satisfied = false;
                warnings.add("size");
            }
        }
        // 3. 空きの下限
        Long minFree = cfg.minFreeBytes();
        if (minFree != null) {
            for (StudyStat s : ordered) {
                if (freeBytes + total[0] >= minFree) {
                    break;
                }
                if (!chosen.contains(s.studyUid())) {
                    consider(s, "free", prot, chosen, items, skipped, total);
                }
            }
            if (freeBytes + total[0] < minFree) {
                satisfied = false;
                warnings.add("free");
            }
        }

        // 全体を古い順に（条件ごとに追加した順ではなく、消す順に見せる）
        items.sort(Comparator.comparingLong(RetentionPlan.Item::lastReceivedAt).thenComparing(RetentionPlan.Item::studyUid));
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (Set<ProtectionReason> rs : skipped.values()) {
            for (ProtectionReason r : rs) {
                counts.merge(r.key(), 1, Integer::sum);
            }
        }
        if (!satisfied) {
            warnings.add("protected:" + skipped.size());
        }
        return new RetentionPlan(items, total[0], counts, satisfied, warnings, Set.copyOf(skipped.keySet()));
    }

    private static void consider(StudyStat s, String reason, Map<String, Set<ProtectionReason>> prot, Set<String> chosen,
                                 List<RetentionPlan.Item> items, Map<String, Set<ProtectionReason>> skipped, long[] total) {
        Set<ProtectionReason> p = prot.get(s.studyUid());
        if (!p.isEmpty()) {
            skipped.putIfAbsent(s.studyUid(), p);
            return;
        }
        chosen.add(s.studyUid());
        items.add(new RetentionPlan.Item(s.studyUid(), s.patientId(), s.patientName(), s.studyDate(), s.modality(), s.instances(),
                s.sizeBytes(), s.lastReceivedAt(), reason));
        total[0] += s.sizeBytes();
    }
}

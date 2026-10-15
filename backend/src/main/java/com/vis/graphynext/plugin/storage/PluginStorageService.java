/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.storage;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.dicom.store.StorageUnavailableException;
import com.vis.graphynext.gdrive.GdriveSyncService;
import com.vis.graphynext.plugin.PluginJobService;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;

/**
 * プラグインが「この検査・シリーズを手元に確保する」ための口（H67）。モード A（Drive が正本・手元は上限つきのキャッシュ）で、
 * 手元に無い画像を Drive から取り寄せる。**パスは返さない**（検査・シリーズの UID を渡すだけ）。新しい権限は作らない:
 * 利用者自身の Drive にある自分のデータを手元へ戻すだけで、外へは出ない（{@code /api/instances/...} を直接叩いても同じ取得が走る）。
 *
 * <p>JAR のプラグインには、args の {@link PluginJobService#ENSURE_LOCAL_KEY}（SOP UID → 手元のパス）を渡す。
 */
@Service
public class PluginStorageService {

    /** 取り寄せる単位。単位ごとに進み具合の通知と取り消しの確認をする。 */
    static final int BATCH = 16;

    /** 検査・シリーズ・SOP の引き方（テストで差し替える）。 */
    interface Instances {
        List<DicomInstance> byStudy(String studyUid);

        List<DicomInstance> bySeries(String studyUid, String seriesUid);

        Optional<DicomInstance> bySop(String sopUid);
    }

    private final Instances instances;
    private final StorageLayout layout;
    private final ObjectProvider<GdriveSyncService> gdrive;

    @org.springframework.beans.factory.annotation.Autowired
    public PluginStorageService(DicomInstanceRepository repo, StorageLayout layout, ObjectProvider<GdriveSyncService> gdrive) {
        this(new Instances() {
            @Override
            public List<DicomInstance> byStudy(String studyUid) {
                return repo.findByStudyInstanceUid(studyUid);
            }

            @Override
            public List<DicomInstance> bySeries(String studyUid, String seriesUid) {
                return repo.findBySeries(studyUid, seriesUid);
            }

            @Override
            public Optional<DicomInstance> bySop(String sopUid) {
                return repo.findById(sopUid);
            }
        }, layout, gdrive);
    }

    PluginStorageService(Instances instances, StorageLayout layout, ObjectProvider<GdriveSyncService> gdrive) {
        this.instances = instances;
        this.layout = layout;
        this.gdrive = gdrive;
    }

    /**
     * 検査（または、その中のシリーズ）の画像を、手元に無いものだけ Drive から取り寄せる。
     * 結果は {@code {ok, total, fetched, alreadyLocal, cacheMode}}。取り寄せられなければ {@code {ok:false, error:<理由コード>, fetched}}
     * （例外にしない: プラグインが理由で分岐できる）。取り消されたら、そこまでの結果を返す（ジョブの状態が「取り消し」になる）。
     */
    public Map<String, Object> ensure(String studyUid, List<String> seriesUids, PluginJobService.TaskContext ctx) {
        List<DicomInstance> all = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        if (seriesUids == null || seriesUids.isEmpty()) {
            instances.byStudy(studyUid).forEach(i -> {
                if (seen.add(i.getSopInstanceUid())) all.add(i);
            });
        } else {
            for (String se : seriesUids) {
                instances.bySeries(studyUid, se).forEach(i -> {
                    if (seen.add(i.getSopInstanceUid())) all.add(i);
                });
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        if (all.isEmpty()) {
            out.put("ok", false);
            out.put("error", "not-found");
            return out;
        }
        out.put("total", all.size());
        out.put("cacheMode", layout.cacheMode());
        if (!layout.cacheMode()) {
            out.put("ok", true);
            out.put("fetched", 0);
            out.put("alreadyLocal", all.size());
            return out;
        }
        List<DicomInstance> missing = all.stream().filter(i -> !layout.isLocal(i)).toList();
        int fetched = 0;
        try {
            for (int i = 0; i < missing.size() && !ctx.cancelled().getAsBoolean(); i += BATCH) {
                List<DicomInstance> batch = missing.subList(i, Math.min(missing.size(), i + BATCH));
                layout.prefetch(batch, ctx.cancelled());
                fetched += batch.size();
                ctx.progress().accept((double) fetched / missing.size(), fetched + " / " + missing.size());
            }
        } catch (StorageUnavailableException e) {
            out.put("ok", false);
            out.put("error", e.reason());
            out.put("fetched", fetched);
            out.put("alreadyLocal", all.size() - missing.size());
            return out;
        }
        out.put("ok", true);
        out.put("fetched", fetched);
        out.put("alreadyLocal", all.size() - missing.size());
        return out;
    }

    /** 保管庫の状態（モード・使用量・上限・Drive にだけある件数）。パスや Drive の ID は含めない。 */
    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        GdriveSyncService g = gdrive.getIfAvailable();
        GdriveSyncService.Status s = g == null ? null : g.status();
        boolean cache = s != null && "cache".equals(s.mode());
        out.put("cacheMode", cache);
        out.put("usedBytes", cache ? s.cacheBytes() : 0);
        out.put("limitBytes", cache ? s.cacheLimitBytes() : 0);
        out.put("remoteOnlyCount", cache ? s.evictedCount() : 0);
        return out;
    }

    /**
     * JAR 用。SOP UID → 手元のパス（その SOP が無ければ null）。取り寄せに失敗したら
     * {@code IllegalStateException("storage-unavailable: <理由>")}（JDK の型だけで返す）。
     * 呼ぶと読まれた時刻が更新され、直近の保護の間は追い出されない。
     */
    public Function<String, String> ensureLocalFunction() {
        return sop -> {
            Optional<DicomInstance> inst = sop == null ? Optional.empty() : instances.bySop(sop);
            if (inst.isEmpty()) {
                return null;
            }
            try {
                Path p = layout.resolveForRead(inst.get());
                return p == null ? null : p.toAbsolutePath().toString();
            } catch (StorageUnavailableException e) {
                throw new IllegalStateException("storage-unavailable: " + e.reason());
            }
        };
    }
}

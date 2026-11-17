/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.emr;

import com.vis.graphynext.dicom.DicomController;
import com.vis.graphynext.dicom.DicomLocalAeService;
import com.vis.graphynext.dicom.DicomRemoteAeService;
import com.vis.graphynext.dicom.qr.DimseOutcome;
import com.vis.graphynext.dicom.qr.DimseQrService;
import com.vis.graphynext.dicom.qr.QrFindException;
import com.vis.graphynext.dicom.qr.QrStudyRow;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.prefetch.PrefetchHold;
import com.vis.graphynext.prefetch.PrefetchHoldRepository;
import com.vis.graphynext.prefetch.StudyFetchLocks;
import com.vis.graphynext.settings.SettingsService;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.Clock;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

/**
 * 電子カルテの患者 ID が変わったとき、その患者の過去検査を PACS から取り込む（先取り）。
 *
 * <p>流れ: C-FIND（患者 ID の完全一致）→ 日付の新しい順に並べる → <b>直近の検査を先に</b>取り、残りを続けて取る。
 * 取る前に、検査へ自動削除からの保護期限（<b>取得した日の翌日いっぱい</b>）を書く。直近の検査が取れた時点で
 * {@link FetchState#latestReady} を立てる（2D ビューアはそれを見て開く）。
 *
 * <p>定時の事前取得（{@code PrefetchService}）とは<b>別の 1 本のキュー</b>で動く（走行中で断られない）。
 * <b>最新の要求が勝つ</b>: 次の患者が来たら、古い患者の待ちを捨て、取り込み中の 1 検査は終わらせて残りを止める。
 * 同じ検査を定時の経路と同時に取りに行かないよう、検査ごとの排他（{@link StudyFetchLocks}）を共有する。
 *
 * <p>🔴 患者 ID はログに出さない。
 */
@Service
@Profile("standalone")
public class EmrPrefetchService {

    private static final Logger log = LoggerFactory.getLogger(EmrPrefetchService.class);
    private static final DateTimeFormatter DA = DateTimeFormatter.BASIC_ISO_DATE;

    /**
     * 取り込みの状態。state: idle / finding / retrieving / done / not-found / error。
     * {@code latestReady} は、直近の検査が 2D ビューアで開ける状態か（取り終えた、または既にローカルに揃っている）。
     */
    public record FetchState(String state, String patientId, int found, int retrieved, String latestStudyUid,
                             boolean latestReady, String error) {
        public static FetchState idle() {
            return new FetchState("idle", null, 0, 0, null, false, null);
        }
    }

    private record Request(String patientId, long token) {
    }

    private final Supplier<Map<String, String>> settings;
    private final DimseQrService dimse;
    private final DicomRemoteAeService remoteAes;
    private final DicomLocalAeService localAe;
    private final DicomInstanceRepository instances;
    private final PrefetchHoldRepository holds;
    private final Clock clock;

    private final AtomicLong tokens = new AtomicLong();
    /** 待っている最新の要求（古い要求は上書きされて捨てられる）。 */
    private Request pending;
    private boolean draining;
    private final ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "emr-prefetch");
        t.setDaemon(true);
        return t;
    });
    private volatile FetchState state = FetchState.idle();
    private volatile long currentToken;

    @Autowired
    public EmrPrefetchService(SettingsService settings, DimseQrService dimse, DicomRemoteAeService remoteAes,
                              DicomLocalAeService localAe, DicomInstanceRepository instances,
                              PrefetchHoldRepository holds) {
        this(settings::getAll, dimse, remoteAes, localAe, instances, holds, Clock.systemDefaultZone());
    }

    EmrPrefetchService(Supplier<Map<String, String>> settings, DimseQrService dimse, DicomRemoteAeService remoteAes,
                       DicomLocalAeService localAe, DicomInstanceRepository instances, PrefetchHoldRepository holds,
                       Clock clock) {
        this.settings = settings;
        this.dimse = dimse;
        this.remoteAes = remoteAes;
        this.localAe = localAe;
        this.instances = instances;
        this.holds = holds;
        this.clock = clock;
    }

    @PreDestroy
    void shutdown() {
        executor.shutdownNow();
    }

    public FetchState state() {
        return state;
    }

    @EventListener
    void onChanged(EmrPatientChanged e) {
        request(e.patientId(), e.seq());
    }

    /**
     * 患者の先取りを頼む。同じ患者の取り込み中・検索中なら何もしない。別の患者なら、古い待ちを捨てて、これを次にする。
     */
    public void request(String patientId, long seq) {
        FetchState cur = state;
        if (patientId.equals(cur.patientId()) && ("finding".equals(cur.state()) || "retrieving".equals(cur.state()))) {
            return;
        }
        long token = tokens.incrementAndGet();
        currentToken = token; // 走っている古い要求は、次の検査の前に、これを見て止まる
        state = new FetchState("finding", patientId, 0, 0, null, false, null);
        synchronized (this) {
            pending = new Request(patientId, token);
            if (draining) {
                return;
            }
            draining = true;
        }
        executor.execute(this::drain);
    }

    private void drain() {
        while (true) {
            Request r;
            synchronized (this) {
                r = pending;
                pending = null;
                if (r == null) {
                    draining = false;
                    return;
                }
            }
            try {
                process(r);
            } catch (RuntimeException e) {
                log.warn("電子カルテ連携の先取りに失敗しました（続行）: {}", e.getClass().getSimpleName());
                setState(r, new FetchState("error", r.patientId(), 0, 0, null, false, "unexpected"));
            }
        }
    }

    private boolean current(Request r) {
        return r.token() == currentToken;
    }

    /** 自分がまだ最新の要求のときだけ、状態を書く（古い要求が新しい状態を上書きしない）。 */
    private void setState(Request r, FetchState s) {
        if (current(r)) {
            state = s;
        }
    }

    private void process(Request r) {
        EmrConfig cfg = EmrConfig.from(settings.get());
        String id = r.patientId();
        if (!cfg.enabled() || !cfg.valid()) {
            setState(r, new FetchState("error", id, 0, 0, null, false, "config"));
            return;
        }
        DicomController.RemoteAeDto pacs = remoteAes.list().stream()
                .filter(a -> a.aeTitle().equals(cfg.pacsAe())).findFirst().orElse(null);
        if (pacs == null) {
            setState(r, new FetchState("error", id, 0, 0, null, false, "pacs-ae-not-found"));
            return;
        }
        List<QrStudyRow> rows;
        try {
            rows = dimse.findStudiesForQr(pacs.host(), pacs.port(), pacs.aeTitle(), matchKeys(cfg, id), pacs.tls());
        } catch (QrFindException e) {
            DimseOutcome o = e.outcome();
            setState(r, new FetchState("error", id, 0, 0, null, false, "find-failed:" + o.kind()));
            return;
        } catch (IOException e) {
            setState(r, new FetchState("error", id, 0, 0, null, false, "find-failed"));
            return;
        }
        List<QrStudyRow> studies = new ArrayList<>(rows.stream().filter(x -> id.equals(x.patientId())).toList());
        studies.sort(Comparator.comparing((QrStudyRow x) -> x.studyDate() == null ? "" : x.studyDate()).reversed());
        if (studies.isEmpty()) {
            setState(r, new FetchState("not-found", id, 0, 0, null, false, null));
            return;
        }
        String latest = studies.get(0).studyInstanceUid();
        long until = LocalDate.now(clock).plusDays(2).atStartOfDay(clock.getZone()).toInstant().toEpochMilli();
        int retrieved = 0;
        boolean latestReady = false;
        String error = null;
        setState(r, new FetchState("retrieving", id, studies.size(), 0, latest, false, null));
        for (int i = 0; i < studies.size(); i++) {
            if (!current(r)) {
                return; // 次の患者が来た: 残りは取らない（取り込み中だった 1 検査は終わっている）
            }
            QrStudyRow s = studies.get(i);
            String uid = s.studyInstanceUid();
            hold(uid, until);
            String err = StudyFetchLocks.withLock(uid, () -> {
                long have = instances.countByStudyInstanceUid(uid);
                if (have > 0 && (s.numberOfStudyRelatedInstances() <= 0 || have >= s.numberOfStudyRelatedInstances())) {
                    return null; // 既に揃っている
                }
                return retrieve(cfg, pacs, uid);
            });
            if (err == null) {
                retrieved++;
                if (i == 0) {
                    latestReady = true;
                }
            } else if (i == 0) {
                error = "latest-" + err; // 直近が取れなかった（ほかは続ける）
            }
            setState(r, new FetchState("retrieving", id, studies.size(), retrieved, latest, latestReady, error));
        }
        setState(r, new FetchState(error != null && !latestReady ? "error" : "done", id, studies.size(), retrieved,
                latest, latestReady, error));
    }

    /** 取得して、届いたことをローカルの索引で確かめる。失敗ならエラーコード、成功なら null。 */
    private String retrieve(EmrConfig cfg, DicomController.RemoteAeDto pacs, String uid) {
        long timeoutMs = cfg.timeoutSec() * 1000L;
        try {
            if ("get".equals(cfg.retrieve())) {
                dimse.getStudy(pacs.host(), pacs.port(), pacs.aeTitle(), uid, pacs.tls(), timeoutMs);
            } else {
                dimse.moveStudy(pacs.host(), pacs.port(), pacs.aeTitle(), uid, localAe.aeTitle(), pacs.tls(), timeoutMs);
            }
        } catch (IOException e) {
            log.warn("電子カルテ連携: 取得に失敗 ({})", e.getClass().getSimpleName());
            return "retrieve-failed";
        }
        return instances.countByStudyInstanceUid(uid) > 0 ? null : "no-instances";
    }

    private void hold(String uid, long untilMs) {
        PrefetchHold h = holds.findById(uid).orElse(null);
        if (h == null) {
            holds.save(new PrefetchHold(uid, untilMs));
        } else {
            h.extendTo(untilMs);
            holds.save(h);
        }
    }

    private Map<String, String> matchKeys(EmrConfig cfg, String patientId) {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("PatientID", patientId);
        if (cfg.years() != null) {
            m.put("StudyDate", LocalDate.now(clock).minusYears(cfg.years()).format(DA) + "-");
        }
        return m;
    }
}

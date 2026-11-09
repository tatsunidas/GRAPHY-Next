/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import com.vis.graphynext.dicom.DicomController;
import com.vis.graphynext.dicom.DicomLocalAeService;
import com.vis.graphynext.dicom.DicomRemoteAeService;
import com.vis.graphynext.dicom.qr.DimseQrService;
import com.vis.graphynext.dicom.qr.QrStudyRow;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.settings.SettingsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;
import java.util.stream.Stream;

/**
 * 予約一覧（DICOM MWL か RIS の CSV）の患者について、PACS の過去検査を自局へ取り込む。
 *
 * <p>流れ: 対象日の予約 → 患者の一意化 → 患者ごとに C-FIND（患者 ID の完全一致）→ 絞り込み → ローカルに揃っていれば
 * 飛ばす → 取得（C-MOVE か C-GET）。<b>取得の前に</b>検査へ保護期限（予約日の翌日 0 時）を書く
 * （取得で届いた直後に、容量の条件で自動削除されないため）。
 *
 * <p>失敗の分け方: 予約一覧の取得失敗は ERROR（何も取らない）。C-FIND の失敗は通信先の障害として扱い、そこで止めて
 * 残りの患者を「未処理」にする（次回の再試行で拾う。入力を捨てない）。1 検査の取得の失敗はその検査だけ FAILED。
 */
@Service
@Profile("standalone")
public class PrefetchService {

    private static final Logger log = LoggerFactory.getLogger(PrefetchService.class);

    public static final String MANUAL = "manual";
    public static final String SCHEDULE = "SCHEDULE";
    public static final String MANUAL_TRIGGER = "MANUAL";

    private static final DateTimeFormatter DA = DateTimeFormatter.BASIC_ISO_DATE;

    /** 予約一覧が取れなかった（設定の不備・ファイルが無い・MWL の障害など）。 */
    static final class SourceException extends Exception {
        SourceException(String code) {
            super(code);
        }
    }

    private final SettingsService settings;
    private final DimseQrService dimse;
    private final DicomRemoteAeService remoteAes;
    private final DicomLocalAeService localAe;
    private final DicomInstanceRepository instances;
    private final PrefetchRunRepository runs;
    private final PrefetchItemRepository items;
    private final PrefetchHoldRepository holds;
    private final Clock clock;
    private final ReentrantLock lock = new ReentrantLock();

    @Autowired
    public PrefetchService(SettingsService settings, DimseQrService dimse, DicomRemoteAeService remoteAes,
                           DicomLocalAeService localAe, DicomInstanceRepository instances, PrefetchRunRepository runs,
                           PrefetchItemRepository items, PrefetchHoldRepository holds) {
        this(settings, dimse, remoteAes, localAe, instances, runs, items, holds, Clock.systemDefaultZone());
    }

    /** テスト用: 時計を差し替える。 */
    PrefetchService(SettingsService settings, DimseQrService dimse, DicomRemoteAeService remoteAes,
                    DicomLocalAeService localAe, DicomInstanceRepository instances, PrefetchRunRepository runs,
                    PrefetchItemRepository items, PrefetchHoldRepository holds, Clock clock) {
        this.settings = settings;
        this.dimse = dimse;
        this.remoteAes = remoteAes;
        this.localAe = localAe;
        this.instances = instances;
        this.runs = runs;
        this.items = items;
        this.holds = holds;
        this.clock = clock;
    }

    PrefetchConfig config() {
        return PrefetchConfig.from(settings.getAll());
    }

    public boolean isRunning() {
        return lock.isLocked();
    }

    /** 設定の対象日（今日・明日）。 */
    static List<LocalDate> targetDays(PrefetchConfig cfg, LocalDate today) {
        return switch (cfg.targetDay()) {
            case "today" -> List.of(today);
            case "tomorrow" -> List.of(today.plusDays(1));
            default -> List.of(today, today.plusDays(1));
        };
    }

    /** 予約一覧だけ取って、日ごとの患者数を返す（取得はしない）。 */
    public Map<String, Integer> previewSchedule() throws SourceException {
        PrefetchConfig cfg = config();
        if (!cfg.enabled() || !cfg.valid()) {
            throw new SourceException(cfg.valid() ? "disabled" : cfg.errors().get(0));
        }
        Map<String, Integer> out = new LinkedHashMap<>();
        for (LocalDate d : targetDays(cfg, LocalDate.now(clock))) {
            out.put(d.format(DA), appointments(cfg, d).size());
        }
        return out;
    }

    /**
     * 1 回実行する。同時に 1 つだけ（走行中なら IllegalStateException("running")）。
     *
     * @param slotKey 定時の枠。手動は {@link #MANUAL}
     */
    public PrefetchRun run(String trigger, String slotKey) {
        if (!lock.tryLock()) {
            throw new IllegalStateException("running");
        }
        try {
            return execute(trigger, slotKey);
        } finally {
            lock.unlock();
        }
    }

    private PrefetchRun execute(String trigger, String slotKey) {
        long now = clock.millis();
        PrefetchConfig cfg = config();
        LocalDate today = LocalDate.now(clock);
        String days = cfg.valid() && cfg.targetDay() != null
                ? String.join(",", targetDays(cfg, today).stream().map(d -> d.format(DA)).toList()) : "";
        PrefetchRun run = runs.save(new PrefetchRun(slotKey, trigger, now, days));
        if (!cfg.enabled() || !cfg.valid()) {
            run.finish(PrefetchRun.ERROR, clock.millis(), 0, 0, 0, 0, 0, 0,
                    cfg.enabled() ? "config:" + String.join(",", cfg.errors()) : "disabled");
            return runs.save(run);
        }
        DicomController.RemoteAeDto pacs = remoteAes.list().stream()
                .filter(a -> a.aeTitle().equals(cfg.pacsAe())).findFirst().orElse(null);
        if (pacs == null) {
            run.finish(PrefetchRun.ERROR, clock.millis(), 0, 0, 0, 0, 0, 0, "pacs-ae-not-found");
            return runs.save(run);
        }

        // 患者 → 最後の予約日（保護期限はこの日の翌日 0 時）
        Map<String, LocalDate> patients = new LinkedHashMap<>();
        for (LocalDate d : targetDays(cfg, today)) {
            try {
                for (String id : appointments(cfg, d)) {
                    patients.merge(id, d, (a, b) -> a.isAfter(b) ? a : b);
                }
            } catch (SourceException e) {
                run.finish(PrefetchRun.ERROR, clock.millis(), 0, 0, 0, 0, 0, 0, e.getMessage());
                return runs.save(run);
            }
        }

        int found = 0;
        int retrieved = 0;
        int existing = 0;
        int failed = 0;
        int done = 0;
        String interrupted = null;
        List<Map.Entry<String, LocalDate>> list = new ArrayList<>(patients.entrySet());
        for (Map.Entry<String, LocalDate> p : list) {
            List<QrStudyRow> rows;
            try {
                rows = withModalities(cfg, pacs, dimse.findStudiesForQr(pacs.host(), pacs.port(), pacs.aeTitle(),
                        matchKeys(cfg, p.getKey(), today), pacs.tls()));
            } catch (IOException e) {
                interrupted = "pacs-find-failed";
                log.warn("事前取得: C-FIND に失敗したため中断します ({})", e.getClass().getSimpleName());
                break;
            }
            done++;
            long until = p.getValue().plusDays(1).atStartOfDay(clock.getZone()).toInstant().toEpochMilli();
            for (QrStudyRow r : select(cfg, rows)) {
                found++;
                String uid = r.studyInstanceUid();
                hold(uid, until);
                long have = instances.countByStudyInstanceUid(uid);
                int expected = r.numberOfStudyRelatedInstances();
                if (have > 0 && (expected <= 0 || have >= expected)) {
                    existing++;
                    items.save(new PrefetchItem(run.getId(), uid, PrefetchItem.EXISTING, null));
                    continue;
                }
                String err = retrieve(cfg, pacs, uid);
                if (err == null) {
                    retrieved++;
                    items.save(new PrefetchItem(run.getId(), uid, PrefetchItem.RETRIEVED, null));
                } else {
                    failed++;
                    items.save(new PrefetchItem(run.getId(), uid, PrefetchItem.FAILED, err));
                }
            }
        }
        int pending = list.size() - done;
        run.finish(interrupted == null ? PrefetchRun.COMPLETE : PrefetchRun.INTERRUPTED, clock.millis(),
                list.size(), found, retrieved, existing, failed, pending, interrupted);
        return runs.save(run);
    }

    /** 取得して、届いたことをローカルの索引で確かめる。失敗ならエラーコード、成功なら null。 */
    private String retrieve(PrefetchConfig cfg, DicomController.RemoteAeDto pacs, String uid) {
        long timeoutMs = cfg.timeoutSec() * 1000L;
        try {
            if ("get".equals(cfg.retrieve())) {
                dimse.getStudy(pacs.host(), pacs.port(), pacs.aeTitle(), uid, pacs.tls(), timeoutMs);
            } else {
                dimse.moveStudy(pacs.host(), pacs.port(), pacs.aeTitle(), uid, localAe.aeTitle(), pacs.tls(), timeoutMs);
            }
        } catch (IOException e) {
            log.warn("事前取得: 取得に失敗 ({})", e.getClass().getSimpleName());
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

    private static Map<String, String> matchKeys(PrefetchConfig cfg, String patientId, LocalDate today) {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("PatientID", patientId);
        if (cfg.years() != null) {
            m.put("StudyDate", today.minusYears(cfg.years()).format(DA) + "-");
        }
        return m;
    }

    /**
     * モダリティで絞る設定のとき、PACS が ModalitiesInStudy を返さない検査は、シリーズ一覧からモダリティを補う
     * （返さない PACS がある。補わずに絞ると全件が落ちるか、黙って全件を取ってしまう）。
     */
    private List<QrStudyRow> withModalities(PrefetchConfig cfg, DicomController.RemoteAeDto pacs, List<QrStudyRow> rows)
            throws IOException {
        if (cfg.modalities().isEmpty()) {
            return rows;
        }
        List<QrStudyRow> out = new ArrayList<>(rows.size());
        for (QrStudyRow r : rows) {
            if (r.studyInstanceUid() == null || (r.modality() != null && !r.modality().isBlank())) {
                out.add(r);
                continue;
            }
            Set<String> mods = new LinkedHashSet<>();
            for (var s : dimse.findSeries(pacs.host(), pacs.port(), pacs.aeTitle(), r.studyInstanceUid(), Map.of(),
                    pacs.tls())) {
                if (s.modality() != null && !s.modality().isBlank()) {
                    mods.add(s.modality().trim());
                }
            }
            out.add(new QrStudyRow(r.studyInstanceUid(), r.patientId(), r.patientName(), r.patientBirthDate(),
                    r.patientSex(), r.studyDate(), r.studyDescription(), r.accessionNumber(), String.join("\\", mods),
                    r.numberOfStudyRelatedSeries(), r.numberOfStudyRelatedInstances()));
        }
        return out;
    }

    /** モダリティで絞り、新しい順に並べ、件数の上限で切る。 */
    static List<QrStudyRow> select(PrefetchConfig cfg, List<QrStudyRow> rows) {
        List<QrStudyRow> out = new ArrayList<>();
        for (QrStudyRow r : rows) {
            if (r.studyInstanceUid() == null || r.studyInstanceUid().isBlank()) {
                continue;
            }
            if (!cfg.modalities().isEmpty()) {
                Set<String> mods = new LinkedHashSet<>();
                if (r.modality() != null) {
                    for (String m : r.modality().split("[\\\\,\\s]+")) {
                        mods.add(m.trim().toUpperCase());
                    }
                }
                if (cfg.modalities().stream().noneMatch(mods::contains)) {
                    continue;
                }
            }
            out.add(r);
        }
        out.sort(Comparator.comparing((QrStudyRow r) -> r.studyDate() == null ? "" : r.studyDate()).reversed());
        if (cfg.maxStudies() != null && out.size() > cfg.maxStudies()) {
            return new ArrayList<>(out.subList(0, cfg.maxStudies()));
        }
        return out;
    }

    /** 対象日の予約の患者 ID（重複なし）。 */
    List<String> appointments(PrefetchConfig cfg, LocalDate day) throws SourceException {
        if ("mwl".equals(cfg.source())) {
            DicomController.RemoteAeDto ae = remoteAes.list().stream()
                    .filter(a -> a.aeTitle().equals(cfg.mwlAe())).findFirst().orElse(null);
            if (ae == null) {
                throw new SourceException("mwl-ae-not-found");
            }
            try {
                Set<String> ids = new LinkedHashSet<>();
                for (DimseQrService.WorklistEntry e : dimse.findWorklist(ae.host(), ae.port(), ae.aeTitle(),
                        day.format(DA), cfg.mwlStation(), cfg.mwlModality(), ae.tls())) {
                    if (e.patientId() != null && !e.patientId().isBlank()) {
                        ids.add(e.patientId().trim());
                    }
                }
                return new ArrayList<>(ids);
            } catch (IOException e) {
                throw new SourceException("mwl-failed");
            }
        }
        return csvAppointments(cfg, day);
    }

    private List<String> csvAppointments(PrefetchConfig cfg, LocalDate day) throws SourceException {
        Path dir = Path.of(cfg.csvFolder());
        Path newest;
        try (Stream<Path> s = Files.list(dir)) {
            newest = s.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().toLowerCase().endsWith(".csv"))
                    .max(Comparator.comparingLong(p -> p.toFile().lastModified())).orElse(null);
        } catch (IOException | RuntimeException e) {
            throw new SourceException("csv-folder-unreadable");
        }
        if (newest == null) {
            throw new SourceException("csv-not-found");
        }
        String text;
        try {
            Charset cs = "Shift_JIS".equals(cfg.csvCharset()) ? Charset.forName("windows-31j") : Charset.forName("UTF-8");
            text = cs.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(Files.readAllBytes(newest))).toString();
        } catch (CharacterCodingException e) {
            throw new SourceException("csv-charset-mismatch");
        } catch (IOException e) {
            throw new SourceException("csv-unreadable");
        }
        CsvAppointments.Parsed p = CsvAppointments.parse(text, cfg.csvColPatientId(), cfg.csvColDate(), day);
        if (!p.ok()) {
            throw new SourceException(p.error());
        }
        return p.patientIds();
    }

    public List<PrefetchRun> recentRuns() {
        return runs.findTop20ByOrderByIdDesc();
    }

    public List<PrefetchItem> itemsOf(long runId) {
        return items.findTop500ByRunIdOrderByIdAsc(runId);
    }
}

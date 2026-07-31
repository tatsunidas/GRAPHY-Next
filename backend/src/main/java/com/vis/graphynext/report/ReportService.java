/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.dcm4che3.io.DicomOutputStream;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * レポートの CRUD・編集ロック・MainScreen 一覧向け集計・確定（SR/KO 化）を担う
 * （`fw/report-design.md` R1: CRUD、R2: {@link #finalizeReport} の SR 化、R3: KO 生成）。
 *
 * <p>確定は Markdown 本文＋キー画像を Comprehensive SR（{@link SrWriter}）にして既存の取込パイプラインへ
 * ingest し、キー画像があれば続けて Key Object Selection Document（{@link KeyObjectWriter}）も生成・ingest
 * する。参照シリーズの識別情報（患者/スタディ）は同一スタディ内の任意の既存インスタンスから継承する。
 */
@Service
public class ReportService {

    /** 編集ロックの有効期限。これを過ぎたロックは他ユーザーが上書きできる（放置エディタ対策）。 */
    private static final Duration LOCK_TIMEOUT = Duration.ofMinutes(30);

    private final ReportRepository repo;
    private final DicomInstanceRepository dicomInstanceRepo;
    private final DicomStorageService storage;
    private final ObjectProvider<WebDicomDataService> webProvider;
    private final SrWriter srWriter;
    private final KeyObjectWriter keyObjectWriter;

    public ReportService(ReportRepository repo, DicomInstanceRepository dicomInstanceRepo,
            DicomStorageService storage, ObjectProvider<WebDicomDataService> webProvider,
            SrWriter srWriter, KeyObjectWriter keyObjectWriter) {
        this.repo = repo;
        this.dicomInstanceRepo = dicomInstanceRepo;
        this.storage = storage;
        this.webProvider = webProvider;
        this.srWriter = srWriter;
        this.keyObjectWriter = keyObjectWriter;
    }

    @Transactional
    public ReportDto create(CreateReportRequest req) {
        if (req == null || isBlank(req.patientId()) || isBlank(req.studyInstanceUid())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "patientId/studyInstanceUid が必要です");
        }
        Report r = new Report(UUID.randomUUID().toString());
        r.setPatientId(req.patientId());
        r.setStudyInstanceUid(req.studyInstanceUid());
        r.setTitle(req.title());
        r.setReportType(req.reportType() != null ? req.reportType() : ReportType.GENERAL);
        r.setStatus(ReportStatus.DRAFT);
        r.setBodyMarkdown(req.bodyMarkdown() != null ? req.bodyMarkdown() : "");
        r.setClinicalHistory(req.clinicalHistory());
        r.setReferringPhysician(req.referringPhysician());
        Instant now = Instant.now();
        r.setCreatedAt(now);
        r.setUpdatedAt(now);
        return toDto(repo.save(r));
    }

    @Transactional(readOnly = true)
    public List<ReportSummaryDto> listByStudy(String studyUid) {
        return repo.findByStudyInstanceUidOrderByCreatedAtDesc(studyUid).stream().map(ReportService::toSummary).toList();
    }

    @Transactional(readOnly = true)
    public List<ReportSummaryDto> listByPatient(String patientId) {
        return repo.findByPatientIdOrderByCreatedAtDesc(patientId).stream().map(ReportService::toSummary).toList();
    }

    @Transactional(readOnly = true)
    public ReportDto get(String id) {
        return toDto(findOr404(id));
    }

    @Transactional
    public ReportDto update(String id, UpdateReportRequest req) {
        Report r = findOr404(id);
        if (r.getStatus() != ReportStatus.DRAFT) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "確定済みレポートは編集できません");
        }
        requireLockHeldBy(r, req.editedBy());

        if (req.title() != null) {
            r.setTitle(req.title());
        }
        if (req.bodyMarkdown() != null) {
            r.setBodyMarkdown(req.bodyMarkdown());
        }
        if (req.clinicalHistory() != null) {
            r.setClinicalHistory(req.clinicalHistory());
        }
        if (req.referringPhysician() != null) {
            r.setReferringPhysician(req.referringPhysician());
        }
        if (req.participants() != null) {
            r.clearParticipants();
            for (UpdateReportRequest.ParticipantInput p : req.participants()) {
                r.addParticipant(new ReportParticipant(
                        UUID.randomUUID().toString(), p.name(), p.staffRole(), p.participationType(), p.organization()));
            }
        }
        if (req.keyImages() != null) {
            r.clearKeyImages();
            for (UpdateReportRequest.KeyImageInput k : req.keyImages()) {
                r.addKeyImage(new KeyImageRef(
                        UUID.randomUUID().toString(), k.sopInstanceUid(), k.seriesInstanceUid(),
                        k.frameNumber(), k.label(), k.annotation(), k.sortOrder()));
            }
        }
        r.setUpdatedAt(Instant.now());
        return toDto(r);
    }

    @Transactional
    public void delete(String id) {
        Report r = findOr404(id);
        if (r.getStatus() != ReportStatus.DRAFT) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "確定済みレポートは削除できません");
        }
        repo.delete(r);
    }

    @Transactional
    public ReportDto lock(String id, String lockedBy) {
        if (isBlank(lockedBy)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "lockedBy が必要です");
        }
        Report r = findOr404(id);
        requireLockHeldBy(r, lockedBy);
        r.setLockedBy(lockedBy);
        r.setLockedAt(Instant.now());
        return toDto(r);
    }

    @Transactional
    public ReportDto unlock(String id, String lockedBy) {
        Report r = findOr404(id);
        requireLockHeldBy(r, lockedBy);
        r.setLockedBy(null);
        r.setLockedAt(null);
        return toDto(r);
    }

    /**
     * 下書きを Comprehensive SR として確定する。本文またはキー画像のいずれかが必要。
     * 参照シリーズの識別情報はスタディ内の任意の既存インスタンスから継承する。キー画像があれば
     * 続けて KO（Key Object Selection Document）も生成する。
     *
     * <p>保存先はモードで分かれる（{@link #store}）:
     * standalone は既存の取込パイプライン（{@link DicomStorageService#ingest}）、
     * **web は STOW-RS で PACS へ書き戻す**。キー画像の SOPClassUID 解決も同様に分かれる
     * （{@link #resolveKeyImageSopClassUids}）。この 2 つは**独立した別々の対応**で、
     * どちらか片方だけでは web の確定は成立しない（`fw/mobile-ui-design.md` §5）。
     */
    @Transactional
    public ReportDto finalizeReport(String id) throws IOException {
        Report r = findOr404(id);
        if (r.getStatus() != ReportStatus.DRAFT) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "既に確定済みです");
        }
        if (isBlank(r.getBodyMarkdown()) && r.getKeyImages().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "本文またはキー画像が必要です");
        }

        Attributes referenceTemplate = resolveIdentityTemplate(r.getStudyInstanceUid());
        Map<String, String> keyImageSopClassUids = resolveKeyImageSopClassUids(r);

        // SR と（あれば）KO をまとめてから 1 度に保存する。web は STOW-RS を 1 リクエストで送る。
        List<Attributes> outbound = new ArrayList<>(2);

        SrWriter.Result sr = srWriter.build(referenceTemplate, r, keyImageSopClassUids);
        outbound.add(sr.dataset());
        r.setSeriesInstanceUid(sr.seriesInstanceUid());
        r.setSrSopInstanceUid(sr.sopInstanceUid());

        if (!r.getKeyImages().isEmpty()) {
            KeyObjectWriter.Result ko = keyObjectWriter.build(referenceTemplate, r, keyImageSopClassUids);
            outbound.add(ko.dataset());
            r.setKoSeriesInstanceUid(ko.seriesInstanceUid());
            r.setKoSopInstanceUid(ko.sopInstanceUid());
        }

        store(outbound);

        r.setStatus(ReportStatus.FINAL);
        r.setUpdatedAt(Instant.now());
        return toDto(r);
    }

    @Transactional(readOnly = true)
    public List<StudyReportCountDto> studyCounts(List<String> studyUids) {
        if (studyUids == null || studyUids.isEmpty()) {
            return List.of();
        }
        Map<String, long[]> counts = new LinkedHashMap<>();
        for (ReportRepository.StudyReportCountRow row : repo.countByStudy(studyUids)) {
            counts.put(row.getStudyInstanceUid(), new long[] {row.getDraftCount(), row.getFinalCount()});
        }
        List<StudyReportCountDto> out = new ArrayList<>();
        for (String uid : studyUids) {
            long[] c = counts.getOrDefault(uid, new long[] {0L, 0L});
            String state = c[1] > 0 ? "report" : (c[0] > 0 ? "draft" : "none");
            out.add(new StudyReportCountDto(uid, state, c[1], c[0]));
        }
        return out;
    }

    private Report findOr404(String id) {
        return repo.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "report not found: " + id));
    }

    /**
     * スタディ内の任意の既存インスタンスのヘッダを、SR の患者/スタディ識別情報継承テンプレートとして返す
     * （standalone はローカル索引、web は QIDO-RS で先頭シリーズ→WADO-RS metadata、
     * {@code dicom/export/RtStructExportService} と同じ二重対応パターン）。
     */
    private Attributes resolveIdentityTemplate(String studyUid) throws IOException {
        WebDicomDataService web = webProvider.getIfAvailable();
        if (web != null) {
            List<Attributes> series = web.searchSeries(studyUid, Map.of());
            if (!series.isEmpty()) {
                String seriesUid = series.get(0).getString(Tag.SeriesInstanceUID);
                List<Attributes> metas = web.seriesMetadata(studyUid, seriesUid);
                if (!metas.isEmpty()) {
                    return metas.get(0);
                }
            }
            throw new ResponseStatusException(HttpStatus.CONFLICT, "スタディの参照インスタンスが見つかりません: " + studyUid);
        }
        List<Path> files = storage.resolveFiles(studyUid, null);
        if (files.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "スタディの参照インスタンスが見つかりません: " + studyUid);
        }
        return readHeader(files.get(0));
    }

    /**
     * キー画像の SOPClassUID を解決する（SR/KO の参照 SOP Class 記述に要る）。
     *
     * <p>🚨 **web ではローカル H2 索引を引いてはいけない。** 外部 PACS 由来のインスタンスは
     * `dicomInstanceRepo` に存在せず、確定が必ず 409 で失敗する（`fw/report-design.md` の既知事項、
     * `fw/mobile-ui-design.md` §5.1）。web では QIDO-RS で引く。
     * 経路は識別情報の継承（{@link #resolveIdentityTemplate}）と同じ二重対応パターン。
     */
    private Map<String, String> resolveKeyImageSopClassUids(Report r) {
        Map<String, String> out = new LinkedHashMap<>();
        WebDicomDataService web = webProvider.getIfAvailable();
        for (KeyImageRef k : r.getKeyImages()) {
            String sop = k.getSopInstanceUid();
            String cls = web != null
                    ? queryKeyImageSopClass(web, r.getStudyInstanceUid(), k)
                    : dicomInstanceRepo.findById(sop).map(DicomInstance::getSopClassUid).orElse(null);
            if (cls == null || cls.isBlank()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "キー画像が見つかりません: " + sop);
            }
            out.put(sop, cls);
        }
        return out;
    }

    /**
     * QIDO-RS でキー画像 1 枚の SOPClassUID を引く。取れなければ null。
     *
     * <p>シリーズが分かっていればシリーズ配下で絞る（PACS 側の検索が軽い）。分からない場合だけ
     * スタディ配下を横断する。`includefield` で SOPClassUID を明示するのは、既定の返却属性が
     * PACS 実装によって異なるため。
     */
    private static String queryKeyImageSopClass(WebDicomDataService web, String studyUid, KeyImageRef k) {
        String sop = k.getSopInstanceUid();
        Map<String, String> q = Map.of("SOPInstanceUID", sop, "includefield", "00080016");
        List<Attributes> hits;
        try {
            String seriesUid = k.getSeriesInstanceUid();
            hits = seriesUid != null && !seriesUid.isBlank()
                    ? web.searchInstances(studyUid, seriesUid, q)
                    : web.searchStudyInstances(studyUid, q);
        } catch (RuntimeException e) {
            // PACS 未到達・タイムアウトは「見つからない」として扱い、呼び出し側で 409 にする。
            return null;
        }
        return pickSopClassUid(hits, sop);
    }

    /**
     * QIDO 応答から目的の SOPInstanceUID の SOPClassUID を選ぶ。
     *
     * <p>UID 一致を優先する。**一致が無くても 1 件だけなら採用する**のは、QIDO の応答に
     * SOPInstanceUID を含めない PACS があるため（絞り込み条件が効いている前提のフォールバック）。
     * 2 件以上あって一致が無い場合は、どれを指すか決められないので null。
     */
    static String pickSopClassUid(List<Attributes> hits, String sopInstanceUid) {
        if (hits == null || hits.isEmpty()) {
            return null;
        }
        for (Attributes a : hits) {
            if (sopInstanceUid.equals(a.getString(Tag.SOPInstanceUID))) {
                return a.getString(Tag.SOPClassUID);
            }
        }
        return hits.size() == 1 ? hits.get(0).getString(Tag.SOPClassUID) : null;
    }

    private Attributes readHeader(Path p) throws IOException {
        try (DicomInputStream in = new DicomInputStream(p.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            return in.readDataset();
        }
    }

    /**
     * 生成した SR / KO を保存する。
     *
     * <p>🚨 **web では `storage.ingest()` ではなく STOW-RS で PACS へ書き戻す。**
     * ingest 固定だと、生成した SR がローカル H2 にしか無く、web の検査一覧（QIDO）に現れない
     * 「**見えない SR**」になる（`fw/mobile-ui-design.md` §5.1）。
     * 実装は `dicom/derived/DerivedSeriesService` と同型（web はまとめて 1 リクエスト）。
     */
    private void store(List<Attributes> datasets) throws IOException {
        WebDicomDataService web = webProvider.getIfAvailable();
        if (web != null) {
            web.storeDatasets(datasets);
            return;
        }
        for (Attributes a : datasets) {
            ingest(a);
        }
    }

    private void ingest(Attributes attrs) throws IOException {
        Path tmp = Files.createTempFile("sr-", ".dcm");
        boolean consumed = false;
        try {
            Attributes fmi = attrs.createFileMetaInformation(UID.ExplicitVRLittleEndian);
            try (DicomOutputStream dos = new DicomOutputStream(tmp.toFile())) {
                dos.writeDataset(fmi, attrs);
            }
            storage.ingest(tmp);
            consumed = true;
        } finally {
            if (!consumed) {
                Files.deleteIfExists(tmp);
            }
        }
    }

    /** ロックが自分以外・かつ有効期限内なら 409。期限切れロックは上書き可（放置エディタ対策）。 */
    private void requireLockHeldBy(Report r, String who) {
        if (r.getLockedBy() == null || r.getLockedBy().equals(who)) {
            return;
        }
        if (r.getLockedAt() != null && r.getLockedAt().isAfter(Instant.now().minus(LOCK_TIMEOUT))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, r.getLockedBy() + " が編集中です");
        }
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    private static ReportSummaryDto toSummary(Report r) {
        return new ReportSummaryDto(
                r.getId(), r.getPatientId(), r.getStudyInstanceUid(), r.getTitle(), r.getReportType(),
                r.getStatus(), r.getLockedBy(), r.getCreatedAt(), r.getUpdatedAt());
    }

    private static ReportDto toDto(Report r) {
        List<ReportDto.ParticipantDto> participants = r.getParticipants().stream()
                .map(p -> new ReportDto.ParticipantDto(
                        p.getId(), p.getName(), p.getStaffRole(), p.getParticipationType(),
                        p.getOrganization(), p.getParticipatedAt()))
                .toList();
        List<ReportDto.KeyImageDto> keyImages = r.getKeyImages().stream()
                .map(k -> new ReportDto.KeyImageDto(
                        k.getId(), k.getSopInstanceUid(), k.getSeriesInstanceUid(), k.getFrameNumber(),
                        k.getLabel(), k.getAnnotation(), k.getSortOrder()))
                .toList();
        return new ReportDto(
                r.getId(), r.getPatientId(), r.getStudyInstanceUid(), r.getSeriesInstanceUid(), r.getTitle(),
                r.getReportType(), r.getStatus(), r.getBodyMarkdown(), r.getClinicalHistory(),
                r.getReferringPhysician(), r.getSrSopInstanceUid(), r.getKoSopInstanceUid(),
                r.getKoSeriesInstanceUid(), r.getPredecessorReportId(), r.getPredecessorSrSopUid(),
                r.getLockedBy(), r.getLockedAt(), r.getCreatedAt(), r.getUpdatedAt(), participants, keyImages);
    }
}

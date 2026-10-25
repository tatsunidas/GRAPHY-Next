/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/**
 * standalone のローカル DB（H2 索引）管理: 患者一覧/検索・患者情報編集・削除・統計。
 *
 * <p>削除/編集の振る舞いは環境設定で切替（{@code data.deleteFilesOnDisk} /
 * {@code data.applyPatientEditToFiles}）。
 */
@Service
public class DbAdminService {

    private static final Logger log = LoggerFactory.getLogger(DbAdminService.class);

    private final DicomInstanceRepository repo;
    private final SettingsService settings;
    private final DicomStorageService storage;
    private final StorageLayout layout;
    private final PatientRecordMover records;
    /** 計算ジョブの台帳（無い構成では null）。消えたシリーズの UID を台帳から空にする。 */
    private com.vis.graphynext.compute.ComputeJobLedger computeLedger;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setComputeLedger(com.vis.graphynext.compute.ComputeJobLedger computeLedger) {
        this.computeLedger = computeLedger;
    }

    public DbAdminService(DicomInstanceRepository repo, SettingsService settings, DicomStorageService storage,
                          StorageLayout layout, PatientRecordMover records) {
        this.repo = repo;
        this.settings = settings;
        this.storage = storage;
        this.layout = layout;
        this.records = records;
    }

    /** 患者情報の編集の結果。records は ROI などを運んだ／残した件数。 */
    public record EditResult(int updatedInstances, PatientRecordMover.Result records) {
    }

    @Transactional(readOnly = true)
    public List<PatientDto> listPatients(String q) {
        return listPatients(q, false);
    }

    /** onlyMissing: 患者 ID か氏名が空の患者だけ（匿名化で空になった検査を探す）。 */
    @Transactional(readOnly = true)
    public List<PatientDto> listPatients(String q, boolean onlyMissing) {
        String query = (q == null || q.isBlank()) ? null : q;
        return repo.findPatientSummaries(query, onlyMissing).stream()
                .map(p -> new PatientDto(p.getPatientId(), p.getPatientName(), p.getPatientBirthDate(),
                        p.getPatientSex(), p.getNumberOfStudies(), p.getNumberOfInstances()))
                .toList();
    }

    @Transactional(readOnly = true)
    public StatsDto stats() {
        return new StatsDto(
                repo.studyCountByMonth().stream().map(kv -> new StatsDto.Bucket(formatMonth(kv.getK()), kv.getV())).toList(),
                repo.studyCountByModality().stream().map(kv -> new StatsDto.Bucket(orUnknown(kv.getK()), kv.getV())).toList(),
                repo.instanceCountByModality().stream().map(kv -> new StatsDto.Bucket(orUnknown(kv.getK()), kv.getV())).toList(),
                repo.volumeBytesByModality().stream().map(kv -> new StatsDto.Bucket(orUnknown(kv.getK()), kv.getV())).toList());
    }

    /** 削除の結果。related はファイルも消す設定のときに片付けた付随データ（そうでなければ null）。 */
    public record DeleteResult(int deletedInstances, PatientRecordMover.Cleanup related) {
    }

    /** 患者を削除（その患者の全インスタンス）。設定で実ファイルも削除。 */
    @Transactional
    public DeleteResult deletePatient(String patientId) {
        return deleteAll(repo.findByPatientId(patientId));
    }

    /** スタディを削除（その全インスタンス）。設定で実ファイルも削除。 */
    @Transactional
    public DeleteResult deleteStudy(String studyUid) {
        return deleteAll(repo.findByStudyInstanceUid(studyUid));
    }

    /** シリーズを削除（その全インスタンス）。設定で実ファイルも削除。 */
    @Transactional
    public DeleteResult deleteSeries(String studyUid, String seriesUid) {
        return deleteAll(repo.findBySeries(studyUid, seriesUid));
    }

    /** インスタンス（画像）を 1 件削除。設定で実ファイルも削除。study+series で絞ってから SOP 一致を抽出。 */
    @Transactional
    public DeleteResult deleteInstance(String studyUid, String seriesUid, String sopUid) {
        List<DicomInstance> rows = repo.findBySeries(studyUid, seriesUid).stream()
                .filter(r -> sopUid != null && sopUid.equals(r.getSopInstanceUid()))
                .toList();
        return deleteAll(rows);
    }

    /**
     * 行とファイルを消す。ファイルも消す設定のときは、消えた画像に結び付いていた付随データ（ROI など）も片付ける。
     * ファイルを残す設定のときは付随データも残す（残したファイルを取り込み直せば元どおりになる）。
     * 🔴 レポートには触れない（画像とは別に管理し、消すのはレポート機能からだけ）。
     */
    private DeleteResult deleteAll(List<DicomInstance> rows) {
        boolean deleteFiles = boolSetting("data.deleteFilesOnDisk", true);
        for (DicomInstance r : rows) {
            Path file = deleteFiles ? layout.resolveForWrite(r) : null;
            if (file != null) {
                try {
                    Files.deleteIfExists(file);
                    layout.pruneEmptyDirs(file);
                    layout.notifyChanged(file);
                } catch (Exception e) {
                    log.warn("ファイル削除に失敗: {} ({})", r.getUri(), e.toString());
                }
            }
        }
        repo.deleteAll(rows);
        forgetComputeInputs(rows);
        PatientRecordMover.Cleanup related = deleteFiles ? records.afterDelete(rows) : null;
        if (related != null) {
            log.info("削除に伴い付随データを片付けた: {}", related);
        }
        return new DeleteResult(rows.size(), related);
    }

    /** 自動削除の 1 検査ぶんの結果。removed は索引から外した行、failed はファイルを消せず索引に残した行。 */
    public record RetentionDeleteResult(int rows, int removed, int failed, long bytesFreed,
                                        PatientRecordMover.Cleanup cleanup) {
    }

    /**
     * 自動削除: 検査 1 件を消す。{@link #deleteStudy} と違い、<b>ファイルを消せた行だけ</b>索引から外す
     * （消せなかった行は索引に残り、一覧から見えたまま、次の判定でもう一度消そうとする）。
     * 設定 {@code data.deleteFilesOnDisk} に関わらずファイルも消す（目的はディスクを空けること）。
     * ファイル操作は一時的な失敗だけ {@link FileRetry} でやり直す。付随データの片付けも消えた行だけ。
     * 検査ごとに別のトランザクションなので、1 件の失敗が他の検査を巻き込まない。
     */
    @Transactional
    public RetentionDeleteResult deleteStudyForRetention(String studyUid) {
        List<DicomInstance> rows = repo.findByStudyInstanceUid(studyUid);
        List<DicomInstance> removed = new ArrayList<>();
        int failed = 0;
        long freed = 0;
        for (DicomInstance r : rows) {
            try {
                Path file = layout.resolveForWrite(r);
                if (file != null) {
                    final Path f = file;
                    fileRetry.run("自動削除のファイル削除", f, () -> Files.deleteIfExists(f));
                    layout.pruneEmptyDirs(f);
                    layout.notifyChanged(f);
                }
                removed.add(r);
                freed += r.getSizeBytes() == null ? 0 : r.getSizeBytes();
            } catch (IOException | RuntimeException e) {
                failed++;
                log.warn("自動削除: ファイルを消せなかったので索引に残す: study={} ({})", studyUid, e.toString());
            }
        }
        PatientRecordMover.Cleanup cleanup = null;
        if (!removed.isEmpty()) {
            repo.deleteAll(removed);
            forgetComputeInputs(removed);
            cleanup = records.afterDelete(removed);
        }
        return new RetentionDeleteResult(rows.size(), removed.size(), failed, freed, cleanup);
    }

    /**
     * 保管庫からシリーズが無くなったら、計算ジョブの台帳の入力の UID を空にする（行は「削除済み・再実行不可」になる）。
     * ファイルを残す設定でも、索引から消えたものは保管庫から見えないので同じ扱い。台帳の不具合で削除を失敗させない。
     */
    private void forgetComputeInputs(List<DicomInstance> rows) {
        if (computeLedger == null) {
            return;
        }
        try {
            java.util.Set<String> gone = new java.util.LinkedHashSet<>();
            for (DicomInstance r : rows) {
                if (r.getSeriesInstanceUid() != null
                        && repo.findBySeries(r.getStudyInstanceUid(), r.getSeriesInstanceUid()).isEmpty()) {
                    gone.add(r.getSeriesInstanceUid());
                }
            }
            computeLedger.clearSeries(gone);
        } catch (RuntimeException e) {
            log.warn("計算ジョブの台帳から削除したシリーズの UID を外せなかった: {}", e.toString());
        }
    }

    /**
     * 患者情報（患者レベル）を編集。設定 {@code data.applyPatientEditToFiles} が ON のとき、
     * 該当患者の全 DICOM ファイルのタグも書き換える。
     *
     * @param newPatientId 患者 ID を変更する場合に指定（null/空で据え置き）
     */
    @Transactional
    public EditResult updatePatient(String patientId, String patientName, String birthDate, String sex,
                                    String newPatientId) {
        boolean changeId = newPatientId != null && !newPatientId.isBlank() && !newPatientId.equals(patientId);
        List<DicomInstance> rows = repo.findByPatientId(patientId);
        var before = PatientRecordMover.keysBefore(rows);
        int n = applyPatientEdit(rows, patientName, birthDate, sex, changeId ? newPatientId : null);
        var moved = records.afterEdit(rows, before, changeId ? newPatientId : null);
        log.info("患者情報を更新(患者全体): {} -> name={}, id変更={} ({}件) 記録: {}", patientId, patientName, changeId, n, moved);
        return new EditResult(n, moved);
    }

    /**
     * <b>スタディ単位</b>の患者情報編集。対象はそのスタディの instance のみ。
     *
     * <p>患者は instance の PatientID の GROUP BY で導出されるため、PatientID を変更すると
     * そのスタディは<b>別患者へ移動</b>し、編集元患者からは自動的に外れる（編集元が 0 件になれば
     * 一覧から消える＝患者レコード削除に相当）。
     */
    @Transactional
    public EditResult updateStudyPatient(String studyUid, String patientName, String birthDate, String sex,
                                         String newPatientId) {
        List<DicomInstance> rows = repo.findByStudyInstanceUid(studyUid);
        String oldId = rows.isEmpty() ? "" : rows.get(0).getPatientId();
        boolean changeId = newPatientId != null && !newPatientId.isBlank() && !newPatientId.equals(oldId);
        var before = PatientRecordMover.keysBefore(rows);
        int n = applyPatientEdit(rows, patientName, birthDate, sex, changeId ? newPatientId : null);
        var moved = records.afterEdit(rows, before, changeId ? newPatientId : null);
        log.info("患者情報を更新(スタディ単位): study={} {} -> name={}, id変更={} ({}件) 記録: {}",
                studyUid, oldId, patientName, changeId, n, moved);
        return new EditResult(n, moved);
    }

    /** シリーズ統合の結果（移動できた件数・失敗件数・統合先 SeriesInstanceUID）。 */
    public record MergeResult(int moved, int failed, String seriesInstanceUid) {}

    /**
     * 同一スタディ内の複数シリーズを 1 つに統合する（N→1）。
     *
     * <p>対象は {@code studyUid} に属する {@code sourceSeriesUids} の全インスタンス。統合先
     * SeriesInstanceUID は {@code targetSeriesUid}（空なら新規採番）。InstanceNumber は
     * {@code (元 SeriesNumber, 元 InstanceNumber)} 順で <b>1..N に振り直す</b>。SOPInstanceUID/
     * StudyInstanceUID は不変。各ファイルは SeriesInstanceUID 等を書換え、新シリーズのパスへ移動する
     * （UID がファイル内にあるためファイル書換は必須）。
     */
    @Transactional
    public MergeResult mergeSeries(String studyUid, List<String> sourceSeriesUids, String targetSeriesUid,
                                   Integer targetSeriesNumber, String targetSeriesDescription) {
        if (studyUid == null || studyUid.isBlank() || sourceSeriesUids == null || sourceSeriesUids.isEmpty()) {
            throw new IllegalArgumentException("studyUid と sourceSeriesUids は必須です");
        }
        // 収集（findBySeries は study+series 絞り込みのため、自動的に同一スタディ内に限定される）
        List<DicomInstance> all = new ArrayList<>();
        for (String src : sourceSeriesUids) {
            if (src != null && !src.isBlank()) {
                all.addAll(repo.findBySeries(studyUid, src));
            }
        }
        if (all.isEmpty()) {
            throw new IllegalArgumentException("統合対象のインスタンスがありません");
        }
        all.sort(Comparator
                .comparingInt((DicomInstance i) -> i.getSeriesNumber() == null ? 0 : i.getSeriesNumber())
                .thenComparingInt(i -> i.getInstanceNumber() == null ? 0 : i.getInstanceNumber()));

        String newSeriesUid = (targetSeriesUid != null && !targetSeriesUid.isBlank())
                ? targetSeriesUid.trim() : UIDUtils.createUID();
        Integer seriesNumber = targetSeriesNumber != null ? targetSeriesNumber
                : (all.get(0).getSeriesNumber() != null ? all.get(0).getSeriesNumber() : 1);
        String seriesDesc = (targetSeriesDescription != null && !targetSeriesDescription.isBlank())
                ? targetSeriesDescription : all.get(0).getSeriesDescription();

        int moved = 0;
        int failed = 0;
        for (DicomInstance r : all) {
            int instanceNumber = moved + 1; // 成功ごとに 1..N（失敗時は同番号を次へ）
            try {
                relocateInstance(r, studyUid, newSeriesUid, seriesNumber, seriesDesc, instanceNumber);
                moved++;
            } catch (Exception e) {
                failed++;
                log.warn("シリーズ統合の書換に失敗: sop={} ({})", r.getSopInstanceUid(), e.toString());
            }
        }
        log.info("シリーズ統合: study={} sources={} -> series={} (moved={}, failed={})",
                studyUid, sourceSeriesUids, newSeriesUid, moved, failed);
        return new MergeResult(moved, failed, newSeriesUid);
    }

    /** シリーズ分割の 1 群（対象 SOP と、その群に与える SeriesNumber/Description）。 */
    public record SplitGroup(List<String> sopInstanceUids, Integer seriesNumber, String seriesDescription) {}

    /** シリーズ分割の結果。 */
    public record SplitResult(int groupsCreated, int moved, int failed, List<String> newSeriesUids) {}

    /**
     * 同一スタディ内の 1 シリーズを、手動選択した群ごとに新シリーズへ分割する（1→N）。
     *
     * <p>各群は新規 SeriesInstanceUID へ移動する。<b>InstanceNumber は保持</b>（群は部分集合）。
     * どの群にも入らないインスタンスは元シリーズに残る。SOPInstanceUID/StudyInstanceUID は不変。
     * 新シリーズの SeriesNumber は指定が無ければ「スタディ内の最大＋連番」を自動採番。
     */
    @Transactional
    public SplitResult splitSeries(String studyUid, String seriesUid, List<SplitGroup> groups) {
        if (studyUid == null || studyUid.isBlank() || seriesUid == null || seriesUid.isBlank()
                || groups == null || groups.isEmpty()) {
            throw new IllegalArgumentException("studyUid / seriesUid / groups は必須です");
        }
        java.util.Map<String, DicomInstance> bySop = new java.util.HashMap<>();
        String origDesc = null;
        for (DicomInstance r : repo.findBySeries(studyUid, seriesUid)) {
            bySop.put(r.getSopInstanceUid(), r);
            if (origDesc == null) {
                origDesc = r.getSeriesDescription();
            }
        }
        if (bySop.isEmpty()) {
            throw new IllegalArgumentException("分割対象のシリーズにインスタンスがありません");
        }
        // 同一 SOP が複数群に跨る指定は不正
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (SplitGroup g : groups) {
            for (String sop : g.sopInstanceUids() == null ? List.<String>of() : g.sopInstanceUids()) {
                if (!seen.add(sop)) {
                    throw new IllegalArgumentException("同一インスタンスが複数の群に指定されています: " + sop);
                }
            }
        }

        int nextNum = maxSeriesNumber(studyUid);
        int moved = 0;
        int failed = 0;
        int gi = 0;
        List<String> newUids = new ArrayList<>();
        for (SplitGroup g : groups) {
            gi++;
            List<String> sops = g.sopInstanceUids() == null ? List.<String>of() : g.sopInstanceUids();
            if (sops.isEmpty()) {
                continue;
            }
            String newSeriesUid = UIDUtils.createUID();
            Integer seriesNumber = g.seriesNumber() != null ? g.seriesNumber() : (++nextNum);
            String desc = (g.seriesDescription() != null && !g.seriesDescription().isBlank())
                    ? g.seriesDescription()
                    : ((origDesc == null ? "Series" : origDesc) + " (" + gi + ")");
            boolean anyMoved = false;
            for (String sop : sops) {
                DicomInstance r = bySop.get(sop);
                if (r == null) {
                    continue; // このシリーズに無い SOP は無視
                }
                try {
                    relocateInstance(r, studyUid, newSeriesUid, seriesNumber, desc, null); // InstanceNumber 保持
                    moved++;
                    anyMoved = true;
                } catch (Exception e) {
                    failed++;
                    log.warn("シリーズ分割の書換に失敗: sop={} ({})", sop, e.toString());
                }
            }
            if (anyMoved) {
                newUids.add(newSeriesUid);
            }
        }
        log.info("シリーズ分割: study={} series={} -> {} 群 (moved={}, failed={})",
                studyUid, seriesUid, newUids.size(), moved, failed);
        return new SplitResult(newUids.size(), moved, failed, newUids);
    }

    /** スタディ内の既存 SeriesNumber の最大値（無ければ 0）。 */
    private int maxSeriesNumber(String studyUid) {
        int max = 0;
        for (var s : repo.findSeriesSummaries(studyUid)) {
            Integer n = s.getSeriesNumber();
            if (n != null && n > max) {
                max = n;
            }
        }
        return max;
    }

    /** 1 インスタンスを別シリーズへ移す（ファイル書換＋移動＋索引更新）。失敗は例外で通知。 */
    private void relocateInstance(DicomInstance r, String studyUid, String newSeriesUid, Integer seriesNumber,
                                  String seriesDesc, Integer instanceNumber) throws IOException {
        Path orig = layout.resolveForWrite(r);
        if (orig == null) {
            throw new IOException("保管庫内のファイルを特定できません: " + r.getSopInstanceUid());
        }
        layout.resolveForRead(r); // モード A: 手元に無ければ取り寄せる（取れなければ例外）
        Path dest = storage.instanceStoragePath(studyUid, newSeriesUid, r.getSopInstanceUid());
        Files.createDirectories(dest.getParent());
        Path tmp = Files.createTempFile(dest.getParent(), "reloc-", ".tmp");
        rewriteSeriesToTemp(orig, tmp, newSeriesUid, seriesNumber, seriesDesc, instanceNumber);
        Files.move(tmp, dest, StandardCopyOption.REPLACE_EXISTING);
        if (!dest.equals(orig)) {
            Files.deleteIfExists(orig);
            layout.pruneEmptyDirs(orig);
            layout.notifyChanged(orig);
        }
        r.setSeriesInstanceUid(newSeriesUid);
        if (seriesNumber != null) {
            r.setSeriesNumber(seriesNumber);
        }
        if (seriesDesc != null) {
            r.setSeriesDescription(seriesDesc);
        }
        if (instanceNumber != null) {
            r.setInstanceNumber(instanceNumber);
        }
        r.setUri(layout.toStored(dest));
        repo.save(r);
    }

    /** src を読み、シリーズレベルのタグ（＋InstanceNumber）を書き換えて tmp へ書き出す（pixel はファイル参照）。 */
    private static void rewriteSeriesToTemp(Path src, Path tmp, String seriesUid, Integer seriesNumber,
                                            String seriesDescription, Integer instanceNumber) throws IOException {
        Attributes fmi;
        Attributes ds;
        try (DicomInputStream in = new DicomInputStream(src.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.URI);
            fmi = in.readFileMetaInformation();
            ds = in.readDataset();
        }
        ds.setString(Tag.SeriesInstanceUID, VR.UI, seriesUid);
        if (seriesNumber != null) {
            ds.setInt(Tag.SeriesNumber, VR.IS, seriesNumber);
        }
        if (seriesDescription != null) {
            ds.setString(Tag.SeriesDescription, VR.LO, seriesDescription);
        }
        if (instanceNumber != null) {
            ds.setInt(Tag.InstanceNumber, VR.IS, instanceNumber);
        }
        try (DicomOutputStream out = new DicomOutputStream(tmp.toFile())) {
            out.writeDataset(fmi, ds);
        }
    }

    private final FileRetry fileRetry = new FileRetry();

    /**
     * 患者レベルのタグ編集を rows へ適用（設定 ON でファイルも書換）。newId 非 null で PatientID 変更。
     *
     * <p><b>全か無か</b>: ファイルの書き換えが 1 つでも失敗したら、編集全体を失敗にして、ファイルも索引も編集前のままにする
     * （一部だけ古いタグのまま索引だけ新しい、という食い違いを残さない）。{@link DicomFileEdit} を参照。
     */
    private int applyPatientEdit(List<DicomInstance> rows, String patientName, String birthDate, String sex,
                                 String newId) {
        boolean applyToFiles = boolSetting("data.applyPatientEditToFiles", true);
        DicomFileEdit edit = applyToFiles ? prepareFileEdit(rows, patientName, birthDate, sex, newId) : null;
        try {
            for (DicomInstance r : rows) {
                r.setPatientName(patientName);
                r.setPatientBirthDate(birthDate);
                r.setPatientSex(sex);
                if (newId != null) {
                    r.setPatientId(newId);
                }
                repo.save(r);
            }
        } catch (RuntimeException e) {
            if (edit != null) {
                edit.rollback();
            }
            throw e;
        }
        if (edit != null) {
            settleWithTransaction(edit);
        }
        return rows.size();
    }

    /**
     * 準備（取り寄せ・一時ファイルの作成。DB にはまだ何も書かない）→ 入れ替え。失敗は {@code 409}（編集全体が取り消される）。
     * 遅い処理（Drive からの取り寄せ・リトライの待ち）はここで済ませ、DB への書き込みを最後に短く行う。
     */
    private DicomFileEdit prepareFileEdit(List<DicomInstance> rows, String patientName, String birthDate, String sex,
                                            String newId) {
        layout.prefetch(rows, () -> false); // モード A: 手元に無いものを先に取り寄せる（失敗は例外＝何も変えずに中止）
        List<DicomFileEdit.Target> targets = new ArrayList<>();
        for (DicomInstance r : rows) {
            Path file = layout.resolveForWrite(r);
            if (file == null) {
                continue;
            }
            if (Files.isRegularFile(file)) {
                targets.add(new DicomFileEdit.Target(r.getSopInstanceUid(), file));
            } else {
                // 索引にあるが実ファイルが無い（書き換える物が無いので食い違いは生じない）。従来どおり警告だけ
                log.warn("DICOM ファイルが無いため書換を省略: sop={}", r.getSopInstanceUid());
            }
        }
        if (targets.isEmpty()) {
            return null;
        }
        try {
            DicomFileEdit edit = DicomFileEdit.prepare(targets,
                    (src, dst) -> writeRewritten(src, dst, patientName, birthDate, sex, newId),
                    layout.root().resolve(".edit-journal"), fileRetry, DicomFileEdit.Ops.REAL);
            edit.swap();
            // 変更を Drive 同期へ通知する（コミットされたときだけ届く。ロールバックなら破棄される）
            edit.files().forEach(layout::notifyChanged);
            return edit;
        } catch (DicomFileEdit.EditFailedException e) {
            log.warn("患者編集を中止（ファイル・索引は編集前のまま）: {}", e.getMessage());
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.CONFLICT, e.getMessage(), e);
        }
    }

    /** 取引の結果で、確定（退避を消す）か巻き戻し（退避から戻す）。コミット時の失敗もここで拾える。 */
    static void settleWithTransaction(DicomFileEdit edit) {
        if (org.springframework.transaction.support.TransactionSynchronizationManager.isSynchronizationActive()) {
            org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(
                    new org.springframework.transaction.support.TransactionSynchronization() {
                        @Override
                        public void afterCompletion(int status) {
                            if (status == STATUS_COMMITTED) {
                                edit.commit();
                            } else {
                                edit.rollback();
                            }
                        }
                    });
        } else {
            edit.commit();
        }
    }

    /** {@code source} を読み、患者タグを書き換えた内容を {@code target} へ書く（元は変えない）。 */
    static void writeRewritten(Path source, Path target, String name, String birthDate, String sex, String newId)
            throws IOException {
        Attributes fmi;
        Attributes ds;
        try (DicomInputStream in = new DicomInputStream(source.toFile())) {
            // ピクセル等の bulk data はヒープに載せずファイル参照のまま扱う（メモリ削減）。
            // 書込先は別ファイルなので、書込時に元ファイルから bulk をコピーできる。
            in.setIncludeBulkData(IncludeBulkData.URI);
            fmi = in.readFileMetaInformation();
            ds = in.readDataset();
        }
        ds.setString(Tag.PatientName, VR.PN, name == null ? "" : name);
        if (birthDate != null) {
            ds.setString(Tag.PatientBirthDate, VR.DA, birthDate);
        }
        if (sex != null) {
            ds.setString(Tag.PatientSex, VR.CS, sex);
        }
        if (newId != null) {
            ds.setString(Tag.PatientID, VR.LO, newId);
        }
        try (DicomOutputStream out = new DicomOutputStream(target.toFile())) {
            out.writeDataset(fmi, ds);
        }
    }

    private boolean boolSetting(String key, boolean def) {
        Map<String, String> all = settings.getAll();
        String v = all.get(key);
        return v == null ? def : "true".equalsIgnoreCase(v);
    }

    private static String formatMonth(String yyyymm) {
        if (yyyymm == null || yyyymm.length() < 6) {
            return yyyymm;
        }
        return yyyymm.substring(0, 4) + "-" + yyyymm.substring(4, 6);
    }

    private static String orUnknown(String s) {
        return (s == null || s.isBlank()) ? "(不明)" : s;
    }
}

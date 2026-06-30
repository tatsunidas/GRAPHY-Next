/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
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
import java.net.URI;
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

    public DbAdminService(DicomInstanceRepository repo, SettingsService settings, DicomStorageService storage) {
        this.repo = repo;
        this.settings = settings;
        this.storage = storage;
    }

    @Transactional(readOnly = true)
    public List<PatientDto> listPatients(String q) {
        String query = (q == null || q.isBlank()) ? null : q;
        return repo.findPatientSummaries(query).stream()
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

    /** 患者を削除（その患者の全インスタンス）。設定で実ファイルも削除。 */
    @Transactional
    public int deletePatient(String patientId) {
        return deleteAll(repo.findByPatientId(patientId));
    }

    /** スタディを削除（その全インスタンス）。設定で実ファイルも削除。 */
    @Transactional
    public int deleteStudy(String studyUid) {
        return deleteAll(repo.findByStudyInstanceUid(studyUid));
    }

    /** シリーズを削除（その全インスタンス）。設定で実ファイルも削除。 */
    @Transactional
    public int deleteSeries(String studyUid, String seriesUid) {
        return deleteAll(repo.findBySeries(studyUid, seriesUid));
    }

    private int deleteAll(List<DicomInstance> rows) {
        boolean deleteFiles = boolSetting("data.deleteFilesOnDisk", true);
        for (DicomInstance r : rows) {
            if (deleteFiles && r.getUri() != null) {
                try {
                    Files.deleteIfExists(Path.of(URI.create(r.getUri())));
                } catch (Exception e) {
                    log.warn("ファイル削除に失敗: {} ({})", r.getUri(), e.toString());
                }
            }
        }
        repo.deleteAll(rows);
        return rows.size();
    }

    /**
     * 患者情報（患者レベル）を編集。設定 {@code data.applyPatientEditToFiles} が ON のとき、
     * 該当患者の全 DICOM ファイルのタグも書き換える。
     *
     * @param newPatientId 患者 ID を変更する場合に指定（null/空で据え置き）
     */
    @Transactional
    public int updatePatient(String patientId, String patientName, String birthDate, String sex,
                             String newPatientId) {
        boolean changeId = newPatientId != null && !newPatientId.isBlank() && !newPatientId.equals(patientId);
        int n = applyPatientEdit(repo.findByPatientId(patientId), patientName, birthDate, sex, changeId ? newPatientId : null);
        log.info("患者情報を更新(患者全体): {} -> name={}, id変更={} ({}件)", patientId, patientName, changeId, n);
        return n;
    }

    /**
     * <b>スタディ単位</b>の患者情報編集。対象はそのスタディの instance のみ。
     *
     * <p>患者は instance の PatientID の GROUP BY で導出されるため、PatientID を変更すると
     * そのスタディは<b>別患者へ移動</b>し、編集元患者からは自動的に外れる（編集元が 0 件になれば
     * 一覧から消える＝患者レコード削除に相当）。
     */
    @Transactional
    public int updateStudyPatient(String studyUid, String patientName, String birthDate, String sex,
                                  String newPatientId) {
        List<DicomInstance> rows = repo.findByStudyInstanceUid(studyUid);
        String oldId = rows.isEmpty() ? "" : rows.get(0).getPatientId();
        boolean changeId = newPatientId != null && !newPatientId.isBlank() && !newPatientId.equals(oldId);
        int n = applyPatientEdit(rows, patientName, birthDate, sex, changeId ? newPatientId : null);
        log.info("患者情報を更新(スタディ単位): study={} {} -> name={}, id変更={} ({}件)",
                studyUid, oldId, patientName, changeId, n);
        return n;
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
        Path orig = Path.of(URI.create(r.getUri()));
        Path dest = storage.instanceStoragePath(studyUid, newSeriesUid, r.getSopInstanceUid());
        Files.createDirectories(dest.getParent());
        Path tmp = Files.createTempFile(dest.getParent(), "reloc-", ".tmp");
        rewriteSeriesToTemp(orig, tmp, newSeriesUid, seriesNumber, seriesDesc, instanceNumber);
        Files.move(tmp, dest, StandardCopyOption.REPLACE_EXISTING);
        if (!dest.equals(orig)) {
            Files.deleteIfExists(orig);
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
        r.setUri(dest.toUri().toString());
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

    /** 患者レベルのタグ編集を rows へ適用（設定 ON でファイルも書換）。newId 非 null で PatientID 変更。 */
    private int applyPatientEdit(List<DicomInstance> rows, String patientName, String birthDate, String sex,
                                 String newId) {
        boolean applyToFiles = boolSetting("data.applyPatientEditToFiles", true);
        for (DicomInstance r : rows) {
            if (applyToFiles && r.getUri() != null) {
                try {
                    rewriteFile(Path.of(URI.create(r.getUri())), patientName, birthDate, sex, newId);
                } catch (Exception e) {
                    log.warn("DICOM ファイルの書換に失敗: {} ({})", r.getUri(), e.toString());
                }
            }
            r.setPatientName(patientName);
            r.setPatientBirthDate(birthDate);
            r.setPatientSex(sex);
            if (newId != null) {
                r.setPatientId(newId);
            }
            repo.save(r);
        }
        return rows.size();
    }

    private static void rewriteFile(Path file, String name, String birthDate, String sex, String newId)
            throws IOException {
        Attributes fmi;
        Attributes ds;
        try (DicomInputStream in = new DicomInputStream(file.toFile())) {
            // ピクセル等の bulk data はヒープに載せずファイル参照のまま扱う（メモリ削減）。
            // 書込先は別ファイル(temp)なので、書込時に元ファイルから bulk をコピーできる。
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
        Path tmp = Files.createTempFile(file.getParent(), "rewrite-", ".tmp");
        try (DicomOutputStream out = new DicomOutputStream(tmp.toFile())) {
            out.writeDataset(fmi, ds);
        }
        Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
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

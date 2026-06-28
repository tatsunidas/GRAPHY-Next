package com.vis.graphynext.dbadmin;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
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

    public DbAdminService(DicomInstanceRepository repo, SettingsService settings) {
        this.repo = repo;
        this.settings = settings;
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
        List<DicomInstance> rows = repo.findByPatientId(patientId);
        boolean applyToFiles = boolSetting("data.applyPatientEditToFiles", true);
        boolean changeId = newPatientId != null && !newPatientId.isBlank() && !newPatientId.equals(patientId);

        for (DicomInstance r : rows) {
            if (applyToFiles && r.getUri() != null) {
                try {
                    rewriteFile(Path.of(URI.create(r.getUri())), patientName, birthDate, sex,
                            changeId ? newPatientId : null);
                } catch (Exception e) {
                    log.warn("DICOM ファイルの書換に失敗: {} ({})", r.getUri(), e.toString());
                }
            }
            r.setPatientName(patientName);
            r.setPatientBirthDate(birthDate);
            r.setPatientSex(sex);
            if (changeId) {
                r.setPatientId(newPatientId);
            }
            repo.save(r);
        }
        log.info("患者情報を更新: {} -> name={}, id変更={}", patientId, patientName, changeId);
        return rows.size();
    }

    private static void rewriteFile(Path file, String name, String birthDate, String sex, String newId)
            throws IOException {
        Attributes fmi;
        Attributes ds;
        try (DicomInputStream in = new DicomInputStream(file.toFile())) {
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

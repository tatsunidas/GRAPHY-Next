package com.vis.graphynext.dicom.store;

import com.vis.graphynext.dicom.DicomProperties;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.List;

/**
 * ローカル保管庫（FS）＋索引（H2）への取り込みと検索。
 *
 * <p>設計方針:
 * <ol>
 *   <li>保存と索引を 1 トランザクションに。索引書き込みに失敗したら例外でロールバックし、
 *       置いたファイルも削除して<b>孤児ファイルを残さない</b>（GRAPHY の C-STORE 不整合を回避）。</li>
 *   <li>主キー=SOPInstanceUID により再受信は upsert で<b>冪等</b>。</li>
 *   <li>検索はリポジトリの 1 クエリに委譲。</li>
 *   <li>索引には FS ファイルへの {@code file:} URI を保持。</li>
 * </ol>
 */
@Service
public class DicomStorageService {

    private static final Logger log = LoggerFactory.getLogger(DicomStorageService.class);

    private final DicomInstanceRepository repo;
    private final Path storageDir;

    public DicomStorageService(DicomInstanceRepository repo, DicomProperties props) {
        this.repo = repo;
        this.storageDir = Paths.get(props.getStorageDir());
    }

    /**
     * 一時 DICOM Part-10 ファイルを取り込む（メタデータ解析 → 正規パスへ移動 → 索引登録）。
     * 成功時、一時ファイルは正規パスへ移動済み（残らない）。
     */
    @Transactional
    public DicomInstance ingest(Path tempFile) throws IOException {
        Attributes fmi;
        Attributes ds;
        try (DicomInputStream in = new DicomInputStream(tempFile.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            fmi = in.readFileMetaInformation();
            ds = in.readDatasetUntilPixelData();
        }

        String iuid = value(fmi, Tag.MediaStorageSOPInstanceUID, ds, Tag.SOPInstanceUID);
        String cuid = value(fmi, Tag.MediaStorageSOPClassUID, ds, Tag.SOPClassUID);
        String tsuid = fmi != null ? fmi.getString(Tag.TransferSyntaxUID) : UID.ExplicitVRLittleEndian;
        String patientId = ds.getString(Tag.PatientID, "");
        String studyUid = ds.getString(Tag.StudyInstanceUID);
        String seriesUid = ds.getString(Tag.SeriesInstanceUID);

        if (iuid == null || studyUid == null || seriesUid == null) {
            throw new IOException("必須 UID が欠落しています (sop=" + iuid + ", study=" + studyUid + ", series=" + seriesUid + ")");
        }

        Path dest = storageDir.resolve(Paths.get(studyUid, seriesUid, iuid + ".dcm"));
        Files.createDirectories(dest.getParent());
        // 冪等: 同一 SOPInstanceUID の再受信は上書き
        Files.move(tempFile, dest, StandardCopyOption.REPLACE_EXISTING);

        DicomInstance entity = new DicomInstance(iuid, cuid, tsuid, patientId, studyUid, seriesUid,
                dest.toUri().toString());
        try {
            DicomInstance saved = repo.save(entity);
            log.info("INDEXED sop={} study={} -> {}", iuid, studyUid, dest);
            return saved;
        } catch (RuntimeException ex) {
            // 索引に載らないファイルを残さない（トランザクションはロールバックされる）
            try {
                Files.deleteIfExists(dest);
            } catch (IOException ignore) {
                // ベストエフォート
            }
            log.warn("INDEX failed, rolled back and deleted file: {}", dest, ex);
            throw ex;
        }
    }

    @Transactional(readOnly = true)
    public List<DicomInstance> findMatches(String patientId, String studyUid, String seriesUid, String sopUid) {
        return repo.findMatches(patientId, studyUid, seriesUid, sopUid);
    }

    private static String value(Attributes fmi, int fmiTag, Attributes ds, int dsTag) {
        if (fmi != null) {
            String v = fmi.getString(fmiTag);
            if (v != null) {
                return v;
            }
        }
        return ds.getString(dsTag);
    }
}

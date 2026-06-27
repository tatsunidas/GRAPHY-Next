package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.UID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

/**
 * P0-5（方針①の安全性）: 索引書き込みが失敗したとき、保存したファイルを残さない。
 *
 * <p>リポジトリの save が例外を投げるよう差し替え、ingest が例外を再送出しつつ
 * 置いたファイルを削除する（孤児ファイルゼロ）ことを検証する。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:rollbackit;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class DicomStorageRollbackTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @MockBean
    DicomInstanceRepository repo;

    @Autowired
    DicomStorageService storage;

    @Test
    void indexFailure_rollsBack_noOrphanFile() throws Exception {
        when(repo.save(any(DicomInstance.class)))
                .thenThrow(new RuntimeException("simulated index failure"));

        Attributes ds = DicomPhantomFactory.scImage("PIDX", "1.2.studyX", "1.2.seriesX", "1.2.sopX");
        Path file = DicomPhantomFactory.writeFile(
                Files.createTempFile("phantom", ".dcm"), ds, UID.ExplicitVRLittleEndian);

        // 索引失敗は呼び出し側に伝播しなければならない
        assertThrows(RuntimeException.class, () -> storage.ingest(file));

        // 孤児ファイルが残ってはいけない（方針①）
        Path dest = tmp.resolve("store").resolve("1.2.studyX").resolve("1.2.seriesX").resolve("1.2.sopX.dcm");
        assertFalse(Files.exists(dest), "索引失敗時に保存ファイルが残ってはいけない");
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.StorageLayout;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * 「枚数」= フレーム総数の集計。XA のように 1 インスタンスに複数フレームが入るシリーズで、
 * SOP 数ではなくフレーム数が出ること、NumberOfFrames が未取得の行があれば合計を出さない（不明）こと、
 * 起動時の埋め直しで取得できること、読めない行は null のまま残ることを確かめる。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:framesit;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class NumberOfFramesTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DicomStorageService storage;

    @Autowired
    DicomInstanceRepository repo;

    @Autowired
    StorageLayout layout;

    private static Attributes shots(String study, String series, String sop, int instanceNumber, Integer frames) {
        Attributes a = DicomPhantomFactory.scImage("PF", study, series, sop);
        a.setInt(Tag.InstanceNumber, VR.IS, instanceNumber);
        if (frames != null) {
            a.setInt(Tag.NumberOfFrames, VR.IS, frames);
        }
        return a;
    }

    private void ingest(Attributes ds) throws Exception {
        Path f = Files.createTempFile("frames", ".dcm");
        storage.ingest(DicomPhantomFactory.writeFile(f, ds, UID.ExplicitVRLittleEndian));
    }

    /** 1 検査: シリーズ A は 2 ショット（89 + 93 フレーム）、シリーズ B は単一フレーム 1 枚。 */
    private void ingestTwoShotStudy(String study) throws Exception {
        ingest(shots(study, study + ".A", study + ".A1", 7, 89));
        ingest(shots(study, study + ".A", study + ".A2", 8, 93));
        ingest(shots(study, study + ".B", study + ".B1", 1, null));
    }

    private Long seriesFrames(String study, String series) {
        return storage.listSeries(study).stream()
                .filter(s -> series.equals(s.seriesInstanceUid())).findFirst().orElseThrow().numberOfFrames();
    }

    private long seriesInstances(String study, String series) {
        return storage.listSeries(study).stream()
                .filter(s -> series.equals(s.seriesInstanceUid())).findFirst().orElseThrow().numberOfInstances();
    }

    private Long studyFrames(String study) {
        return storage.listStudies().stream()
                .filter(s -> study.equals(s.studyInstanceUid())).findFirst().orElseThrow().numberOfFrames();
    }

    @Test
    void framesAreSummed_whileInstanceCountStaysTheSopCount() throws Exception {
        String st = "1.9.frames.sum";
        ingestTwoShotStudy(st);

        assertEquals(2, seriesInstances(st, st + ".A"), "SOP 数は 2 のまま");
        assertEquals(182L, seriesFrames(st, st + ".A"), "89 + 93 フレーム");
        assertEquals(1L, seriesFrames(st, st + ".B"), "NumberOfFrames の無い単一フレームは 1");
        assertEquals(183L, studyFrames(st), "検査の合計");
    }

    @Test
    void unknownFrames_giveNullNotAPartialSum_andBackfillRestoresThem() throws Exception {
        String st = "1.9.frames.backfill";
        ingestTwoShotStudy(st);

        // この列を足す前に取り込んだ行を再現する（NumberOfFrames が null）。
        DicomInstance old = repo.findById(st + ".A2").orElseThrow();
        old.setNumberOfFrames(null);
        repo.save(old);

        assertNull(seriesFrames(st, st + ".A"), "1 行でも未取得なら合計は不明（89 だけ足して出さない）");
        assertNull(studyFrames(st), "検査の合計も不明");
        assertEquals(2, seriesInstances(st, st + ".A"), "SOP 数は影響を受けない");

        assertEquals(1, storage.backfillNumberOfFrames(), "未取得の 1 行を、保存済みのヘッダから埋める");

        assertEquals(182L, seriesFrames(st, st + ".A"));
        assertEquals(183L, studyFrames(st));
    }

    @Test
    void unreadableFile_staysNullAndIsNotFilledWithAGuess() throws Exception {
        String st = "1.9.frames.unreadable";
        ingestTwoShotStudy(st);

        DicomInstance row = repo.findById(st + ".A1").orElseThrow();
        row.setNumberOfFrames(null);
        repo.save(row);
        Files.delete(layout.resolveForRead(row));

        assertEquals(0, storage.backfillNumberOfFrames(), "ファイルが無い行は埋められない");
        assertNull(repo.findById(st + ".A1").orElseThrow().getNumberOfFrames(), "0 や 1 で埋めない");
        assertNull(seriesFrames(st, st + ".A"), "合計は不明のまま");
    }
}

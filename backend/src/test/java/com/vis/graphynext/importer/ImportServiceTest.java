/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:importit;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class ImportServiceTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    ImportService importService;
    @Autowired
    DicomStorageService storage;

    @Test
    void importFolder_ingestsDicom_keepsOriginal_skipsNonDicom() throws Exception {
        Path src = Files.createDirectories(tmp.resolve("src"));
        Attributes ds = DicomPhantomFactory.scImage("IMP1", "1.2.imp.study", "1.2.imp.series", "1.2.imp.sop");
        Path dcm = DicomPhantomFactory.writeFile(src.resolve("image.dcm"), ds, UID.ExplicitVRLittleEndian);
        Files.writeString(src.resolve("readme.txt"), "not dicom");

        ImportService.ImportResult r = importService.importPaths(List.of(src.toString()));

        assertEquals(1, r.imported(), "DICOM 1 件取り込み");
        assertTrue(r.skipped() >= 1, "非 DICOM はスキップ");
        assertEquals(0, r.failed());
        assertTrue(Files.exists(dcm), "原本は保持される（移動しない）");
        assertEquals(1, storage.findMatches(null, "1.2.imp.study", null, null).size(), "索引に載る");
    }

    /**
     * 階層フォルダ（患者/スタディ/シリーズ）を再帰で拾い、スタディとして 1 件に束ねる。
     * 併せて <b>StudyDate が空のスタディ数</b>を返すことを確認する（検索の既定「今日」では
     * 日付なしが SQL の NULL 比較で必ず除外されるため、UI で注意を出す材料になる）。
     */
    @Test
    void importFolder_recursesNested_andCountsStudiesWithoutDate() throws Exception {
        Path root = tmp.resolve("nested");
        Path ser1 = Files.createDirectories(root.resolve("PATIENT01/STUDY01/SER01"));
        Path ser2 = Files.createDirectories(root.resolve("PATIENT01/STUDY01/SER02/SUB"));
        // 拡張子なし（CD の IM000001 形式）でもマジックで拾う。
        DicomPhantomFactory.writeFile(ser1.resolve("IM000001"),
                DicomPhantomFactory.scImage("N1", "1.2.n.study", "1.2.n.ser1", "1.2.n.sop1"),
                UID.ExplicitVRLittleEndian);
        // 検査日なし（StudyDate は Type 2 なので規格上あり得る）。
        Attributes noDate = DicomPhantomFactory.scImage("N1", "1.2.n.study", "1.2.n.ser2", "1.2.n.sop2");
        noDate.remove(Tag.StudyDate);
        DicomPhantomFactory.writeFile(ser2.resolve("IM000002.dcm"), noDate, UID.ExplicitVRLittleEndian);

        ImportService.ImportResult r = importService.importPaths(List.of(root.toString()));

        assertEquals(2, r.imported(), "深い階層も再帰で拾う");
        assertEquals(0, r.failed());
        assertEquals(1, r.studiesWithoutDate(), "検査日なしのスタディ数を返す");
        assertEquals(2, storage.listSeries("1.2.n.study").size(), "1 スタディ 2 シリーズに束ねる");
    }

    /**
     * 🔴 読めないサブフォルダが 1 つ混ざっても、走査は止まらない。
     *
     * <p>{@code Files.walk()} を使っていた頃は {@code UncheckedIOException} が
     * {@code catch (IOException)} をすり抜けて <b>取り込み全体が 500</b> になり、
     * それまでに取り込んだ件数すら返らなかった（実測・2026-08-25）。
     */
    @Test
    void importFolder_unreadableSubdir_isOneFailure_andWalkContinues() throws Exception {
        Path root = Files.createDirectories(tmp.resolve("locked"));
        DicomPhantomFactory.writeFile(root.resolve("ok.dcm"),
                DicomPhantomFactory.scImage("L1", "1.2.l.study", "1.2.l.ser", "1.2.l.sop"),
                UID.ExplicitVRLittleEndian);
        // 走査順で後ろに来るよう zz_ 始まりにし、「落ちる前に取り込んだ分」ではなく
        // 「落ちても続く」ことを見る。
        Path denied = Files.createDirectories(root.resolve("zz_denied"));
        DicomPhantomFactory.writeFile(denied.resolve("inner.dcm"),
                DicomPhantomFactory.scImage("L1", "1.2.l.study", "1.2.l.ser", "1.2.l.sop2"),
                UID.ExplicitVRLittleEndian);
        try {
            Files.setPosixFilePermissions(denied, PosixFilePermissions.fromString("---------"));
        } catch (UnsupportedOperationException e) {
            Assumptions.abort("POSIX 権限が無い環境（Windows 等）ではこの経路を再現できない");
        }
        // root で実行すると権限が効かない。
        Assumptions.assumeFalse(Files.isReadable(denied), "権限を落とせない実行ユーザ（root 等）ではスキップ");

        try {
            ImportService.ImportResult r = importService.importPaths(List.of(root.toString()));

            assertEquals(1, r.imported(), "読める分は取り込む（例外で全体が落ちない）");
            assertEquals(1, r.failed(), "読めないフォルダは 1 件の失敗として数える");
            assertTrue(r.errors().stream().anyMatch(e -> e.contains("zz_denied")), "失敗理由にパスが載る");
        } finally {
            Files.setPosixFilePermissions(denied, PosixFilePermissions.fromString("rwx------"));
        }
    }
}

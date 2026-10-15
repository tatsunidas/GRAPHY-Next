/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbtransfer;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.radiomics.GlamAnalysisDocument;
import com.vis.graphynext.radiomics.GlamAnalysisDocumentRepository;
import com.vis.graphynext.report.ParticipationType;
import com.vis.graphynext.report.Report;
import com.vis.graphynext.report.ReportParticipant;
import com.vis.graphynext.report.ReportRepository;
import com.vis.graphynext.report.ReportStatus;
import com.vis.graphynext.report.ReportType;
import com.vis.graphynext.report.StaffRole;
import com.vis.graphynext.roi.RoiDocument;
import com.vis.graphynext.roi.RoiDocumentRepository;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

import jakarta.servlet.http.HttpServletRequestWrapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DB フォルダ間のコピー・移動。移し先の索引には触れず inbox に荷物を置き、開いたときに取り込む。
 *
 * <p>同じ Spring コンテキストで「移し元」と「移し先」を兼ねる: 荷物を作ったあと移し元の行を消し、
 * 移し先を指す {@link InboxIngestService} で取り込み直す。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.profiles.active=standalone",
                "spring.datasource.url=jdbc:h2:mem:dbtransfer;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class DbTransferTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.db.folder", () -> tmp.resolve("src").toString());
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("src/dicom").toString());
        r.add("graphy.plugins.dir", () -> tmp.resolve("plugins").toString());
    }

    @Autowired
    DbTransferService transfer;
    @Autowired
    RelatedData related;
    @Autowired
    DicomStorageService storage;
    @Autowired
    DicomInstanceRepository repo;
    @Autowired
    StorageLayout layout;
    @Autowired
    ReportRepository reports;
    @Autowired
    RoiDocumentRepository rois;
    @Autowired
    GlamAnalysisDocumentRepository glam;
    @Autowired
    SettingsService settings;
    @Autowired
    TransactionTemplate tx;

    private final ObjectMapper mapper = new ObjectMapper();
    private Path target;

    @BeforeEach
    void target() throws IOException {
        target = tmp.resolve("移し先 " + UUID.randomUUID());
        Files.createDirectories(target);
    }

    private void ingest(String pid, String study, String series, String sop) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage(pid, study, series, sop);
        ds.setString(Tag.PatientName, VR.PN, pid + "^NAME");
        Path f = DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian);
        storage.ingest(f);
    }

    private void addReport(String id, String pid, String study) {
        Report r = new Report(id);
        r.setPatientId(pid);
        r.setStudyInstanceUid(study);
        r.setTitle("所見");
        r.setReportType(ReportType.IMAGING_DIAGNOSTIC);
        r.setStatus(ReportStatus.FINAL);
        r.setBodyMarkdown("本文");
        r.setCreatedAt(Instant.parse("2025-01-02T03:04:05Z"));
        r.setUpdatedAt(Instant.parse("2025-01-02T03:04:06Z"));
        ReportParticipant p = new ReportParticipant(UUID.randomUUID().toString(), "Dr. A", StaffRole.PHYSICIAN,
                ParticipationType.values()[0], "院");
        p.setParticipatedAt(Instant.parse("2025-01-02T03:04:07Z"));
        r.addParticipant(p);
        reports.save(r);
    }

    private Path onlyPackage() throws IOException {
        try (Stream<Path> s = Files.list(target.resolve("inbox"))) {
            List<Path> l = s.filter(Files::isDirectory).toList();
            assertEquals(1, l.size(), l.toString());
            return l.get(0);
        }
    }

    private InboxIngestService targetInbox() {
        return new InboxIngestService(repo, storage, related,
                new DbTransferService(repo, layout, related, target.toString()));
    }

    @Test
    void コピー_付随データごと運び_移し先で取り込める() throws Exception {
        ingest("CP1", "cp.st", "cp.se", "cp.1");
        ingest("CP1", "cp.st", "cp.se", "cp.2");
        addReport("rep-cp", "CP1", "cp.st");
        rois.save(new RoiDocument("CP1", "{\"rois\":[1]}", 1));
        glam.save(new GlamAnalysisDocument("glam-cp", "cp.st", "cp.se", null, "L", "{}", 8, 1, 10));
        settings.putAll(Map.of(RelatedData.calibrationKey("cp.se"), "0.25"));

        var r = transfer.transfer(List.of("cp.st"), target.toString(), DbTransferService.Mode.copy);
        assertEquals(2, r.files());
        assertFalse(r.sourceDeleted());
        assertTrue(Files.exists(target.resolve(DbTransferService.MARKER)), "空のフォルダは DB フォルダにする");
        Path pkg = onlyPackage();
        assertFalse(pkg.getFileName().toString().endsWith(".partial"));
        assertEquals(2, repo.findByStudyInstanceUid("cp.st").size(), "コピーは移し元を残す");

        // 移し先を開いた想定: 移し元の行と付随データを消してから取り込む
        tx.executeWithoutResult(s -> {
            repo.deleteAll(repo.findByStudyInstanceUid("cp.st"));
            related.deleteAfterMove(List.of("cp.st"), List.of("cp.se"), List.of("CP1"));
        });
        assertTrue(reports.findById("rep-cp").isEmpty());

        var res = targetInbox().ingestOne(pkg);
        assertEquals(2, res.imported());
        assertEquals(0, res.failed());
        assertEquals(0, res.conflicts());
        assertEquals(4, res.relatedInserted(), "レポート・GLAM・校正・ROI");
        Report back = tx.execute(s -> {
            Report x = reports.findById("rep-cp").orElseThrow();
            x.getParticipants().size();
            return x;
        });
        assertEquals(Instant.parse("2025-01-02T03:04:07Z"), back.getParticipants().get(0).getParticipatedAt(),
                "署名の日時を保つ");
        assertEquals("{\"rois\":[1]}", rois.findById("CP1").orElseThrow().getJson());
        assertEquals("0.25", settings.getAll().get(RelatedData.calibrationKey("cp.se")));
        assertTrue(Files.exists(target.resolve("inbox/done").resolve(pkg.getFileName()).resolve("result.json")));
        assertFalse(Files.exists(target.resolve("inbox/done").resolve(pkg.getFileName()).resolve("dicom")),
                "取り込めたら DICOM の写しは消す");
    }

    @Test
    void 取り込みは上書きしない_同じSOPは飛ばし_違う付随データは衝突として残す() throws Exception {
        ingest("CF1", "cf.st", "cf.se", "cf.1");
        rois.save(new RoiDocument("CF1", "{\"v\":1}", 1));
        transfer.transfer(List.of("cf.st"), target.toString(), DbTransferService.Mode.copy);
        Path pkg = onlyPackage();
        // 移し先にも同じ SOP と、中身の違う ROI がある想定
        RoiDocument cur = rois.findById("CF1").orElseThrow();
        cur.update("{\"v\":2}", 1);
        rois.save(cur);

        var res = targetInbox().ingestOne(pkg);
        assertEquals(0, res.imported());
        assertEquals(1, res.skippedExisting());
        assertEquals(1, res.conflicts());
        assertEquals("{\"v\":2}", rois.findById("CF1").orElseThrow().getJson(), "移し先の ROI を上書きしない");
        try (Stream<Path> s = Files.list(target.resolve("inbox/conflicts").resolve(pkg.getFileName()))) {
            Path c = s.findFirst().orElseThrow();
            assertTrue(Files.readString(c).contains("\\\"v\\\":1"), "運んできた方を残す");
        }
    }

    @Test
    void 移動_確定後に移し元から消す_患者の検査が残れば患者単位の文書は残す() throws Exception {
        ingest("MV1", "mv.a", "mv.a.se", "mv.a.1");
        ingest("MV1", "mv.b", "mv.b.se", "mv.b.1");
        addReport("rep-mv", "MV1", "mv.a");
        rois.save(new RoiDocument("MV1", "{}", 0));
        settings.putAll(Map.of(RelatedData.calibrationKey("mv.a.se"), "0.3",
                RelatedData.calibrationKey("mv.a.se9"), "0.9"));
        Path file = layout.resolveForRead(repo.findByStudyInstanceUid("mv.a").get(0));

        var r = transfer.transfer(List.of("mv.a"), target.toString(), DbTransferService.Mode.move);
        assertTrue(r.sourceDeleted());
        assertTrue(repo.findByStudyInstanceUid("mv.a").isEmpty());
        assertFalse(Files.exists(file), "移し元のファイルも消す");
        assertTrue(reports.findById("rep-mv").isEmpty());
        assertNull(settings.getAll().get(RelatedData.calibrationKey("mv.a.se")));
        assertEquals("0.9", settings.getAll().get(RelatedData.calibrationKey("mv.a.se9")), "前方一致で消さない");
        assertTrue(rois.findById("MV1").isPresent(), "mv.b が残るので患者の ROI は残す（コピーに留める）");

        transfer.transfer(List.of("mv.b"), target.toString(), DbTransferService.Mode.move);
        assertTrue(rois.findById("MV1").isEmpty(), "患者の検査がすべて移ったら ROI も移す");
    }

    @Test
    void ファイルが欠けていたら何も運ばず何も消さない() throws Exception {
        ingest("MS1", "ms.st", "ms.se", "ms.1");
        ingest("MS1", "ms.st", "ms.se", "ms.2");
        Files.delete(layout.resolveForRead(repo.findById("ms.2").orElseThrow()));

        assertThrows(IOException.class,
                () -> transfer.transfer(List.of("ms.st"), target.toString(), DbTransferService.Mode.move));
        assertEquals(2, repo.findByStudyInstanceUid("ms.st").size());
        Path inbox = target.resolve("inbox");
        if (Files.exists(inbox)) {
            try (Stream<Path> s = Files.list(inbox)) {
                assertEquals(0, s.count(), "書きかけを残さない");
            }
        }
    }

    @Test
    void 移し先の検査() throws Exception {
        ingest("TG1", "tg.st", "tg.se", "tg.1");
        Path other = tmp.resolve("docs");
        Files.createDirectories(other);
        Files.writeString(other.resolve("memo.txt"), "x");
        Map<String, String> cases = Map.of(
                tmp.resolve("src").toString(), "target-is-current",
                other.toString(), "target-not-db-folder",
                tmp.resolve("gone").toString(), "target-not-found",
                "relative/x", "target-not-absolute",
                tmp.resolve("a;b").toString(), "target-has-semicolon");
        for (var c : cases.entrySet()) {
            var e = assertThrows(IllegalArgumentException.class,
                    () -> transfer.transfer(List.of("tg.st"), c.getKey(), DbTransferService.Mode.copy), c.getKey());
            assertEquals(c.getValue(), e.getMessage());
        }
        assertEquals("study-not-found: none", assertThrows(IllegalArgumentException.class,
                () -> transfer.transfer(List.of("none"), target.toString(), DbTransferService.Mode.copy)).getMessage());
    }

    @Test
    void 荷物の改ざんは照合で見つけ_取り込まずに残す() throws Exception {
        ingest("TM1", "tm.st", "tm.se", "tm.1");
        transfer.transfer(List.of("tm.st"), target.toString(), DbTransferService.Mode.copy);
        Path pkg = onlyPackage();
        TransferManifest m = mapper.readValue(pkg.resolve("manifest.json").toFile(), TransferManifest.class);
        Path f = pkg.resolve(m.files().get(0).path());
        byte[] b = Files.readAllBytes(f);
        b[b.length - 1] ^= 1;
        Files.write(f, b);
        assertThrows(IOException.class, () -> DbTransferService.verify(pkg, m));

        repo.deleteAll(repo.findByStudyInstanceUid("tm.st"));
        var res = targetInbox().ingestOne(pkg);
        assertEquals(0, res.imported());
        assertEquals(1, res.failed());
        assertTrue(Files.exists(target.resolve("inbox/done").resolve(pkg.getFileName()).resolve(m.files().get(0).path())),
                "取り込めなかったファイルは残す");
    }

    @Test
    void この_PC_からの要求だけを受け_転送ヘッダの偽装は効かない() {
        MockHttpServletRequest lan = new MockHttpServletRequest();
        lan.setRemoteAddr("192.168.1.50");
        assertThrows(ResponseStatusException.class, () -> DbTransferController.requireLoopback(lan));

        // ForwardedHeaderFilter が X-Forwarded-For で接続元を書き換えた状態を模す
        HttpServletRequestWrapper spoofed = new HttpServletRequestWrapper(lan) {
            @Override
            public String getRemoteAddr() {
                return "127.0.0.1";
            }
        };
        assertThrows(ResponseStatusException.class, () -> DbTransferController.requireLoopback(spoofed));

        MockHttpServletRequest local = new MockHttpServletRequest();
        local.setRemoteAddr("127.0.0.1");
        DbTransferController.requireLoopback(local);
        local.setRemoteAddr("::1");
        DbTransferController.requireLoopback(local);
    }
}

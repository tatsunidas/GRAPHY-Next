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
import com.vis.graphynext.roi.RoiMaskDocument;
import com.vis.graphynext.roi.RoiMaskDocumentRepository;
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

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
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
    RoiMaskDocumentRepository maskDocs;
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

    @Test
    void モードA_では転送を拒否し_何も作らず元も消さない() throws Exception {
        ingest("MA1", "cache-st", "cache-se", "cache.1");
        layout.setBackend(new com.vis.graphynext.dicom.store.StorageBackend() {
            @Override public boolean cacheMode() { return true; }
            @Override public Path ensureLocal(String rel) { return null; }
            @Override public void prefetch(java.util.Collection<String> r, java.util.function.BooleanSupplier c) { }
            @Override public void touch(String rel) { }
        });
        try {
            for (var mode : DbTransferService.Mode.values()) {
                var e = assertThrows(IllegalArgumentException.class,
                        () -> transfer.transfer(List.of("cache-st"), target.toString(), mode));
                assertEquals("cache-mode-unsupported", e.getMessage());
            }
        } finally {
            layout.setBackend(null);
        }
        assertFalse(Files.exists(target.resolve("inbox")), "移し先に何も作らない");
        assertTrue(repo.findByStudyInstanceUid("cache-st").size() == 1, "元は消えない（move でも）");
        assertTrue(Files.exists(layout.resolveForRead(repo.findByStudyInstanceUid("cache-st").get(0))));
        // モード A でなければ、同じ操作は通る（拒否が条件つきであることの対）
        assertEquals(1, transfer.transfer(List.of("cache-st"), target.toString(), DbTransferService.Mode.copy).files());
    }

    private static byte[] frames(int seed) {
        byte[] b = new byte[300];
        for (int i = 0; i < b.length; i++) {
            b[i] = (byte) (seed * 31 + i);
        }
        return b;
    }

    private void addMask(String uid, String pk, String series, int seed) {
        maskDocs.save(new RoiMaskDocument(uid, pk, series, "{\"patientKey\":\"" + pk + "\",\"seed\":" + seed + "}",
                frames(seed), 3));
    }

    @Test
    void 塗りROI_移すシリーズの分だけ荷物に入り_移し先で同じ中身に取り込める() throws Exception {
        ingest("MK1", "mk.st", "mk.se", "mk.1");
        addMask("mk-a", "MK1", "mk.se", 1);
        addMask("mk-other", "MK1", "mk.other.se", 2); // 移さないシリーズ

        transfer.transfer(List.of("mk.st"), target.toString(), DbTransferService.Mode.copy);
        Path pkg = onlyPackage();
        TransferManifest m = mapper.readValue(pkg.resolve("manifest.json").toFile(), TransferManifest.class);
        assertEquals(2, m.formatVersion(), "塗り ROI を含む荷物は版 2");
        assertEquals(1, m.related().masks().size(), "別シリーズの塗り ROI は運ばない");
        assertEquals("mk-a", m.related().masks().get(0).maskUid());
        assertTrue(maskDocs.findById("mk-a").isPresent(), "コピーは移し元を残す");

        tx.executeWithoutResult(s -> {
            repo.deleteAll(repo.findByStudyInstanceUid("mk.st"));
            maskDocs.deleteById("mk-a");
        });
        var res = targetInbox().ingestOne(pkg);
        assertEquals(0, res.failed(), res.errors().toString());
        assertEquals(0, res.conflicts());
        RoiMaskDocument back = maskDocs.findById("mk-a").orElseThrow();
        assertArrayEquals(frames(1), back.getFrames());
        assertEquals("MK1", back.getPatientKey());
        assertEquals("mk.se", back.getSeriesUid());
        assertEquals(3, back.getFrameCount());
        assertTrue(back.getMeta().contains("\"seed\":1"));
        assertFalse(Files.exists(target.resolve("inbox/done").resolve(pkg.getFileName()).resolve("masks")),
                "取り込めて衝突も無ければ、フレームの写しは残さない");
        assertTrue(maskDocs.findById("mk-other").isPresent());
    }

    @Test
    void 塗りROI_移動は運んだシリーズの分だけ移し元から消す() throws Exception {
        ingest("MM1", "mm.st", "mm.se", "mm.1");
        ingest("MM1", "mm.st2", "mm.se2", "mm.2");
        addMask("mm-a", "MM1", "mm.se", 1);
        addMask("mm-b", "MM1", "mm.se2", 2);

        transfer.transfer(List.of("mm.st"), target.toString(), DbTransferService.Mode.move);
        assertTrue(maskDocs.findById("mm-a").isEmpty(), "運んだシリーズの塗り ROI は移し元から消す");
        assertTrue(maskDocs.findById("mm-b").isPresent(), "移していないシリーズの分は残す");
        TransferManifest m = mapper.readValue(onlyPackage().resolve("manifest.json").toFile(), TransferManifest.class);
        assertEquals(List.of("mm-a"), m.related().masks().stream().map(TransferManifest.MaskItem::maskUid).toList());
    }

    @Test
    void 塗りROI_運べないときは移し元の塗りROIも消さない() throws Exception {
        ingest("MN1", "mn.st", "mn.se", "mn.1");
        addMask("mn-a", "MN1", "mn.se", 1);
        Path f = layout.resolveForRead(repo.findByStudyInstanceUid("mn.st").get(0));
        Files.delete(f);

        assertThrows(IOException.class,
                () -> transfer.transfer(List.of("mn.st"), target.toString(), DbTransferService.Mode.move));
        assertTrue(maskDocs.findById("mn-a").isPresent());
    }

    @Test
    void 塗りROI_取り込みは上書きしない_同じ中身は同一_違えば衝突でフレームを残す() throws Exception {
        ingest("MC1", "mc.st", "mc.se", "mc.1");
        addMask("mc-a", "MC1", "mc.se", 1);
        transfer.transfer(List.of("mc.st"), target.toString(), DbTransferService.Mode.copy);
        Path pkg = onlyPackage();

        // 同じ中身 → 同一（衝突にしない）
        var same = targetInbox().ingestOne(copyTree(pkg, pkg.resolveSibling("copy1")));
        assertEquals(0, same.conflicts());
        assertTrue(same.relatedSame() >= 1);

        // 移し先の同じ maskUid が違う中身 → 衝突、既存は変えない
        RoiMaskDocument cur = maskDocs.findById("mc-a").orElseThrow();
        cur.update("mc.se", cur.getMeta(), frames(9), 3);
        maskDocs.save(cur);
        var res = targetInbox().ingestOne(copyTree(pkg, pkg.resolveSibling("copy2")));
        assertEquals(1, res.conflicts());
        assertArrayEquals(frames(9), maskDocs.findById("mc-a").orElseThrow().getFrames());
        assertTrue(Files.exists(target.resolve("inbox/done/copy2/masks")), "衝突のときだけフレームを残す");
    }

    @Test
    void 塗りROI_荷物のフレームの改ざんは照合で見つけ_保存せずに残す() throws Exception {
        ingest("MT1", "mt.st", "mt.se", "mt.1");
        addMask("mt-a", "MT1", "mt.se", 1);
        transfer.transfer(List.of("mt.st"), target.toString(), DbTransferService.Mode.copy);
        Path pkg = onlyPackage();
        TransferManifest m = mapper.readValue(pkg.resolve("manifest.json").toFile(), TransferManifest.class);
        DbTransferService.verify(pkg, m); // 無改ざんなら通る（正例）
        Path f = pkg.resolve(m.related().masks().get(0).path());
        byte[] b = Files.readAllBytes(f);
        b[0] ^= 1;
        Files.write(f, b);
        assertThrows(IOException.class, () -> DbTransferService.verify(pkg, m));

        tx.executeWithoutResult(s -> {
            repo.deleteAll(repo.findByStudyInstanceUid("mt.st"));
            maskDocs.deleteById("mt-a");
        });
        var res = targetInbox().ingestOne(pkg);
        assertEquals(1, res.failed());
        assertTrue(maskDocs.findById("mt-a").isEmpty(), "照合に失敗したフレームは保存しない");
        assertTrue(Files.exists(target.resolve("inbox/done").resolve(pkg.getFileName()).resolve("masks")),
                "取り込めなかったものは残す");
    }

    @Test
    void 塗りROIが無い荷物は版1のまま_古い版のアプリでも読める() throws Exception {
        ingest("MV9", "mv9.st", "mv9.se", "mv9.1");
        transfer.transfer(List.of("mv9.st"), target.toString(), DbTransferService.Mode.copy);
        TransferManifest m = mapper.readValue(onlyPackage().resolve("manifest.json").toFile(), TransferManifest.class);
        assertEquals(1, m.formatVersion());
        assertTrue(m.related().masks().isEmpty());
    }

    private static Path copyTree(Path from, Path to) throws IOException {
        try (Stream<Path> s = Files.walk(from)) {
            for (Path p : s.toList()) {
                Path d = to.resolve(from.relativize(p).toString());
                if (Files.isDirectory(p)) {
                    Files.createDirectories(d);
                } else {
                    Files.copy(p, d);
                }
            }
        }
        return to;
    }
}

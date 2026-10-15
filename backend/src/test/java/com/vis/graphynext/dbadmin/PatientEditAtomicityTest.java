/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.gdrive.StorageChanged;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.event.ApplicationEvents;
import org.springframework.test.context.event.RecordApplicationEvents;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.reset;

/**
 * 患者編集は<b>全か無か</b>。ファイルの書き換えが 1 つでも失敗したら、編集全体が失敗し、
 * ファイルも索引も編集前のまま（索引だけ新しい・一部のファイルだけ新しい、を残さない）。
 */
@RecordApplicationEvents
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:patientedit;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class PatientEditAtomicityTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DbAdminService dbAdmin;
    @Autowired
    DicomStorageService storage;
    @Autowired
    DicomInstanceRepository repo;
    @Autowired
    StorageLayout layout;
    @Autowired
    ApplicationEvents events;
    @Autowired
    PatientEditRecovery recovery;
    @SpyBean
    PatientRecordMover records;

    private void ingest(String pid, String name, String study, String series, String sop) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage(pid, study, series, sop);
        ds.setString(Tag.PatientName, VR.PN, name);
        Path f = DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian);
        storage.ingest(f);
    }

    private Path fileOf(String sop) {
        return layout.resolveForRead(repo.findById(sop).orElseThrow());
    }

    private List<String> leftovers() throws IOException {
        try (Stream<Path> s = Files.walk(layout.root())) {
            return s.filter(Files::isRegularFile).map(p -> layout.root().relativize(p).toString()).map(n -> n.replace(java.io.File.separatorChar, '/'))
                    .filter(n -> n.contains(".edit") || n.contains(".orig") || n.endsWith(".journal")).sorted().toList();
        }
    }

    private static String patientNameInFile(Path f) throws IOException {
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            return in.readDataset().getString(Tag.PatientName);
        }
    }

    /** 旧実装（その場で上書き）の書き換え内容。新しい実装の出力と、同じ入力で同じバイト列になることを比べる。 */
    private static void referenceRewrite(Path file, String name, String birthDate, String sex, String newId) throws IOException {
        Attributes fmi;
        Attributes ds;
        try (DicomInputStream in = new DicomInputStream(file.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.URI);
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
        Path t = Files.createTempFile(file.getParent(), "ref-", ".tmp");
        try (DicomOutputStream out = new DicomOutputStream(t.toFile())) {
            out.writeDataset(fmi, ds);
        }
        Files.move(t, file, StandardCopyOption.REPLACE_EXISTING);
    }

    // ── 正例 ──

    @Test
    void 成功すると_旧実装と同じバイト列になり_退避も一時ファイルも残らず_変更を通知する() throws Exception {
        ingest("AT1", "Old^Name", "AT1.st", "AT1.se", "AT1.s1");
        ingest("AT1", "Old^Name", "AT1.st", "AT1.se", "AT1.s2");
        Path ref1 = Files.createTempFile("ref", ".dcm");
        Files.copy(fileOf("AT1.s1"), ref1, StandardCopyOption.REPLACE_EXISTING);
        referenceRewrite(ref1, "New^Name", "19800101", "F", null);

        events.clear();
        dbAdmin.updatePatient("AT1", "New^Name", "19800101", "F", null);

        assertArrayEquals(Files.readAllBytes(ref1), Files.readAllBytes(fileOf("AT1.s1")), "新実装の出力 ＝ 旧実装の出力");
        assertEquals("New^Name", patientNameInFile(fileOf("AT1.s2")));
        assertEquals("New^Name", repo.findById("AT1.s2").orElseThrow().getPatientName());
        assertEquals(List.of(), leftovers());
        assertEquals(2, events.stream(StorageChanged.class).count(), "書き換えた 2 ファイルを Drive 同期へ通知");
    }

    // ── 負例: 全か無か ──

    @Test
    void 途中のファイルが壊れていたら_編集全体が失敗し_全ファイルも索引も編集前のまま() throws Exception {
        ingest("AT2", "Old^Name", "AT2.st", "AT2.se", "AT2.s1");
        ingest("AT2", "Old^Name", "AT2.st", "AT2.se", "AT2.s2");
        ingest("AT2", "Old^Name", "AT2.st", "AT2.se", "AT2.s3");
        List<DicomInstance> rows = repo.findByPatientId("AT2");
        // 並びに依らず、1 件を DICOM として読めない中身にする
        Path broken = fileOf(rows.get(1).getSopInstanceUid());
        Files.write(broken, "これは DICOM ではない".getBytes());
        List<byte[]> before = new ArrayList<>();
        for (DicomInstance r : rows) {
            before.add(Files.readAllBytes(fileOf(r.getSopInstanceUid())));
        }
        events.clear();

        var ex = assertThrows(ResponseStatusException.class,
                () -> dbAdmin.updatePatient("AT2", "New^Name", "19800101", "F", "AT2-NEW"));
        assertEquals(409, ex.getStatusCode().value());
        assertTrue(ex.getReason().startsWith("patient-edit-failed"), ex.getReason());

        for (int i = 0; i < rows.size(); i++) {
            assertArrayEquals(before.get(i), Files.readAllBytes(fileOf(rows.get(i).getSopInstanceUid())),
                    "ファイルは 1 つも変わらない: " + rows.get(i).getSopInstanceUid());
        }
        for (DicomInstance r : repo.findByPatientId("AT2")) {
            assertEquals("Old^Name", r.getPatientName(), "索引も編集前");
        }
        assertTrue(repo.findByPatientId("AT2-NEW").isEmpty(), "患者 ID も変わらない");
        assertEquals(List.of(), leftovers());
        assertEquals(0, events.stream(StorageChanged.class).count(), "失敗した編集は Drive へ通知しない");
    }

    @Test
    void DB更新で失敗したら_入れ替えたファイルも元に戻る() throws Exception {
        ingest("AT3", "Old^Name", "AT3.st", "AT3.se", "AT3.s1");
        ingest("AT3", "Old^Name", "AT3.st", "AT3.se", "AT3.s2");
        List<byte[]> before = new ArrayList<>();
        before.add(Files.readAllBytes(fileOf("AT3.s1")));
        before.add(Files.readAllBytes(fileOf("AT3.s2")));
        doThrow(new IllegalStateException("DB の失敗を模擬")).when(records).afterEdit(any(), any(), any());
        try {
            assertThrows(IllegalStateException.class, () -> dbAdmin.updatePatient("AT3", "New^Name", "19800101", "F", null));
        } finally {
            reset(records);
        }
        assertArrayEquals(before.get(0), Files.readAllBytes(fileOf("AT3.s1")), "ファイルは元の内容");
        assertArrayEquals(before.get(1), Files.readAllBytes(fileOf("AT3.s2")));
        assertEquals("Old^Name", repo.findById("AT3.s1").orElseThrow().getPatientName(), "索引は取引ごとロールバック");
        assertEquals("Old^Name", patientNameInFile(fileOf("AT3.s1")));
        assertEquals(List.of(), leftovers());
    }

    @Test
    void 失敗した編集のあとも_別の患者の編集は止まらず成功する() throws Exception {
        ingest("AT4", "Old^Name", "AT4.st", "AT4.se", "AT4.s1");
        ingest("AT5", "Other^Name", "AT5.st", "AT5.se", "AT5.s1");
        Files.write(fileOf("AT4.s1"), "壊れた".getBytes());
        assertThrows(ResponseStatusException.class, () -> dbAdmin.updatePatient("AT4", "X^Y", null, null, null));
        dbAdmin.updatePatient("AT5", "Changed^Name", null, null, null);
        assertEquals("Changed^Name", patientNameInFile(fileOf("AT5.s1")));
        assertEquals("Changed^Name", repo.findById("AT5.s1").orElseThrow().getPatientName());
        assertEquals(List.of(), leftovers());
    }

    @Test
    void 実ファイルが無い行は_従来どおり警告だけで_残りの編集は進む() throws Exception {
        ingest("AT6", "Old^Name", "AT6.st", "AT6.se", "AT6.s1");
        ingest("AT6", "Old^Name", "AT6.st", "AT6.se", "AT6.s2");
        Files.delete(fileOf("AT6.s1")); // 索引にあるが実体が無い（書き換える物が無い）
        dbAdmin.updatePatient("AT6", "New^Name", null, null, null);
        assertEquals("New^Name", patientNameInFile(fileOf("AT6.s2")));
        assertEquals("New^Name", repo.findById("AT6.s1").orElseThrow().getPatientName());
    }

    // ── 起動時の復旧（編集の途中でプロセスが落ちた） ──

    /** 編集を「入れ替え済み・未確定」の状態で止める（commit も rollback もしない）。 */
    private Path crashAfterSwap(String sop, String newName) throws Exception {
        Path f = fileOf(sop);
        PatientFileEdit e = PatientFileEdit.prepare(List.of(new PatientFileEdit.Target(sop, f)),
                (src, dst) -> DbAdminService.writeRewritten(src, dst, newName, null, null, null),
                layout.root().resolve(".edit-journal"), new FileRetry(ms -> { }), PatientFileEdit.Ops.REAL);
        e.swap();
        return f;
    }

    @Test
    void 復旧_索引が編集前なら_退避した元のファイルへ戻す() throws Exception {
        ingest("AT7", "Old^Name", "AT7.st", "AT7.se", "AT7.s1");
        Path f = crashAfterSwap("AT7.s1", "New^Name"); // DB は更新されないまま落ちた
        assertEquals("New^Name", patientNameInFile(f));
        recovery.recover(layout.root().resolve(".edit-journal"));
        assertEquals("Old^Name", patientNameInFile(f), "索引（編集前）に合わせて元へ戻る");
        assertEquals(List.of(), leftovers());
    }

    @Test
    void 復旧_索引が編集後なら_新しいファイルを残し退避を消す() throws Exception {
        ingest("AT8", "Old^Name", "AT8.st", "AT8.se", "AT8.s1");
        Path f = crashAfterSwap("AT8.s1", "New^Name");
        DicomInstance row = repo.findById("AT8.s1").orElseThrow();
        row.setPatientName("New^Name"); // DB はコミットされていた
        repo.save(row);
        recovery.recover(layout.root().resolve(".edit-journal"));
        assertEquals("New^Name", patientNameInFile(f));
        assertEquals(List.of(), leftovers());
    }

    @Test
    void 復旧_入れ替えの途中で元のファイルが無いなら_退避から戻す() throws Exception {
        ingest("AT9", "Old^Name", "AT9.st", "AT9.se", "AT9.s1");
        Path f = crashAfterSwap("AT9.s1", "New^Name");
        Files.delete(f); // 「退避したが、新しいファイルを置く前に落ちた」状態
        recovery.recover(layout.root().resolve(".edit-journal"));
        assertEquals("Old^Name", patientNameInFile(f));
        assertEquals(List.of(), leftovers());
    }

    @Test
    void 復旧_どちらとも索引と合わないときは何も消さない() throws Exception {
        ingest("AT10", "Old^Name", "AT10.st", "AT10.se", "AT10.s1");
        Path f = crashAfterSwap("AT10.s1", "New^Name");
        DicomInstance row = repo.findById("AT10.s1").orElseThrow();
        row.setPatientName("Third^Name");
        repo.save(row);
        recovery.recover(layout.root().resolve(".edit-journal"));
        assertTrue(Files.exists(PatientFileEdit.origName(f)), "退避は残す（データを失わない）");
        assertEquals("New^Name", patientNameInFile(f));
        assertTrue(leftovers().stream().anyMatch(n -> n.endsWith(".journal")), "journal も残す");
        // 他のテストの「残骸なし」の検査に混ざらないよう、この試験で意図的に残したものを片付ける
        Files.deleteIfExists(PatientFileEdit.origName(f));
        try (Stream<Path> js = Files.list(layout.root().resolve(".edit-journal"))) {
            for (Path j : js.toList()) {
                Files.deleteIfExists(j);
            }
        }
    }
}

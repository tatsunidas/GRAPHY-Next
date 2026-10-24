/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.anonymize.ConsistentPseudonyms;
import com.vis.graphynext.anonymize.PseudonymKey;
import com.vis.graphynext.anonymize.ReceiveAnonymizer;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.DicomStoreScp;
import com.vis.graphynext.dicom.store.DicomStoreScu;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Fragments;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.data.Value;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.net.TransferCapability;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 受信時の匿名化（C-STORE SCP）の結合テスト。SCP をテストの中で起動し、実際に C-STORE で送る。
 * 「元の値が保管庫・索引に残らない」は、先に「送ったファイルには元の値がある」ことを確かめてから見る。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:recvanon;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class ReceiveAnonymizeIntegrationTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
        registry.add("graphy.receive-anonymize.key-file", () -> tmp.resolve("keys/receive-anon.key").toString());
    }

    private static final String NAME = "YAMADA^TARO";
    private static final String PID = "REAL-PID-777";
    // 保管庫は他のテストと共有なので、「元の値が残らない」を見るテストは、そのテスト専用の氏名・ID を使う。
    private static final String SPLIT_NAME = "SPLITCASE^HANAKO";
    private static final String SPLIT_PID = "SPLIT-PID-1";

    private static Attributes named(Attributes a) {
        a.setString(Tag.PatientName, VR.PN, SPLIT_NAME);
        return a;
    }

    @Autowired
    DicomStorageService storage;
    @Autowired
    SettingsService settings;
    @Autowired
    ReceiveAnonymizer anonymizer;

    private int seq;

    @BeforeEach
    void reset() {
        settings.putAll(Map.of(ReceiveAnonymizer.ENABLED_KEY, "true", ReceiveAnonymizer.PROFILE_KEY, ""));
    }

    // ---- 部品 ----

    private static Attributes ct(String pid, String study, String series, String sop) {
        Attributes a = DicomPhantomFactory.scImage(pid, study, series, sop);
        a.setString(Tag.PatientName, VR.PN, NAME);
        a.setString(Tag.Modality, VR.CS, "CT");
        return a;
    }

    private Path write(Attributes ds) throws IOException {
        Path f = tmp.resolve("send-" + (seq++) + ".dcm");
        return DicomPhantomFactory.writeFile(f, ds, UID.ExplicitVRLittleEndian);
    }

    private static int freePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        }
    }

    private DicomScpServer start(ReceiveAnonymizer a, Path incoming, int port) throws Exception {
        DicomScpServer scp = new DicomScpServer("GRAPHYSTORE", "127.0.0.1", port);
        scp.addService(new DicomStoreScp(storage, incoming, a),
                new TransferCapability(null, "*", TransferCapability.Role.SCP, "*"));
        scp.start();
        return scp;
    }

    private static DicomStoreScu.StoreResult send(int port, Path file) throws Exception {
        return new DicomStoreScu().store("127.0.0.1", port, "GRAPHYSTORE", "SENDER", file);
    }

    /** ルート以下のファイルについて、パスか中身に needle が 1 つでも含まれるか。 */
    private static boolean anyContains(Path root, String... needles) throws IOException {
        if (!Files.exists(root)) {
            return false;
        }
        try (Stream<Path> w = Files.walk(root)) {
            for (Path p : w.filter(Files::isRegularFile).toList()) {
                String hay = root.relativize(p) + new String(Files.readAllBytes(p), StandardCharsets.ISO_8859_1);
                for (String n : needles) {
                    if (hay.contains(n)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private static long fileCount(Path dir) throws IOException {
        if (!Files.exists(dir)) {
            return 0;
        }
        try (Stream<Path> w = Files.walk(dir)) {
            return w.filter(Files::isRegularFile).count();
        }
    }

    private List<DicomInstance> byPatientPrefix() {
        List<DicomInstance> out = new ArrayList<>();
        for (var s : storage.listStudies()) {
            if (s.patientId() != null && s.patientId().startsWith("ANON-")) {
                out.addAll(storage.findMatches(s.patientId(), null, null, null));
            }
        }
        return out;
    }

    private Attributes readStored(DicomInstance inst) throws IOException {
        try (DicomInputStream in = new DicomInputStream(layout.resolveForRead(inst).toFile())) {
            return in.readDataset();
        }
    }

    @Autowired
    com.vis.graphynext.dicom.store.StorageLayout layout;

    /** 受信側と同じ鍵ファイルから、期待される仮名を計算する。 */
    private static ConsistentPseudonyms pseudo() throws IOException {
        return new ConsistentPseudonyms(PseudonymKey.loadOrCreate(tmp.resolve("keys/receive-anon.key")));
    }

    // ---- テスト ----

    @Test
    void splitAcrossAssociationsAndRestart_oneStudy_noOriginalValuesLeft() throws Exception {
        Path incoming = tmp.resolve("in-split");
        String study = "1.2.826.7.1";
        String series = "1.2.826.7.1.1";
        Path f1 = write(named(ct(SPLIT_PID, study, series, "1.2.826.7.1.1.1")));
        Path f2 = write(named(ct(SPLIT_PID, study, series, "1.2.826.7.1.1.2")));
        Path f3 = write(named(ct(SPLIT_PID, study, series, "1.2.826.7.1.1.3")));
        // 先に、送るファイルには元の値がある（検査が空振りしていないことの確認）。
        assertTrue(anyContains(f1.getParent(), SPLIT_NAME, SPLIT_PID, study), "送る前のファイルには元の値がある");

        int port = freePort();
        DicomScpServer scp = start(anonymizer, incoming, port);
        try {
            assertTrue(send(port, f1).success());
            assertTrue(send(port, f2).success());
        } finally {
            scp.stop();
        }
        // 再起動を模す: 鍵ファイルを読み直した別インスタンスで SCP を立て直す。
        ReceiveAnonymizer restarted = new ReceiveAnonymizer(settings, tmp.resolve("keys/receive-anon.key").toString());
        int port2 = freePort();
        scp = start(restarted, incoming, port2);
        try {
            assertTrue(send(port2, f3).success());
            assertTrue(send(port2, f1).success(), "同じ画像の再送");
        } finally {
            scp.stop();
        }

        // 他のテストが同じ患者 ID で保管した分を数えないよう、この検査の新しい UID に絞る。
        List<DicomInstance> got = storage.findMatches(null, pseudo().uid(study), null, null);
        assertEquals(pseudo().patientId(SPLIT_PID, "ANON-"), got.get(0).getPatientId(), "仮名の患者 ID");
        assertEquals(3, got.stream().map(DicomInstance::getSopInstanceUid).distinct().count(), "3 枚（再送で増えない）");
        assertEquals(1, got.stream().map(DicomInstance::getStudyInstanceUid).distinct().count(), "検査は 1 つ");
        assertEquals(1, got.stream().map(DicomInstance::getSeriesInstanceUid).distinct().count(), "シリーズは 1 つ");
        assertNotEquals(study, got.get(0).getStudyInstanceUid());

        Path store = tmp.resolve("store");
        assertFalse(anyContains(store, SPLIT_NAME, SPLIT_PID, study, series, "1.2.826.7.1.1.1"), "保管庫のパス・中身に元の値が無い");
        assertEquals(0, storage.findMatches(SPLIT_PID, null, null, null).size(), "索引に元の患者 ID が無い");
        assertEquals(0, storage.findMatches(null, study, null, null).size(), "索引に元の検査 UID が無い");
        assertEquals(0, fileCount(incoming), "incoming に残らない");
        // 氏名は ID と同じ仮名
        assertEquals(got.get(0).getPatientId(), got.get(0).getPatientName());
    }

    /**
     * 実機で Implicit VR の C-STORE が全件断られた不具合の回帰。Implicit VR（DICOM の既定の転送構文）と
     * JPEG Baseline（圧縮）でも受け付け、仮名にして保管し、圧縮の画素は元のバイト列のまま残る。
     */
    @Test
    void implicitVrAndJpeg_areAccepted_withOriginalValuesGone_andJpegPixelsUntouched() throws Exception {
        String pid = "TS-PID-1";
        String name = "TSCASE^ICHIRO";
        String study = "1.2.826.7.9";
        String series = "1.2.826.7.9.1";
        Attributes implicit = ct(pid, study, series, "1.2.826.7.9.1.1");
        implicit.setString(Tag.PatientName, VR.PN, name);
        Path fImplicit = DicomPhantomFactory.writeFile(tmp.resolve("send-implicit.dcm"), implicit, UID.ImplicitVRLittleEndian);

        Attributes jpeg = ct(pid, study, series, "1.2.826.7.9.1.2");
        jpeg.setString(Tag.PatientName, VR.PN, name);
        byte[] frame = new byte[] {(byte) 0xFF, (byte) 0xD8, 1, 2, 3, 4, 5, 6, (byte) 0xFF, (byte) 0xD9};
        Fragments frags = jpeg.newFragments(Tag.PixelData, VR.OB, 2);
        frags.add(Value.NULL);
        frags.add(frame);
        Path fJpeg = DicomPhantomFactory.writeFile(tmp.resolve("send-jpeg.dcm"), jpeg, UID.JPEGBaseline8Bit);

        int port = freePort();
        DicomScpServer scp = start(anonymizer, tmp.resolve("in-ts"), port);
        try {
            var r1 = send(port, fImplicit);
            assertTrue(r1.success(), "Implicit VR: " + r1);
            var r2 = send(port, fJpeg);
            assertTrue(r2.success(), "JPEG Baseline: " + r2);
        } finally {
            scp.stop();
        }

        List<DicomInstance> got = storage.findMatches(null, pseudo().uid(study), null, null);
        assertEquals(2, got.size(), "2 枚とも保管された");
        assertEquals(pseudo().patientId(pid, "ANON-"), got.get(0).getPatientId(), "仮名の患者 ID");
        assertFalse(anyContains(tmp.resolve("store"), pid, name), "保管庫に元の患者 ID・氏名が残らない");
        String jpegSop = pseudo().uid("1.2.826.7.9.1.2");
        DicomInstance jpegStored = got.stream().filter(i -> i.getSopInstanceUid().equals(jpegSop)).findFirst().orElseThrow();
        try (DicomInputStream in = new DicomInputStream(layout.resolveForRead(jpegStored).toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
            Attributes fmi = in.readFileMetaInformation();
            assertEquals(UID.JPEGBaseline8Bit, fmi.getString(Tag.TransferSyntaxUID), "圧縮のまま");
            Fragments out = (Fragments) in.readDataset().getValue(Tag.PixelData);
            assertArrayEquals(frame, (byte[]) out.get(1), "圧縮された画素は元のバイト列のまま");
        }
    }

    @Test
    void differentPatientDiffers_samePatientAnotherStudySame() throws Exception {
        int port = freePort();
        DicomScpServer scp = start(anonymizer, tmp.resolve("in-pid"), port);
        try {
            assertTrue(send(port, write(ct("PID-A", "1.2.826.8.1", "1.2.826.8.1.1", "1.2.826.8.1.1.1"))).success());
            assertTrue(send(port, write(ct("PID-A", "1.2.826.8.2", "1.2.826.8.2.1", "1.2.826.8.2.1.1"))).success());
            assertTrue(send(port, write(ct("PID-B", "1.2.826.8.3", "1.2.826.8.3.1", "1.2.826.8.3.1.1"))).success());
        } finally {
            scp.stop();
        }
        var studies = storage.listStudies().stream()
                .filter(s -> s.patientId() != null && s.patientId().startsWith("ANON-")).toList();
        long pids = studies.stream().map(s -> s.patientId()).distinct().count();
        assertTrue(pids >= 2, "別の患者は別の仮名 ID");
        // PID-A の 2 検査は同じ仮名 ID
        String a = pseudo().patientId("PID-A", "ANON-");
        assertEquals(2, studies.stream().filter(s -> s.patientId().equals(a)).count(), "同じ患者の別検査は同じ仮名 ID");
    }

    @Test
    void referencesFollowTheImage() throws Exception {
        String study = "1.2.826.9.1";
        String series = "1.2.826.9.1.1";
        String imgSop = "1.2.826.9.1.1.1";
        Attributes sr = DicomPhantomFactory.scImage(PID, study, "1.2.826.9.1.2", "1.2.826.9.1.2.1");
        sr.setString(Tag.PatientName, VR.PN, NAME);
        sr.setString(Tag.Modality, VR.CS, "SR");
        sr.setString(Tag.SOPClassUID, VR.UI, UID.BasicTextSRStorage);
        Sequence seq = sr.newSequence(Tag.ReferencedImageSequence, 1);
        Attributes item = new Attributes();
        item.setString(Tag.ReferencedSOPClassUID, VR.UI, UID.SecondaryCaptureImageStorage);
        item.setString(Tag.ReferencedSOPInstanceUID, VR.UI, imgSop);
        seq.add(item);

        int port = freePort();
        DicomScpServer scp = start(anonymizer, tmp.resolve("in-ref"), port);
        try {
            assertTrue(send(port, write(ct(PID, study, series, imgSop))).success());
            assertTrue(send(port, write(sr)).success());
        } finally {
            scp.stop();
        }
        String newImg = pseudo().uid(imgSop);
        String referenced = null;
        boolean imageStored = false;
        for (DicomInstance i : byPatientPrefix()) {
            Attributes ds = readStored(i);
            if ("SR".equals(ds.getString(Tag.Modality))) {
                referenced = ds.getSequence(Tag.ReferencedImageSequence).get(0).getString(Tag.ReferencedSOPInstanceUID);
            } else if (newImg.equals(i.getSopInstanceUid())) {
                imageStored = true;
            }
        }
        assertTrue(imageStored, "画像は新しい SOP UID で保管されている");
        assertEquals(newImg, referenced, "SR の参照 UID が画像の新しい SOP UID と一致する");
    }

    @Test
    void burnedInAnnotation_isRefused_andNothingRemains() throws Exception {
        Path incoming = tmp.resolve("in-burn");
        Attributes ds = ct(PID, "1.2.826.10.1", "1.2.826.10.1.1", "1.2.826.10.1.1.1");
        ds.setString(Tag.BurnedInAnnotation, VR.CS, "YES");
        long before = byPatientPrefix().size();

        int port = freePort();
        DicomScpServer scp = start(anonymizer, incoming, port);
        try {
            var r = send(port, write(ds));
            assertFalse(r.success(), "送った側に失敗が返る");
        } finally {
            scp.stop();
        }
        assertEquals(before, byPatientPrefix().size(), "保管庫に入らない");
        assertEquals(0, storage.findMatches(null, "1.2.826.10.1", null, null).size());
        assertEquals(0, fileCount(incoming), "incoming にも残らない");
        var st = anonymizer.status();
        assertTrue(st.recentRejections().contains("burned-in-annotation"), "理由が記録に出る");
        assertFalse(st.recentRejections().toString().contains(NAME) || st.recentRejections().toString().contains(PID),
                "記録に患者情報を書かない");
    }

    @Test
    void burnProneModalityWithoutAttribute_isRefused_butCtIsAccepted() throws Exception {
        Attributes us = ct(PID, "1.2.826.11.1", "1.2.826.11.1.1", "1.2.826.11.1.1.1");
        us.setString(Tag.Modality, VR.CS, "US");
        int port = freePort();
        DicomScpServer scp = start(anonymizer, tmp.resolve("in-us"), port);
        try {
            assertFalse(send(port, write(us)).success(), "属性なしの US は受けない");
            assertTrue(send(port, write(ct(PID, "1.2.826.11.2", "1.2.826.11.2.1", "1.2.826.11.2.1.1"))).success(),
                    "CT は受ける");
            Attributes usNo = ct(PID, "1.2.826.11.3", "1.2.826.11.3.1", "1.2.826.11.3.1.1");
            usNo.setString(Tag.Modality, VR.CS, "US");
            usNo.setString(Tag.BurnedInAnnotation, VR.CS, "NO");
            assertTrue(send(port, write(usNo)).success(), "BurnedInAnnotation=NO と明示された US は受ける");
        } finally {
            scp.stop();
        }
    }

    @Test
    void invalidProfile_refusesEverything_andFailureLeavesNoOriginal() throws Exception {
        settings.putAll(Map.of(ReceiveAnonymizer.PROFILE_KEY, "{\"options\":[\"NoSuchOption\"]}"));
        Path incoming = tmp.resolve("in-bad");
        int port = freePort();
        DicomScpServer scp = start(anonymizer, incoming, port);
        try {
            assertFalse(send(port, write(ct(PID, "1.2.826.12.1", "1.2.826.12.1.1", "1.2.826.12.1.1.1"))).success(),
                    "不正な設定のときは緩い設定で受けず、断る");
        } finally {
            scp.stop();
        }
        assertEquals(0, storage.findMatches(null, "1.2.826.12.1", null, null).size());
        assertEquals(0, fileCount(incoming));
        // 読めない DICOM は、例外を投げて原本の一時ファイルも消す
        Path junk = Files.createDirectories(tmp.resolve("junk")).resolve("x");
        Files.writeString(junk, "not dicom");
        settings.putAll(Map.of(ReceiveAnonymizer.PROFILE_KEY, ""));
        assertThrows(IOException.class, () -> anonymizer.process(junk, "SENDER"));
        assertFalse(Files.exists(junk), "失敗したら原本の一時ファイルを残さない");
    }

    @Test
    void cleanPixelData_isNotAllowed_butOtherCleanOptionsAre() throws Exception {
        // 負例: 受信時は画素を消さないので、CleanPixelData は設定として認めない（保存前の検査・受信・状態の 3 経路）
        String bad = "{\"options\":[\"CleanPixelData\"]}";
        assertThrows(Exception.class, () -> anonymizer.validate(bad));
        settings.putAll(Map.of(ReceiveAnonymizer.PROFILE_KEY, bad));
        assertFalse(anonymizer.status().profileValid());
        Path incoming = tmp.resolve("in-pixel");
        int port = freePort();
        DicomScpServer scp = start(anonymizer, incoming, port);
        try {
            assertFalse(send(port, write(ct(PID, "1.2.826.13.1", "1.2.826.13.1.1", "1.2.826.13.1.1.1"))).success(),
                    "CleanPixelData が入った設定のときは、画素が消えたと誤解させないよう受けない");
        } finally {
            scp.stop();
        }
        assertEquals(0, storage.findMatches(null, "1.2.826.13.1", null, null).size());
        assertEquals(0, fileCount(incoming));

        // 正例: 他のクリーン系は通る
        String ok = "{\"options\":[\"CleanDescriptors\",\"CleanGraphics\"]}";
        anonymizer.validate(ok);
        settings.putAll(Map.of(ReceiveAnonymizer.PROFILE_KEY, ok));
        assertTrue(anonymizer.status().profileValid());
    }

    @Test
    void disabled_behavesAsBefore_andSwitchesWithoutRestart() throws Exception {
        int port = freePort();
        DicomScpServer scp = start(anonymizer, tmp.resolve("in-off"), port);
        try {
            settings.putAll(Map.of(ReceiveAnonymizer.ENABLED_KEY, "false"));
            assertTrue(send(port, write(ct("OFF-PID", "1.2.826.13.1", "1.2.826.13.1.1", "1.2.826.13.1.1.1"))).success());
            assertEquals(1, storage.findMatches("OFF-PID", "1.2.826.13.1", null, null).size(),
                    "オフのときは元の UID・患者 ID のまま保管される");

            settings.putAll(Map.of(ReceiveAnonymizer.ENABLED_KEY, "true"));
            assertTrue(send(port, write(ct("ON-PID", "1.2.826.13.2", "1.2.826.13.2.1", "1.2.826.13.2.1.1"))).success());
            assertEquals(0, storage.findMatches("ON-PID", null, null, null).size(), "オンにしたら次の受信から匿名化される");
            assertEquals(0, storage.findMatches(null, "1.2.826.13.2", null, null).size());
        } finally {
            scp.stop();
        }
    }

    @Test
    void sweepIncoming_removesLeftovers_andStatusDoesNotCreateAKey() throws Exception {
        Path dir = Files.createDirectories(tmp.resolve("in-sweep"));
        Files.writeString(dir.resolve("leftover"), "x");
        assertEquals(1, anonymizer.sweepIncoming(dir));
        assertEquals(0, fileCount(dir));

        Path keyPath = tmp.resolve("keys2/none.key");
        ReceiveAnonymizer fresh = new ReceiveAnonymizer(settings, keyPath.toString());
        assertEquals(null, fresh.status().keyCreatedAt(), "状態を見るだけでは鍵を作らない");
        assertFalse(Files.exists(keyPath));
    }

    @Test
    void timing_enabledVsDisabled_100Images() throws Exception {
        int n = 100;
        List<Path> files = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            files.add(write(ct("TIME-PID", "1.2.826.14.1", "1.2.826.14.1.1", "1.2.826.14.1.1." + i)));
        }
        // 実行順（JIT の暖機・ファイルキャッシュ）の影響を避けるため、オフ→オンを 2 往復して後半を採る。
        long[] ms = new long[2];
        for (int round = 0; round < 4; round++) {
            int mode = round % 2;
            settings.putAll(Map.of(ReceiveAnonymizer.ENABLED_KEY, mode == 0 ? "false" : "true"));
            int port = freePort();
            DicomScpServer scp = start(anonymizer, tmp.resolve("in-time" + round), port);
            long t0 = System.nanoTime();
            try {
                var r = new DicomStoreScu().storeAll("127.0.0.1", port, "GRAPHYSTORE", "SENDER", files, null);
                assertEquals(n, r.sent(), () -> String.valueOf(r.messages()));
            } finally {
                scp.stop();
            }
            ms[mode] = (System.nanoTime() - t0) / 1_000_000;
        }
        System.out.println("[timing] 100 images: off=" + ms[0] + "ms on=" + ms[1] + "ms");
    }
}

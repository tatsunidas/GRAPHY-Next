/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.MoveScpClient.Moved;
import com.vis.graphynext.dicom.store.CompressedFixtures;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.net.Status;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 他端末からの取得（C-MOVE SCP）を、実際にリスナーを起動し、dcm4che の SCU から要求して検証する。
 * 宛先は、テスト内の別実装の C-STORE SCP（{@link MoveReceiver}）。届いた SOP UID と転送構文を数える。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:movescp;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class DicomMoveScpTest {

    private static final String STUDY_ROOT = UID.StudyRootQueryRetrieveInformationModelMove;
    private static final String PATIENT_ROOT = UID.PatientRootQueryRetrieveInformationModelMove;
    private static final String CALLER = "WORKSTN1";
    private static final String DEST = "RCVSCP";

    @Autowired
    DicomStorageService storage;
    @Autowired
    DicomQrAccess access;
    @Autowired
    DicomMoveTargets targets;
    @Autowired
    DicomRemoteAeService remoteAes;
    @Autowired
    DicomLocalAeService localAe;
    @Autowired
    DicomTlsService tlsService;
    @Autowired
    PixelCodec codec;
    @Autowired
    SettingsService settings;
    @Autowired
    com.vis.graphynext.dicom.store.DicomInstanceRepository repo;

    @TempDir
    Path tmp;

    private DicomScpServer scp;
    private int port;
    private final java.util.List<MoveReceiver> receivers = new java.util.ArrayList<>();

    // ---- 合成データ ----
    //  PERFA : 1.9.1 (シリーズ 1.9.1.1 に 2 枚、1.9.1.2 に 1 枚)
    //  OTHERC: 1.9.3 (1.9.3.1 に 3 枚)、1.9.4 (1.9.4.1 に 1 枚)
    @BeforeEach
    void setUp() throws Exception {
        put("PERFA", "1.9.1", "1.9.1.1", "1.9.1.1.1");
        put("PERFA", "1.9.1", "1.9.1.1", "1.9.1.1.2");
        put("PERFA", "1.9.1", "1.9.1.2", "1.9.1.2.1");
        for (int i = 1; i <= 3; i++) {
            put("OTHERC", "1.9.3", "1.9.3.1", "1.9.3.1." + i);
        }
        put("OTHERC", "1.9.4", "1.9.4.1", "1.9.4.1.1");

        reset();
        port = freePort();
        scp = new DicomScpServer("GRAPHYNEXT", "127.0.0.1", port);
        scp.addService(new DicomMoveScp(access, targets, remoteAes, localAe, tlsService, codec), DicomMoveScp.capabilities());
        scp.start();
    }

    @AfterEach
    void tearDown() {
        if (scp != null) {
            scp.stop();
        }
        for (MoveReceiver r : receivers) {
            r.close();
        }
        reset();
        repo.deleteAll();
    }

    // ---------------------------------------------------------------- 正例

    @Test
    void studyLevel_sendsEveryInstanceOfTheStudy_toTheRegisteredDestination() throws Exception {
        MoveReceiver rx = registerDestination(0, UID.ExplicitVRLittleEndian, UID.ImplicitVRLittleEndian);
        allowCaller();
        Moved m = move(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.9.1"));
        assertEquals(Status.Success, m.status());
        assertEquals(3, m.completed());
        assertEquals(0, m.failed());
        assertEquals(Set.of("1.9.1.1.1", "1.9.1.1.2", "1.9.1.2.1"), rx.received.keySet());
        assertTrue(m.pendings() >= 1, "途中経過（Pending）が返る");
    }

    @Test
    void seriesLevel_sendsOnlyThatSeries() throws Exception {
        MoveReceiver rx = registerDestination(0, UID.ExplicitVRLittleEndian);
        allowCaller();
        Moved m = move(STUDY_ROOT, keys("SERIES", Tag.StudyInstanceUID, "1.9.1", Tag.SeriesInstanceUID, "1.9.1.1"));
        assertEquals(Status.Success, m.status());
        assertEquals(Set.of("1.9.1.1.1", "1.9.1.1.2"), rx.received.keySet(), "別シリーズ 1.9.1.2.1 は送らない");
    }

    @Test
    void imageLevel_sendsOnlyThatInstance() throws Exception {
        MoveReceiver rx = registerDestination(0, UID.ExplicitVRLittleEndian);
        allowCaller();
        Moved m = move(STUDY_ROOT, keys("IMAGE", Tag.StudyInstanceUID, "1.9.3", Tag.SeriesInstanceUID, "1.9.3.1",
                Tag.SOPInstanceUID, "1.9.3.1.2"));
        assertEquals(Status.Success, m.status());
        assertEquals(Set.of("1.9.3.1.2"), rx.received.keySet());
    }

    @Test
    void patientRoot_patientLevel_sendsEveryStudyOfThePatient() throws Exception {
        MoveReceiver rx = registerDestination(0, UID.ExplicitVRLittleEndian);
        allowCaller();
        Moved m = move(PATIENT_ROOT, keys("PATIENT", Tag.PatientID, "OTHERC"));
        assertEquals(Status.Success, m.status());
        assertEquals(Set.of("1.9.3.1.1", "1.9.3.1.2", "1.9.3.1.3", "1.9.4.1.1"), rx.received.keySet(),
                "OTHERC の 2 スタディ全部。PERFA は送らない");
    }

    @Test
    void multipleStudyUids_sendEachOfThem() throws Exception {
        MoveReceiver rx = registerDestination(0, UID.ExplicitVRLittleEndian);
        allowCaller();
        Moved m = move(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.9.1\\1.9.4"));
        assertEquals(Status.Success, m.status());
        assertEquals(Set.of("1.9.1.1.1", "1.9.1.1.2", "1.9.1.2.1", "1.9.4.1.1"), rx.received.keySet());
    }

    @Test
    void unknownUid_isASuccessWithNothingSent() throws Exception {
        MoveReceiver rx = registerDestination(0, UID.ExplicitVRLittleEndian);
        allowCaller();
        Moved m = move(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "9.9.9.9"));
        assertEquals(Status.Success, m.status());
        assertTrue(rx.received.isEmpty());
    }

    @Test
    void anIndexedInstanceWhoseFileIsGone_isCountedAsFailed_andTheRestIsStillSent() throws Exception {
        MoveReceiver rx = registerDestination(0, UID.ExplicitVRLittleEndian);
        allowCaller();
        Path gone = storage.resolveInstanceFile("1.9.1.1.2");
        assertTrue(gone != null && Files.exists(gone), "前提: ファイルが実在する");
        Files.delete(gone);
        Moved m = move(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.9.1"));
        assertEquals(0xB000, m.status(), "一部失敗は警告");
        assertEquals(2, m.completed());
        assertEquals(1, m.failed());
        assertEquals(Set.of("1.9.1.1.1", "1.9.1.2.1"), rx.received.keySet());
    }

    @Test
    void aCompressedImage_isDecodedForADestinationThatOnlyTakesExplicitVrLittleEndian() throws Exception {
        Assumptions.assumeTrue(codec.available(), "OpenCV ネイティブが無い環境: " + codec.unavailableReason());
        String sop = "1.2.826.0.1.3680043.10.1338.7201";
        Attributes ds = CompressedFixtures.ct(sop, "COMPPID");
        storage.ingest(CompressedFixtures.compressed(Files.createTempFile("mv", ".dcm"), ds, UID.JPEGLSLossless));
        MoveReceiver rx = registerDestination(0, UID.ExplicitVRLittleEndian);
        allowCaller();
        Moved m = move(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.2.826.0.1.3680043.10.1338.7001"));
        assertEquals(Status.Success, m.status());
        assertEquals(UID.ExplicitVRLittleEndian, rx.received.get(sop), "復号して Explicit VR LE で届く");
    }

    @Test
    void aCompressedImage_isSentAsIsToADestinationThatTakesTheStoredSyntax() throws Exception {
        Assumptions.assumeTrue(codec.available(), "OpenCV ネイティブが無い環境: " + codec.unavailableReason());
        String sop = "1.2.826.0.1.3680043.10.1338.7202";
        Attributes ds = CompressedFixtures.ct(sop, "COMPPID");
        storage.ingest(CompressedFixtures.compressed(Files.createTempFile("mv", ".dcm"), ds, UID.JPEGLSLossless));
        MoveReceiver rx = registerDestination(0, UID.JPEGLSLossless, UID.ExplicitVRLittleEndian);
        allowCaller();
        Moved m = move(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.2.826.0.1.3680043.10.1338.7001"));
        assertEquals(Status.Success, m.status());
        assertEquals(UID.JPEGLSLossless, rx.received.get(sop), "復号せず圧縮のまま届く");
    }

    // ---------------------------------------------------------------- 負例

    @Test
    void anUnlistedCaller_isRefusedWith0xC000_andNothingIsSent() throws Exception {
        MoveReceiver rx = registerDestination(0, UID.ExplicitVRLittleEndian);
        // CALLER は登録しない（宛先 RCVSCP だけが登録されている）
        Moved m = move(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.9.1"));
        assertEquals(0xC000, m.status());
        assertTrue(rx.received.isEmpty(), "許可外には何も送らない");
    }

    @Test
    void anUnregisteredDestination_isRefusedWith0xA801_evenWhenEveryCallerIsAllowed() throws Exception {
        MoveReceiver rx = registerDestination(0, UID.ExplicitVRLittleEndian);
        settings.putAll(Map.of(DicomQrAccess.ALLOW_ALL_KEY, "true"));
        Moved m = move(STUDY_ROOT, "UNKNOWNAE", keys("STUDY", Tag.StudyInstanceUID, "1.9.1"));
        assertEquals(Status.MoveDestinationUnknown, m.status());
        assertTrue(rx.received.isEmpty(), "未登録の宛先へは送らない");
    }

    @Test
    void aMissingUniqueKey_isRefusedWith0xA900() throws Exception {
        MoveReceiver rx = registerDestination(0, UID.ExplicitVRLittleEndian);
        allowCaller();
        assertEquals(Status.IdentifierDoesNotMatchSOPClass, move(STUDY_ROOT, keys("STUDY")).status(), "StudyInstanceUID が無い");
        assertEquals(Status.IdentifierDoesNotMatchSOPClass,
                move(STUDY_ROOT, keys("SERIES", Tag.SeriesInstanceUID, "1.9.1.1")).status(), "SERIES に StudyInstanceUID が無い");
        assertEquals(Status.IdentifierDoesNotMatchSOPClass,
                move(STUDY_ROOT, keys("PATIENT", Tag.PatientID, "PERFA")).status(), "Study Root には PATIENT レベルが無い");
        assertTrue(rx.received.isEmpty());
    }

    @Test
    void aWildcardIsNotExpanded_soItMatchesNothing() throws Exception {
        MoveReceiver rx = registerDestination(0, UID.ExplicitVRLittleEndian);
        allowCaller();
        Moved m = move(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.9.*"));
        assertEquals(Status.Success, m.status());
        assertTrue(rx.received.isEmpty(), "取得は一意キーだけで引く。* で全件を送らせない");
    }

    @Test
    void aDestinationThatCannotBeReached_failsWithoutSendingAnything() throws Exception {
        int dead = freePort(); // 何も待ち受けていない
        registerRaw(DEST, dead, false);
        allowCaller();
        Moved m = move(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.9.1"));
        assertEquals(Status.UnableToPerformSubOperations, m.status());
    }

    @Test
    void aTlsDestination_isNotSentToInPlaintextWhenTlsIsNotConfigured() throws Exception {
        MoveReceiver rx = new MoveReceiver(freePort(), null, 0, UID.ExplicitVRLittleEndian);
        receivers.add(rx);
        registerRaw(DEST, rx.port, true);
        allowCaller();
        Moved m = move(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.9.1"));
        assertEquals(Status.UnableToPerformSubOperations, m.status());
        assertTrue(rx.received.isEmpty(), "TLS を要する宛先へ平文で送らない");
        assertEquals(0, rx.associations.get(), "接続も張らない");
    }

    @Test
    void aDestinationThatTakesNeitherSyntax_countsTheCompressedImageAsFailed() throws Exception {
        Assumptions.assumeTrue(codec.available(), "OpenCV ネイティブが無い環境: " + codec.unavailableReason());
        String sop = "1.2.826.0.1.3680043.10.1338.7203";
        Attributes ds = CompressedFixtures.ct(sop, "COMPPID");
        storage.ingest(CompressedFixtures.compressed(Files.createTempFile("mv", ".dcm"), ds, UID.JPEGLSLossless));
        // 圧縮画像の保管構文（JPEG-LS）も Explicit VR LE も受けない相手。画像の SOP クラス自体は受ける
        MoveReceiver rx = registerDestination(0, UID.ImplicitVRLittleEndian);
        allowCaller();
        Moved m = move(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.2.826.0.1.3680043.10.1338.7001"));
        assertFalse(m.status() == Status.Success, "全件失敗は成功にしない");
        assertEquals(1, m.failed());
        assertTrue(rx.received.isEmpty());
    }

    // ---------------------------------------------------------------- 中止

    @Test
    void cancel_stopsTheTransferBeforeEverythingIsSent() throws Exception {
        for (int i = 1; i <= 120; i++) {
            put("BIGPID", "1.9.50", "1.9.50.1", "1.9.50.1." + i);
        }
        MoveReceiver rx = registerDestination(20, UID.ExplicitVRLittleEndian); // 1 枚ごとに 20 ms かかる相手
        allowCaller();
        Moved m = move(STUDY_ROOT, DEST, keys("STUDY", Tag.StudyInstanceUID, "1.9.50"), 3);
        assertEquals(Status.Cancel, m.status());
        assertTrue(rx.received.size() >= 1 && rx.received.size() < 120,
                "途中で止まる（届いたのは " + rx.received.size() + " / 120）");
    }

    // ---------------------------------------------------------------- 補助

    private Moved move(String cuid, Attributes keys) throws Exception {
        return move(cuid, DEST, keys, 0);
    }

    private Moved move(String cuid, String dest, Attributes keys) throws Exception {
        return move(cuid, dest, keys, 0);
    }

    private Moved move(String cuid, String dest, Attributes keys, int cancelAfter) throws Exception {
        return MoveScpClient.move(port, cuid, CALLER, dest, keys, cancelAfter);
    }

    /** 宛先（RCVSCP）の受け口を立て、登録済みの相手先に加える。 */
    private MoveReceiver registerDestination(long delayMillis, String... acceptTs) throws Exception {
        MoveReceiver rx = new MoveReceiver(freePort(), null, delayMillis, acceptTs);
        receivers.add(rx);
        registerRaw(DEST, rx.port, false);
        return rx;
    }

    private String registered = "";

    private void registerRaw(String aet, int p, boolean tls) {
        registered += (registered.isEmpty() ? "" : ",")
                + "{\"aeTitle\":\"" + aet + "\",\"host\":\"127.0.0.1\",\"port\":" + p + ",\"tls\":" + tls + "}";
        settings.putAll(Map.of(DicomController.REMOTE_AES_KEY, "[" + registered + "]"));
    }

    /** 呼び出し側（WORKSTN1）を、相手先の一覧に加えて許可する。 */
    private void allowCaller() {
        registerRaw(CALLER, 104, false);
    }

    private void reset() {
        registered = "";
        settings.putAll(Map.of(DicomController.REMOTE_AES_KEY, "", DicomQrAccess.ALLOW_ALL_KEY, "",
                DicomQrAccess.ENABLED_KEY, ""));
    }

    private static Attributes keys(String level, Object... kv) {
        Attributes k = new Attributes();
        k.setString(Tag.QueryRetrieveLevel, VR.CS, level);
        for (int i = 0; i < kv.length; i += 2) {
            int tag = (Integer) kv[i];
            k.setString(tag, org.dcm4che3.data.ElementDictionary.vrOf(tag, null), (String) kv[i + 1]);
        }
        return k;
    }

    private void put(String pid, String study, String series, String sop) throws Exception {
        Attributes a = DicomPhantomFactory.scImage(pid, study, series, sop);
        a.setString(Tag.Modality, VR.CS, "CT");
        a.setString(Tag.SeriesNumber, VR.IS, "1");
        a.setString(Tag.InstanceNumber, VR.IS, "1");
        Path f = Files.createTempFile("move", ".dcm");
        storage.ingest(DicomPhantomFactory.writeFile(f, a, UID.ExplicitVRLittleEndian));
    }

    private static int freePort() {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        } catch (Exception e) {
            throw new IllegalStateException("free port を確保できませんでした", e);
        }
    }
}

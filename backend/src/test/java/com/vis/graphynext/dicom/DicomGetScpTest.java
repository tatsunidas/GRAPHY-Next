/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.anonymize.PixelCodec;
import com.vis.graphynext.dicom.GetScpClient.Got;
import com.vis.graphynext.dicom.store.CompressedFixtures;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.net.Status;
import org.dcm4che3.net.TransferCapability;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 他端末からの取得（C-GET SCP）を、実際にリスナーを起動し、dcm4che の SCU から要求して検証する。
 * 画像は要求を受けた接続の上で返る（宛先への逆接続は無い）。相手が役割選択を出さなければ返さない。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:getscp;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class DicomGetScpTest {

    private static final String STUDY_ROOT = UID.StudyRootQueryRetrieveInformationModelGet;
    private static final String PATIENT_ROOT = UID.PatientRootQueryRetrieveInformationModelGet;
    private static final String CALLER = "WORKSTN1";
    private static final List<String> STORAGE = List.of(UID.SecondaryCaptureImageStorage, UID.CTImageStorage);

    @Autowired
    DicomStorageService storage;
    @Autowired
    DicomQrAccess access;
    @Autowired
    DicomMoveTargets targets;
    @Autowired
    DicomProperties props;
    @Autowired
    PixelCodec codec;
    @Autowired
    SettingsService settings;
    @Autowired
    DicomRemoteAeService remoteAes;
    @Autowired
    com.vis.graphynext.dicom.store.DicomInstanceRepository repo;

    private DicomScpServer scp;
    private int port;
    private String registered = "";

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
        // DicomScpLifecycle と同じ登録（C-GET ＋ 保存 SOP クラスの SCU ロール）
        List<TransferCapability> caps = new ArrayList<>(List.of(DicomGetScp.capabilities()));
        caps.addAll(StorageSopClasses.scuCapabilities(props.getStorageSopClassesResource()));
        scp.addService(new DicomGetScp(access, targets, codec), caps.toArray(TransferCapability[]::new));
        scp.start();
    }

    @AfterEach
    void tearDown() {
        if (scp != null) {
            scp.stop();
        }
        reset();
        repo.deleteAll();
    }

    // ---------------------------------------------------------------- 正例

    @Test
    void studyLevel_returnsEveryInstanceOfTheStudy_onTheSameAssociation() throws Exception {
        allowCaller();
        Got g = get(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.9.1"), 0, true, UID.ExplicitVRLittleEndian);
        assertTrue(g.roleAccepted(), "役割選択が受理される");
        assertEquals(Status.Success, g.status());
        assertEquals(3, g.completed());
        assertEquals(0, g.failed());
        assertEquals(Set.of("1.9.1.1.1", "1.9.1.1.2", "1.9.1.2.1"), g.received().keySet());
        assertEquals(1, g.storeAssociations(), "画像は要求を受けた接続の上で返る");
        assertTrue(g.pendings() >= 1, "途中経過（Pending）が返る");
    }

    @Test
    void seriesAndImageLevels_returnOnlyWhatWasAsked() throws Exception {
        allowCaller();
        Got s = get(STUDY_ROOT, keys("SERIES", Tag.StudyInstanceUID, "1.9.1", Tag.SeriesInstanceUID, "1.9.1.1"), 0, true,
                UID.ExplicitVRLittleEndian);
        assertEquals(Set.of("1.9.1.1.1", "1.9.1.1.2"), s.received().keySet());
        Got i = get(STUDY_ROOT, keys("IMAGE", Tag.StudyInstanceUID, "1.9.3", Tag.SeriesInstanceUID, "1.9.3.1",
                Tag.SOPInstanceUID, "1.9.3.1.2"), 0, true, UID.ExplicitVRLittleEndian);
        assertEquals(Set.of("1.9.3.1.2"), i.received().keySet());
    }

    @Test
    void patientRoot_patientLevel_returnsEveryStudyOfThePatient() throws Exception {
        allowCaller();
        Got g = get(PATIENT_ROOT, keys("PATIENT", Tag.PatientID, "OTHERC"), 0, true, UID.ExplicitVRLittleEndian);
        assertEquals(Status.Success, g.status());
        assertEquals(Set.of("1.9.3.1.1", "1.9.3.1.2", "1.9.3.1.3", "1.9.4.1.1"), g.received().keySet());
    }

    @Test
    void unknownUid_isASuccessWithNothingReturned() throws Exception {
        allowCaller();
        Got g = get(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "9.9.9.9"), 0, true, UID.ExplicitVRLittleEndian);
        assertEquals(Status.Success, g.status());
        assertTrue(g.received().isEmpty());
    }

    @Test
    void aCompressedImage_isDecodedForAPeerThatOnlyTakesExplicitVrLittleEndian() throws Exception {
        Assumptions.assumeTrue(codec.available(), "OpenCV ネイティブが無い環境: " + codec.unavailableReason());
        String sop = "1.2.826.0.1.3680043.10.1338.7301";
        Attributes ds = CompressedFixtures.ct(sop, "COMPPID");
        storage.ingest(CompressedFixtures.compressed(Files.createTempFile("gt", ".dcm"), ds, UID.JPEGLSLossless));
        allowCaller();
        Got g = get(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.2.826.0.1.3680043.10.1338.7001"), 0, true,
                UID.ExplicitVRLittleEndian);
        assertEquals(Status.Success, g.status());
        assertEquals(UID.ExplicitVRLittleEndian, g.received().get(sop), "復号して Explicit VR LE で届く");
    }

    // ---------------------------------------------------------------- 負例

    @Test
    void aPeerThatDoesNotOfferRoleSelection_getsNoImage_andTheFailureIsReported() throws Exception {
        allowCaller();
        Got g = get(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.9.1"), 0, false, UID.ExplicitVRLittleEndian);
        assertFalse(g.roleAccepted());
        assertTrue(g.received().isEmpty(), "役割選択が無ければ画像は返さない");
        assertFalse(g.status() == Status.Success, "全件失敗は成功にしない");
        assertEquals(3, g.failed(), "黙って落とさず、失敗として数える");
    }

    @Test
    void anUnlistedCaller_isRefusedWith0xC000_andNothingIsReturned() throws Exception {
        // CALLER は登録しない
        Got g = get(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.9.1"), 0, true, UID.ExplicitVRLittleEndian);
        assertEquals(0xC000, g.status());
        assertTrue(g.received().isEmpty());
    }

    @Test
    void whenEveryCallerIsAllowed_anUnlistedCallerIsServed() throws Exception {
        settings.putAll(Map.of(DicomQrAccess.ALLOW_ALL_KEY, "true"));
        Got g = get(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.9.1"), 0, true, UID.ExplicitVRLittleEndian);
        assertEquals(Status.Success, g.status());
        assertEquals(3, g.received().size());
    }

    @Test
    void aMissingUniqueKey_isRefusedWith0xA900() throws Exception {
        allowCaller();
        assertEquals(Status.IdentifierDoesNotMatchSOPClass,
                get(STUDY_ROOT, keys("STUDY"), 0, true, UID.ExplicitVRLittleEndian).status());
        assertEquals(Status.IdentifierDoesNotMatchSOPClass,
                get(STUDY_ROOT, keys("PATIENT", Tag.PatientID, "PERFA"), 0, true, UID.ExplicitVRLittleEndian).status(),
                "Study Root には PATIENT レベルが無い");
    }

    @Test
    void aWildcardIsNotExpanded_soItMatchesNothing() throws Exception {
        allowCaller();
        Got g = get(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.9.*"), 0, true, UID.ExplicitVRLittleEndian);
        assertEquals(Status.Success, g.status());
        assertTrue(g.received().isEmpty(), "取得は一意キーだけで引く。* で全件を返さない");
    }

    @Test
    void aSopClassThePeerDoesNotAccept_isCountedAsFailed() throws Exception {
        allowCaller();
        // 相手は CT だけを受ける。保存されているのは SC 画像なので、受け付けられない
        Got g = GetScpClient.get(port, STUDY_ROOT, CALLER, keys("STUDY", Tag.StudyInstanceUID, "1.9.1"), 0,
                List.of(UID.CTImageStorage), true, UID.ExplicitVRLittleEndian);
        assertTrue(g.received().isEmpty());
        assertFalse(g.status() == Status.Success);
        assertEquals(3, g.failed());
    }

    @Test
    void aTransferSyntaxThePeerDoesNotAccept_isCountedAsFailed() throws Exception {
        Assumptions.assumeTrue(codec.available(), "OpenCV ネイティブが無い環境: " + codec.unavailableReason());
        String sop = "1.2.826.0.1.3680043.10.1338.7302";
        Attributes ds = CompressedFixtures.ct(sop, "COMPPID");
        storage.ingest(CompressedFixtures.compressed(Files.createTempFile("gt", ".dcm"), ds, UID.JPEGLSLossless));
        allowCaller();
        // JPEG-LS も Explicit VR LE も受けない相手
        Got g = get(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.2.826.0.1.3680043.10.1338.7001"), 0, true,
                UID.ImplicitVRLittleEndian);
        assertEquals(1, g.failed());
        assertTrue(g.received().isEmpty());
    }

    // ---------------------------------------------------------------- 中止

    @Test
    void cancel_stopsTheTransferBeforeEverythingIsReturned() throws Exception {
        for (int i = 1; i <= 120; i++) {
            put("BIGPID", "1.9.50", "1.9.50.1", "1.9.50.1." + i);
        }
        allowCaller();
        Got g = get(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.9.50"), 3, true, UID.ExplicitVRLittleEndian);
        assertEquals(Status.Cancel, g.status());
        assertTrue(g.received().size() >= 1 && g.received().size() < 120,
                "途中で止まる（届いたのは " + g.received().size() + " / 120）");
    }

    // ---------------------------------------------------------------- 補助

    private Got get(String cuid, Attributes keys, int cancelAfter, boolean roleSelection, String... acceptTs)
            throws Exception {
        return GetScpClient.get(port, cuid, CALLER, keys, cancelAfter, STORAGE, roleSelection, acceptTs);
    }

    private void allowCaller() {
        registered += (registered.isEmpty() ? "" : ",")
                + "{\"aeTitle\":\"" + CALLER + "\",\"host\":\"127.0.0.1\",\"port\":104,\"tls\":false}";
        settings.putAll(Map.of(DicomController.REMOTE_AES_KEY, "[" + registered + "]"));
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
        Path f = Files.createTempFile("get", ".dcm");
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

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.FindScpClient.Found;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.DicomStoreScp;
import com.vis.graphynext.dicom.store.DicomStoreScu;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.ElementDictionary;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.net.Status;
import org.dcm4che3.net.TransferCapability;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 他端末からの検索（C-FIND SCP）を、実際にリスナーを起動し、dcm4che の SCU（別実装のクライアント側）から
 * 問い合わせて検証する。索引は H2 に合成の DICOM を取り込んで作る。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:findscp;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class DicomFindScpTest {

    private static final String STUDY_ROOT = UID.StudyRootQueryRetrieveInformationModelFind;
    private static final String PATIENT_ROOT = UID.PatientRootQueryRetrieveInformationModelFind;
    private static final String CALLER = "WORKSTN1";

    @Autowired
    DicomStorageService storage;
    @Autowired
    DicomQrAccess access;
    @Autowired
    DicomFindQuery findQuery;
    @Autowired
    SettingsService settings;
    @Autowired
    com.vis.graphynext.dicom.store.DicomInstanceRepository repo;

    @TempDir
    Path tmp;

    private DicomScpServer scp;
    private int port;

    // ---- 合成データ: 患者 3・スタディ 4 ----
    //  PERFA YAMADA^TARO  : 1.9.1 (20260105, ACC1, CT×2 シリーズ 1.9.1.1 と MR×1 シリーズ 1.9.1.2)
    //  PERFB 山田^花子     : 1.9.2 (20260320, ACC2, MR×1)
    //  OTHERC SATO^ICHIRO : 1.9.3 (20260610, ACC3, CT×3)、1.9.4 (20251231, ACC4, CT×1)
    @BeforeEach
    void setUp() throws Exception {
        put("PERFA", "YAMADA^TARO", "1.9.1", "20260105", "ACC1", "CT", "1.9.1.1", 1, "1.9.1.1.1", 1);
        put("PERFA", "YAMADA^TARO", "1.9.1", "20260105", "ACC1", "CT", "1.9.1.1", 1, "1.9.1.1.2", 2);
        put("PERFA", "YAMADA^TARO", "1.9.1", "20260105", "ACC1", "MR", "1.9.1.2", 2, "1.9.1.2.1", 1);
        put("PERFB", "山田^花子", "1.9.2", "20260320", "ACC2", "MR", "1.9.2.1", 1, "1.9.2.1.1", 1);
        for (int i = 1; i <= 3; i++) {
            put("OTHERC", "SATO^ICHIRO", "1.9.3", "20260610", "ACC3", "CT", "1.9.3.1", 1, "1.9.3.1." + i, i);
        }
        put("OTHERC", "SATO^ICHIRO", "1.9.4", "20251231", "ACC4", "CT", "1.9.4.1", 1, "1.9.4.1.1", 1);

        reset();
        port = freePort();
        scp = new DicomScpServer("GRAPHYNEXT", "127.0.0.1", port);
        scp.addService(new DicomFindScp(access, findQuery), DicomFindScp.capabilities());
        scp.start();
        allowCaller(CALLER);
    }

    @AfterEach
    void tearDown() {
        if (scp != null) {
            scp.stop();
        }
        reset();
    }

    // ---------------------------------------------------------------- 正例

    @Test
    void studyLevel_returnsEveryStudy_withValuesMatchingTheIndex() throws Exception {
        Found r = find(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "", Tag.PatientID, "", Tag.PatientName, "",
                Tag.StudyDate, "", Tag.AccessionNumber, "", Tag.NumberOfStudyRelatedInstances, "",
                Tag.NumberOfStudyRelatedSeries, ""));
        assertEquals(Status.Success, r.status());
        assertEquals(Set.of("1.9.1", "1.9.2", "1.9.3", "1.9.4"), uids(r, Tag.StudyInstanceUID));

        Attributes s1 = one(r, Tag.StudyInstanceUID, "1.9.1");
        assertEquals("PERFA", s1.getString(Tag.PatientID));
        assertEquals("YAMADA^TARO", s1.getString(Tag.PatientName));
        assertEquals("20260105", s1.getString(Tag.StudyDate));
        assertEquals("ACC1", s1.getString(Tag.AccessionNumber));
        assertEquals(3, s1.getInt(Tag.NumberOfStudyRelatedInstances, -1), "1.9.1 は 3 枚");
        assertEquals(2, s1.getInt(Tag.NumberOfStudyRelatedSeries, -1), "1.9.1 は 2 シリーズ");
        assertEquals(3, one(r, Tag.StudyInstanceUID, "1.9.3").getInt(Tag.NumberOfStudyRelatedInstances, -1));
        assertEquals("STUDY", r.matches().get(0).getString(Tag.QueryRetrieveLevel), "要求のレベルを返す");
    }

    @Test
    void japaneseName_roundTripsThroughTheWire() throws Exception {
        // 前提: 索引に日本語が化けずに入っている（検索の不具合と取り込みの不具合を区別する）
        assertEquals("山田^花子", repo.findMatches("PERFB", null, null, null).get(0).getPatientName());
        Found r = find(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "", Tag.PatientName, "山田*"));
        assertEquals(Set.of("1.9.2"), uids(r, Tag.StudyInstanceUID), "YAMADA（ローマ字）は山田* に一致しない");
        assertEquals("山田^花子", r.matches().get(0).getString(Tag.PatientName), "UTF-8 で欠けずに返る");
    }

    @Test
    void wildcards_onPatientId() throws Exception {
        assertEquals(Set.of("1.9.1", "1.9.2"), studyUids(Tag.PatientID, "PERF*"));
        assertEquals(Set.of("1.9.1", "1.9.2"), studyUids(Tag.PatientID, "PERF?"));
        assertEquals(Set.of("1.9.1"), studyUids(Tag.PatientID, "PERFA"));
        assertEquals(Set.of("1.9.3", "1.9.4"), studyUids(Tag.PatientID, "*C"));
        // 負例: 部分一致ではない（先頭固定・? は 1 文字ちょうど）
        assertEquals(Set.of(), studyUids(Tag.PatientID, "ERF*"), "先頭は固定");
        assertEquals(Set.of(), studyUids(Tag.PatientID, "PERF??"), "? は 1 文字ちょうど（PERFA は 5 文字）");
        assertEquals(Set.of(), studyUids(Tag.PatientID, "PERF"), "ワイルドカード無しは完全一致");
    }

    @Test
    void patientName_isCaseInsensitive_patientId_isNot() throws Exception {
        assertEquals(Set.of("1.9.1"), studyUids(Tag.PatientName, "yamada*"));
        assertEquals(Set.of(), studyUids(Tag.PatientID, "perfa"), "PatientID は大文字小文字を区別する");
    }

    @Test
    void dateRange_exactAndOpenEnded() throws Exception {
        assertEquals(Set.of("1.9.1", "1.9.2"), studyUids(Tag.StudyDate, "20260101-20260331"));
        assertEquals(Set.of("1.9.2", "1.9.3"), studyUids(Tag.StudyDate, "20260320-"));
        assertEquals(Set.of("1.9.1", "1.9.4"), studyUids(Tag.StudyDate, "-20260105"));
        assertEquals(Set.of("1.9.1"), studyUids(Tag.StudyDate, "20260105"));
        assertEquals(Set.of("1.9.1"), studyUids(Tag.StudyDate, "20260105-20260105"), "両端を含む");
    }

    @Test
    void uidList_matchesAny() throws Exception {
        assertEquals(Set.of("1.9.1", "1.9.3"), studyUids(Tag.StudyInstanceUID, "1.9.1\\1.9.3"));
    }

    @Test
    void modalitiesInStudy_matchesAnyModalityOfTheStudy_andIsReturned() throws Exception {
        assertEquals(Set.of("1.9.1", "1.9.2"), studyUids(Tag.ModalitiesInStudy, "MR"));
        assertEquals(Set.of("1.9.1", "1.9.3", "1.9.4"), studyUids(Tag.ModalitiesInStudy, "CT"));
        Found r = find(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "1.9.1", Tag.ModalitiesInStudy, ""));
        assertEquals(Set.of("CT", "MR"), new HashSet<>(Arrays.asList(r.matches().get(0).getStrings(Tag.ModalitiesInStudy))));
    }

    @Test
    void seriesLevel_andImageLevel() throws Exception {
        Found series = find(STUDY_ROOT, keys("SERIES", Tag.StudyInstanceUID, "1.9.1", Tag.SeriesInstanceUID, "",
                Tag.Modality, "", Tag.SeriesNumber, "", Tag.NumberOfSeriesRelatedInstances, ""));
        assertEquals(Set.of("1.9.1.1", "1.9.1.2"), uids(series, Tag.SeriesInstanceUID));
        assertEquals(2, one(series, Tag.SeriesInstanceUID, "1.9.1.1").getInt(Tag.NumberOfSeriesRelatedInstances, -1));
        assertEquals("MR", one(series, Tag.SeriesInstanceUID, "1.9.1.2").getString(Tag.Modality));
        assertEquals(Set.of("1.9.1.2"), uids(find(STUDY_ROOT, keys("SERIES", Tag.StudyInstanceUID, "1.9.1",
                Tag.SeriesInstanceUID, "", Tag.Modality, "MR")), Tag.SeriesInstanceUID), "シリーズのモダリティで絞れる");

        Found images = find(STUDY_ROOT, keys("IMAGE", Tag.StudyInstanceUID, "1.9.3", Tag.SeriesInstanceUID, "1.9.3.1",
                Tag.SOPInstanceUID, "", Tag.InstanceNumber, ""));
        assertEquals(3, images.matches().size());
        assertEquals(Set.of("1.9.3.1.1", "1.9.3.1.2", "1.9.3.1.3"), uids(images, Tag.SOPInstanceUID));
        assertEquals(2, one(images, Tag.SOPInstanceUID, "1.9.3.1.2").getInt(Tag.InstanceNumber, -1));
        assertEquals(Set.of("1.9.3.1.3"), uids(find(STUDY_ROOT, keys("IMAGE", Tag.StudyInstanceUID, "1.9.3",
                Tag.SeriesInstanceUID, "1.9.3.1", Tag.SOPInstanceUID, "1.9.3.1.3")), Tag.SOPInstanceUID));
    }

    @Test
    void upperLevelKey_narrowsALowerLevelQuery() throws Exception {
        // シリーズレベルの問い合わせでも、上位（スタディ）の PatientID で絞れる。
        Found r = find(STUDY_ROOT, keys("SERIES", Tag.PatientID, "PERFB", Tag.SeriesInstanceUID, ""));
        assertEquals(Set.of("1.9.2.1"), uids(r, Tag.SeriesInstanceUID));
    }

    @Test
    void patientRoot_patientLevel_and_studyLevel() throws Exception {
        Found p = find(PATIENT_ROOT, keys("PATIENT", Tag.PatientID, "PERF*", Tag.PatientName, "",
                Tag.NumberOfPatientRelatedStudies, ""));
        assertEquals(Status.Success, p.status(), "Patient Root の PATIENT レベルは受け付ける");
        assertEquals(Set.of("PERFA", "PERFB"), p.matches().stream().map(a -> a.getString(Tag.PatientID))
                .collect(Collectors.toSet()));
        Found c = find(PATIENT_ROOT, keys("PATIENT", Tag.PatientID, "OTHERC", Tag.NumberOfPatientRelatedStudies, ""));
        assertEquals(1, c.matches().size());
        assertEquals(2, c.matches().get(0).getInt(Tag.NumberOfPatientRelatedStudies, -1), "OTHERC は 2 スタディ");

        Found s = find(PATIENT_ROOT, keys("STUDY", Tag.PatientID, "OTHERC", Tag.StudyInstanceUID, ""));
        assertEquals(Set.of("1.9.3", "1.9.4"), uids(s, Tag.StudyInstanceUID));
    }

    @Test
    void keyForAnAttributeTheIndexLacks_isIgnored_andReturnedEmpty() throws Exception {
        Found r = find(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "", Tag.StudyID, "NOPE", Tag.StudyTime, ""));
        assertEquals(4, r.matches().size(), "索引に無い StudyID のキーは無視する");
        assertTrue(r.matches().get(0).contains(Tag.StudyID) && r.matches().get(0).getString(Tag.StudyID, "").isEmpty(),
                "要求された属性は空で返す（欠かさない）");
        assertTrue(r.matches().get(0).contains(Tag.StudyTime));
    }

    @Test
    void uniqueKeyIsReturnedEvenWhenNotRequested() throws Exception {
        Found r = find(STUDY_ROOT, keys("STUDY", Tag.PatientID, "PERFB"));
        assertEquals(1, r.matches().size());
        assertEquals("1.9.2", r.matches().get(0).getString(Tag.StudyInstanceUID), "StudyInstanceUID は必ず返す");
        assertFalse(r.matches().get(0).contains(Tag.StudyDescription), "要求していない属性は返さない");
    }

    // ---------------------------------------------------------------- 負例

    @Test
    void noMatch_returnsZeroRows_withSuccess() throws Exception {
        Found r = find(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "", Tag.PatientID, "NOSUCH*"));
        assertEquals(Status.Success, r.status());
        assertEquals(0, r.matches().size());
        assertEquals(0, find(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "", Tag.StudyDate, "20300101-")).matches().size());
    }

    @Test
    void studyRoot_patientLevel_isRejected() throws Exception {
        Found r = find(STUDY_ROOT, keys("PATIENT", Tag.PatientID, ""));
        assertEquals(Status.IdentifierDoesNotMatchSOPClass, r.status());
        assertEquals(0, r.matches().size());
    }

    @Test
    void unlistedCaller_isRefused_withNoRows() throws Exception {
        Found r = find(STUDY_ROOT, "STRANGER", keys("STUDY", Tag.StudyInstanceUID, ""));
        assertEquals(Status.UnableToProcess, r.status());
        assertEquals(0, r.matches().size(), "許可されていない相手には 1 件も返さない");
    }

    @Test
    void removingTheCallerFromTheList_takesEffectOnTheNextRequest_withoutRestart() throws Exception {
        assertEquals(4, find(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "")).matches().size());
        settings.putAll(Map.of(DicomController.REMOTE_AES_KEY, "[]"));
        Found r = find(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, ""));
        assertEquals(Status.UnableToProcess, r.status());
        assertEquals(0, r.matches().size());
        allowCaller(CALLER);
        assertEquals(4, find(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "")).matches().size(), "戻せば応える");
    }

    @Test
    void allowAll_letsAnUnlistedCallerIn() throws Exception {
        settings.putAll(Map.of(DicomQrAccess.ALLOW_ALL_KEY, "true"));
        assertEquals(4, find(STUDY_ROOT, "STRANGER", keys("STUDY", Tag.StudyInstanceUID, "")).matches().size());
        settings.putAll(Map.of(DicomQrAccess.ALLOW_ALL_KEY, "false"));
        assertEquals(Status.UnableToProcess, find(STUDY_ROOT, "STRANGER", keys("STUDY", Tag.StudyInstanceUID, "")).status());
    }

    @Test
    void whenNotRegistered_theFindContextIsNotAccepted() throws Exception {
        // OFF（既定）の状態: リスナーに FIND を登録しない。外部の C-FIND はコンテキストが受理されず使えない。
        int p = freePort();
        DicomScpServer off = new DicomScpServer("GRAPHYNEXT", "127.0.0.1", p);
        off.start();
        try {
            Found r = find(p, STUDY_ROOT, CALLER, keys("STUDY", Tag.StudyInstanceUID, ""));
            assertFalse(r.accepted(), "OFF のときは FIND の Presentation Context が受理されない");
            assertEquals(0, r.matches().size());
        } finally {
            off.stop();
        }
    }

    @Test
    void cStoreStillWorks_onAServerThatAlsoAnswersFind() throws Exception {
        int p = freePort();
        DicomScpServer both = new DicomScpServer("GRAPHYNEXT", "127.0.0.1", p);
        both.addService(new DicomStoreScp(storage, tmp.resolve("incoming")),
                new TransferCapability(null, "*", TransferCapability.Role.SCP, "*"));
        both.addService(new DicomFindScp(access, findQuery), DicomFindScp.capabilities());
        both.start();
        try {
            // 許可リストに無い AE でも、C-STORE は従来どおり受け付ける（許可は検索だけにかかる）。
            Attributes ds = DicomPhantomFactory.scImage("STOREPID", "1.9.77", "1.9.77.1", "1.9.77.1.1");
            Path f = DicomPhantomFactory.writeFile(Files.createTempFile("fs", ".dcm"), ds, UID.ExplicitVRLittleEndian);
            DicomStoreScu.StoreResult sr = new DicomStoreScu().store("127.0.0.1", p, "GRAPHYNEXT", "NOTLISTED", f);
            assertTrue(sr.success(), () -> "C-STORE は通るはず: " + sr.message());
            Found r = find(p, STUDY_ROOT, CALLER, keys("STUDY", Tag.StudyInstanceUID, "1.9.77"));
            assertEquals(Set.of("1.9.77"), uids(r, Tag.StudyInstanceUID), "受信したスタディが検索で見える");
        } finally {
            both.stop();
            // 他のテスト（件数を数える）へ持ち越さない。
            repo.deleteAll(repo.findMatches(null, "1.9.77", null, null));
        }
    }

    // ---------------------------------------------------------------- 補助

    private Set<String> studyUids(int tag, String value) throws Exception {
        return uids(find(STUDY_ROOT, keys("STUDY", Tag.StudyInstanceUID, "", tag, value)), Tag.StudyInstanceUID);
    }

    private static Set<String> uids(Found r, int tag) {
        return r.matches().stream().map(a -> a.getString(tag)).collect(Collectors.toSet());
    }

    private static Attributes one(Found r, int tag, String value) {
        List<Attributes> hit = r.matches().stream().filter(a -> value.equals(a.getString(tag))).toList();
        assertEquals(1, hit.size(), "ちょうど 1 件のはず: " + value);
        return hit.get(0);
    }

    private void allowCaller(String aet) {
        settings.putAll(Map.of(DicomController.REMOTE_AES_KEY,
                "[{\"aeTitle\":\"" + aet + "\",\"host\":\"127.0.0.1\",\"port\":104,\"tls\":false}]"));
    }

    /** 他のテストへ設定を持ち越さない（削除 API は無いので空文字で上書き）。 */
    private void reset() {
        settings.putAll(Map.of(DicomController.REMOTE_AES_KEY, "", DicomQrAccess.ALLOW_ALL_KEY, "",
                DicomQrAccess.ENABLED_KEY, ""));
    }

    private void put(String pid, String name, String study, String date, String acc, String modality,
                     String series, int seriesNo, String sop, int instNo) throws Exception {
        Attributes a = DicomPhantomFactory.scImage(pid, study, series, sop);
        a.setString(Tag.SpecificCharacterSet, VR.CS, "ISO_IR 192"); // 日本語の氏名を化けさせずに書く
        a.setString(Tag.PatientName, VR.PN, name);
        a.setString(Tag.PatientBirthDate, VR.DA, "19700101");
        a.setString(Tag.PatientSex, VR.CS, "M");
        a.setString(Tag.StudyDate, VR.DA, date);
        a.setString(Tag.AccessionNumber, VR.SH, acc);
        a.setString(Tag.Modality, VR.CS, modality);
        a.setString(Tag.SeriesNumber, VR.IS, String.valueOf(seriesNo));
        a.setString(Tag.InstanceNumber, VR.IS, String.valueOf(instNo));
        Path f = Files.createTempFile("find", ".dcm");
        storage.ingest(DicomPhantomFactory.writeFile(f, a, UID.ExplicitVRLittleEndian));
    }

    /** 要求の Identifier。{@code tv} はタグ・値の並び（値が空文字なら「戻してほしい属性」の指定）。 */
    private static Attributes keys(String level, Object... tv) {
        Attributes k = new Attributes();
        k.setString(Tag.QueryRetrieveLevel, VR.CS, level);
        k.setString(Tag.SpecificCharacterSet, VR.CS, "ISO_IR 192"); // 日本語のキーを欠かさず送るのはクライアントの役目
        for (int i = 0; i < tv.length; i += 2) {
            int tag = (Integer) tv[i];
            String v = (String) tv[i + 1];
            VR vr = ElementDictionary.getStandardElementDictionary().vrOf(tag);
            if (v.isEmpty()) {
                k.setNull(tag, vr);
            } else {
                k.setString(tag, vr, v.split("\\\\"));
            }
        }
        return k;
    }

    private Found find(String cuid, Attributes keys) throws Exception {
        return find(port, cuid, CALLER, keys);
    }

    private Found find(String cuid, String callingAet, Attributes keys) throws Exception {
        return find(port, cuid, callingAet, keys);
    }

    private static Found find(int port, String cuid, String callingAet, Attributes keys) throws Exception {
        return FindScpClient.find(port, cuid, callingAet, keys);
    }

    private static int freePort() {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        } catch (Exception e) {
            throw new IllegalStateException("free port を確保できませんでした", e);
        }
    }
}

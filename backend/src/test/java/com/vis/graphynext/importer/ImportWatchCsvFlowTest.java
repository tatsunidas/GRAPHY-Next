/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import com.vis.graphynext.dbadmin.DbAdminService;
import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.UID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 納品フォルダ（1 患者ぶん）の被験者 CSV（段 4）。画像と CSV をペアで置く。 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:importwatchcsv;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false",
                "graphy.import-watch.auto-run=false"
        })
@ActiveProfiles("standalone")
class ImportWatchCsvFlowTest {

    @TempDir
    static Path db;
    @TempDir
    static Path outside;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> db.resolve("dicom").toString());
    }

    @Autowired
    ImportWatchService watch;
    @Autowired
    ImportWatchRepository ledger;
    @Autowired
    SettingsService settings;
    @Autowired
    DicomInstanceRepository instances;
    @SpyBean
    DbAdminService dbAdmin;

    Path src;
    static int seq;

    @BeforeEach
    void setUp() throws IOException {
        ledger.deleteAll();
        Mockito.clearInvocations(dbAdmin);
        src = Files.createDirectories(outside.resolve("src" + (seq++)));
        configure(false);
    }

    void configure(boolean overwrite) {
        settings.putAll(Map.of(ImportWatchService.KEY_ENABLED, "true", ImportWatchService.KEY_FOLDER, src.toString(),
                ImportWatchService.KEY_INTERVAL, "5", ImportWatchService.KEY_CSV_OVERWRITE_DICOM, Boolean.toString(overwrite)));
    }

    private void scans(int n) {
        for (int i = 0; i < n; i++) {
            watch.scanOnce();
        }
    }

    private List<DicomInstance> patient(String id) {
        return instances.findByPatientId(id);
    }

    private void dicoms(Path unit, String patientId, String study, int n) throws Exception {
        Files.createDirectories(unit);
        for (int i = 1; i <= n; i++) {
            Attributes ds = DicomPhantomFactory.scImage(patientId, study, study + ".s", study + "." + i);
            DicomPhantomFactory.writeFile(unit.resolve("i" + i + ".dcm"), ds, UID.ExplicitVRLittleEndian);
        }
    }

    @Test
    void NIfTIの患者情報はCSVの値になり_サイドカーより優先される() throws Exception {
        Path unit = src.resolve("subj");
        WatchNiftiFixture.write(unit.resolve("t1.nii.gz"), 1);
        Files.writeString(unit.resolve("t1.json"), "{\"PatientID\":\"SIDECAR-ID\",\"PatientName\":\"Side^Car\"}");
        Files.writeString(unit.resolve("subject.csv"),
                "PatientID,PatientName,PatientBirthDate,PatientSex,StudyDescription\nCSV-1,Csv^Person,19900203,F,Brain\n");
        scans(3);

        assertEquals(0, patient("SIDECAR-ID").size(), "サイドカーの値は使われない");
        List<DicomInstance> got = patient("CSV-1");
        assertEquals(WatchNiftiFixture.NZ, got.size());
        assertEquals("Csv^Person", got.get(0).getPatientName());
        assertEquals("19900203", got.get(0).getPatientBirthDate());
        assertEquals("F", got.get(0).getPatientSex());
        assertEquals("Brain", got.get(0).getStudyDescription());
        ImportWatchService.Status s = watch.status();
        assertEquals(0, s.skipped(), "ペアの json と被験者 CSV は数えない");
        assertEquals(1, s.imported());
    }

    @Test
    void CSVがサイドカーの無い_NIfTI_に患者情報を与える() throws Exception {
        Path unit = src.resolve("nosidecar");
        WatchNiftiFixture.write(unit.resolve("t2.nii"), 2);
        Files.writeString(unit.resolve("p.csv"), "PatientID\nCSV-ONLY\n");
        scans(3);
        assertEquals(WatchNiftiFixture.NZ, patient("CSV-ONLY").size());
        assertEquals(0, watch.status().held());
    }

    @Test
    void CSVが無効なユニットのNIfTIは取り込まれず_直すと取り込まれる_他のユニットは止まらない() throws Exception {
        Path bad = src.resolve("badcsv");
        WatchNiftiFixture.write(bad.resolve("a.nii.gz"), 3);
        Files.writeString(bad.resolve("a.json"), "{\"PatientID\":\"BADCSV-1\"}"); // サイドカーが有効でも CSV が無効なら保留
        Files.writeString(bad.resolve("p.csv"), "PatientID,PatientSex\nBADCSV-1,Z\n");
        Path good = src.resolve("goodunit");
        WatchNiftiFixture.write(good.resolve("b.nii.gz"), 4);
        Files.writeString(good.resolve("b.json"), "{\"PatientID\":\"GOODUNIT-1\"}");

        scans(3);
        ImportWatchService.Status s = watch.status();
        assertEquals(0, patient("BADCSV-1").size(), "無効な CSV のユニットは取り込まない");
        assertEquals(WatchNiftiFixture.NZ, patient("GOODUNIT-1").size(), "他のユニットは止まらない");
        assertEquals(1, s.held());
        assertEquals("csv-invalid:csv-bad-value:PatientSex", s.heldItems().get(0).error());
        assertNull(s.error());

        Files.writeString(bad.resolve("p.csv"), "PatientID,PatientSex\nBADCSV-1,M\n");
        scans(3);
        assertEquals(WatchNiftiFixture.NZ, patient("BADCSV-1").size(), "直すと取り込まれる");
        assertEquals(0, watch.status().held());
    }

    @Test
    void CSVが2つあるユニットは保留() throws Exception {
        Path unit = src.resolve("two");
        WatchNiftiFixture.write(unit.resolve("c.nii.gz"), 5);
        Files.writeString(unit.resolve("one.csv"), "PatientID\nTWO-1\n");
        Files.writeString(unit.resolve("two.csv"), "PatientID\nTWO-2\n");
        scans(3);
        assertEquals(0, patient("TWO-1").size() + patient("TWO-2").size());
        assertEquals("csv-invalid:csv-multiple", watch.status().heldItems().get(0).error());
    }

    @Test
    void 上書き設定がOFFなら_CSVがあってもDICOMの患者属性は元のまま() throws Exception {
        Path unit = src.resolve("dcmoff");
        dicoms(unit, "OFF-ORIG", "1.2.csv.off", 3);
        Files.writeString(unit.resolve("p.csv"), "PatientID,PatientName\nOFF-NEW,New^Name\n");
        scans(3);
        assertEquals(3, patient("OFF-ORIG").size(), "元の患者のまま");
        assertEquals(0, patient("OFF-NEW").size());
        assertEquals("PHANTOM^TEST", patient("OFF-ORIG").get(0).getPatientName());
        Mockito.verify(dbAdmin, Mockito.never()).updateStudyPatient(Mockito.any(), Mockito.any(), Mockito.any(),
                Mockito.any(), Mockito.any());
    }

    @Test
    void 上書き設定がONなら_CSVの値になり_スタディごとに1回だけ書き換える() throws Exception {
        configure(true);
        Path unit = src.resolve("dcmon");
        dicoms(unit, "ON-ORIG", "1.2.csv.on", 3);
        Files.writeString(unit.resolve("p.csv"), "PatientID,PatientName,PatientSex\nON-NEW,New^Person,F\n");
        scans(3);
        List<DicomInstance> got = patient("ON-NEW");
        assertEquals(3, got.size(), "3 枚とも CSV の患者 ID になる");
        assertEquals(0, patient("ON-ORIG").size());
        assertEquals("New^Person", got.get(0).getPatientName());
        assertEquals("F", got.get(0).getPatientSex());
        Mockito.verify(dbAdmin, Mockito.times(1)).updateStudyPatient(Mockito.eq("1.2.csv.on"), Mockito.eq("New^Person"),
                Mockito.isNull(), Mockito.eq("F"), Mockito.eq("ON-NEW"));
    }

    @Test
    void 上書きがONでもCSVが無ければそのまま取り込む_CSVが無効なら保留() throws Exception {
        configure(true);
        Path none = src.resolve("nocsv");
        dicoms(none, "ON-NOCSV", "1.2.csv.nocsv", 2);
        Path bad = src.resolve("badon");
        dicoms(bad, "ON-BAD", "1.2.csv.badon", 2);
        Files.writeString(bad.resolve("p.csv"), "PatientID,Foo\nX,Y\n");
        scans(3);
        assertEquals(2, patient("ON-NOCSV").size(), "CSV が無ければ DICOM はそのまま");
        assertEquals(0, patient("ON-BAD").size(), "CSV が無効なら取り込まず保留");
        assertEquals(2, watch.status().held());
        Files.writeString(bad.resolve("p.csv"), "PatientID\nON-FIXED\n");
        scans(3);
        assertEquals(2, patient("ON-FIXED").size(), "直すと取り込まれ、CSV の値になる");
        assertEquals(0, watch.status().held());
    }

    @Test
    void 上書きがONなら_納品が揃うのを待つ_CSVが後から来ても値が付く() throws Exception {
        configure(true);
        Path unit = src.resolve("late");
        dicoms(unit, "LATE-ORIG", "1.2.csv.late", 2);
        watch.scanOnce();
        Files.writeString(unit.resolve("p.csv"), "PatientID\nLATE-NEW\n"); // 納品が変わった
        watch.scanOnce();
        assertEquals(0, patient("LATE-ORIG").size() + patient("LATE-NEW").size(), "納品が変わった走査では取り込まない");
        scans(2);
        assertEquals(2, patient("LATE-NEW").size());
        assertTrue(patient("LATE-ORIG").isEmpty());
    }
}

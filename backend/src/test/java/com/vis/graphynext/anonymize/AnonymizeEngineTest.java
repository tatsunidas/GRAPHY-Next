/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.anonymize.AnonymizeConfig.Option;
import com.vis.graphynext.anonymize.DicomTagRule.Action;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.HashMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** PS3.15 辞書（CSV）と匿名化エンジンの単体テスト（Spring 不要）。 */
class AnonymizeEngineTest {

    private static Action action(int tag, Option... opts) {
        AnonymizeConfig cfg = new AnonymizeConfig();
        for (Option o : opts) {
            cfg.addOption(o);
        }
        return cfg.determineFinalAction(AnonymizeTagDictionary.RULE_MAP.get(tag));
    }

    @Test
    void dictionary_loaded_and_optionActions() {
        assertTrue(AnonymizeTagDictionary.RULE_MAP.size() > 300, "E.1-1 が多数ロードされる");
        assertFalse(AnonymizeTagDictionary.SAFE_PRIVATE_ATTRIBUTES.isEmpty(), "Safe Private がロードされる");

        assertEquals(Action.D, action(Tag.PatientID), "PatientID は常に D");
        assertEquals(Action.U, action(Tag.StudyInstanceUID), "StudyInstanceUID 既定 U");
        assertEquals(Action.K, action(Tag.StudyInstanceUID, Option.RetainUIDs), "RetainUIDs で K");
        assertEquals(Action.K, action(Tag.InstitutionName, Option.RetainInstitutionIdentity), "施設保持で K");
        assertEquals(Action.K, action(Tag.DeviceSerialNumber, Option.RetainDeviceIdentity), "装置保持で K");
        assertEquals(Action.K, action(Tag.PatientAge, Option.RetainPatientCharacteristics), "患者特性保持で K");
        assertEquals(Action.K, action(Tag.StudyDate, Option.RetainLongitudinalTemporalInformationFullDates), "Full Dates で K");
        assertEquals(Action.C, action(Tag.StudyDate, Option.RetainLongitudinalTemporalInformationModifiedDates), "Modified Dates で C");
        assertEquals(Action.C, action(Tag.StudyDescription, Option.CleanDescriptors), "CleanDescriptors で C");
    }

    @Test
    void deidentify_basicProfile_removesIdentifiers_remapsUids() {
        Attributes ds = sample();
        new DicomAnonymizerEngine().deidentify(
                ds, new AnonymizeConfig(), new DicomAnonymizerEngine.PatientMapping("ANON001", "ANON^001"),
                new HashMap<>());

        assertEquals("ANON^001", ds.getString(Tag.PatientName));
        assertEquals("ANON001", ds.getString(Tag.PatientID));
        assertEquals("YES", ds.getString(Tag.PatientIdentityRemoved));
        assertNotEquals("1.2.3.4", ds.getString(Tag.StudyInstanceUID), "UID は U で置換");
        // InstitutionName は CSV 既定 "X/Z/D" → D（ダミー置換）。元の値ではない。
        assertNotEquals("Hospital X", ds.getString(Tag.InstitutionName), "施設名は D で置換");
        assertNull(ds.getString(Tag.PatientAge), "PatientAge は既定 X で除去");
        assertNull(ds.getString("ACME", 0x00090001), "private データは除去");
        assertNull(ds.getString(0x00090010), "private creator も除去");
        // method code seq に基本プロファイルコード
        assertTrue(ds.getSequence(Tag.DeidentificationMethodCodeSequence) != null
                && !ds.getSequence(Tag.DeidentificationMethodCodeSequence).isEmpty());
    }

    @Test
    void deidentify_retainUids_keepsStudyUid() {
        Attributes ds = sample();
        AnonymizeConfig cfg = new AnonymizeConfig();
        cfg.addOption(Option.RetainUIDs);
        new DicomAnonymizerEngine().deidentify(
                ds, cfg, new DicomAnonymizerEngine.PatientMapping("ANON", "ANON"), new HashMap<>());
        assertEquals("1.2.3.4", ds.getString(Tag.StudyInstanceUID), "RetainUIDs で UID 不変");
    }

    @Test
    void deidentify_consistentUidRemap_acrossDatasets() {
        var map = new HashMap<String, String>();
        Attributes a = sample();
        Attributes b = sample();
        var eng = new DicomAnonymizerEngine();
        eng.deidentify(a, new AnonymizeConfig(), new DicomAnonymizerEngine.PatientMapping("X", "X"), map);
        eng.deidentify(b, new AnonymizeConfig(), new DicomAnonymizerEngine.PatientMapping("X", "X"), map);
        assertEquals(a.getString(Tag.StudyInstanceUID), b.getString(Tag.StudyInstanceUID),
                "同一元 UID は同一新 UID（全ファイル一貫）");
    }

    private static Attributes sample() {
        Attributes ds = new Attributes();
        ds.setString(Tag.PatientName, VR.PN, "DOE^JOHN");
        ds.setString(Tag.PatientID, VR.LO, "PID123");
        ds.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3.4");
        ds.setString(Tag.SeriesInstanceUID, VR.UI, "1.2.3.4.5");
        ds.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.4.5.6");
        ds.setString(Tag.SOPClassUID, VR.UI, org.dcm4che3.data.UID.MRImageStorage);
        ds.setString(Tag.InstitutionName, VR.LO, "Hospital X");
        ds.setString(Tag.PatientAge, VR.AS, "045Y");
        ds.setString(Tag.StudyDate, VR.DA, "20240101");
        // private creator(0009,0010)=ACME ＋ private data(0009,1001)
        ds.setString(0x00090010, VR.LO, "ACME");
        ds.setString("ACME", 0x00090001, VR.LO, "secret");
        return ds;
    }
}

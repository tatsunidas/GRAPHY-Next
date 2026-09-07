/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.anonymize.AnonymizeConfig.Option;
import com.vis.graphynext.anonymize.DicomTagRule.Action;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Set;

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
        // method code seq に基本プロファイルコードだけが入る。
        // 🔴 かつては「null でなく空でもない」としか見ておらず、113100 さえ入れば通ったので
        // 113101 の誤混入（＝偽の匿名化申告）を検出できなかった。集合として突き合わせる。
        assertEquals(Set.of("113100"), methodCodes(ds), "基本プロファイルのみを申告する");
    }

    /** {@code DeidentificationMethodCodeSequence} に入っている CodeValue の集合。 */
    private static Set<String> methodCodes(Attributes ds) {
        Sequence seq = ds.getSequence(Tag.DeidentificationMethodCodeSequence);
        if (seq == null) {
            return Set.of();
        }
        Set<String> codes = new HashSet<>();
        for (Attributes item : seq) {
            codes.add(item.getString(Tag.CodeValue));
        }
        return codes;
    }

    private static void deidentify(Attributes ds, AnonymizeConfig cfg, boolean pixelCleaned) {
        new DicomAnonymizerEngine().deidentify(ds, cfg, new DicomAnonymizerEngine.PatientMapping("ANON", "ANON"),
                new HashMap<>(), new DicomAnonymizerEngine.InstanceDeidFacts(pixelCleaned));
    }

    private static AnonymizeConfig cleanPixelConfig() {
        AnonymizeConfig cfg = new AnonymizeConfig();
        cfg.addOption(Option.CleanPixelData);
        return cfg;
    }

    // ------------------------------------------------------------------------
    // 焼き込みの申告（2026-08-20 実測・fw/mainscreen-tools.md L135-143 の回帰）
    //
    // 症状: registerAnonMask() の呼び出し元が frontend に 0 件なのに、CleanPixelData を
    // ON にするだけで出力の BurnedInAnnotation が YES→NO に書き換わり、113101 が入った。
    // 画素は元と完全一致（np.array_equal で確認）。受け取った側はタグを信用して検証しないため、
    // 匿名化していないことより危険＝「何もしないより悪い」。
    // ------------------------------------------------------------------------

    @Test
    void deidentify_cleanPixelData_withoutActualBurn_doesNotDeclare113101() {
        Attributes ds = sample();
        deidentify(ds, cleanPixelConfig(), false);
        assertEquals(Set.of("113100"), methodCodes(ds),
                "1 画素も塗っていないなら Clean Pixel Data Option を申告しない");
    }

    @Test
    void deidentify_cleanPixelData_withoutActualBurn_keepsOriginalBurnedInAnnotation() {
        Attributes ds = sample();
        ds.setString(Tag.BurnedInAnnotation, VR.CS, "YES");
        deidentify(ds, cleanPixelConfig(), false);
        assertEquals("YES", ds.getString(Tag.BurnedInAnnotation),
                "塗っていないなら、真の YES を偽の NO に書き換えない");
    }

    @Test
    void deidentify_cleanPixelData_withActualBurn_declares113101_andSetsNo() {
        Attributes ds = sample();
        ds.setString(Tag.BurnedInAnnotation, VR.CS, "YES");
        deidentify(ds, cleanPixelConfig(), true);
        assertEquals(Set.of("113100", "113101"), methodCodes(ds), "実際に塗ったときだけ申告する");
        assertEquals("NO", ds.getString(Tag.BurnedInAnnotation));
    }

    @Test
    void deidentify_withoutCleanPixelDataOption_neverTouchesBurnedInAnnotation() {
        Attributes ds = sample();
        ds.setString(Tag.BurnedInAnnotation, VR.CS, "YES");
        // オプション自体が無いので、塗った事実があっても申告経路に入らない。
        deidentify(ds, new AnonymizeConfig(), true);
        assertEquals(Set.of("113100"), methodCodes(ds));
        assertEquals("YES", ds.getString(Tag.BurnedInAnnotation));
    }

    // ------------------------------------------------------------------------
    // 日付シフト（fw/mainscreen-tools.md L144-149 の回帰）
    //
    // 症状: ModifiedDates を選ぶと全検査日が 20000101 に潰れた。アクション C が VR 別の
    // 固定ダミーを返すだけで元の値を読んでいなかったため。オプションの目的は
    // 「時間的前後関係の保持」なので名前の逆を行っており、しかも 113107 を宣言していた。
    // ------------------------------------------------------------------------

    private static AnonymizeConfig modifiedDatesConfig() {
        AnonymizeConfig cfg = new AnonymizeConfig();
        cfg.addOption(Option.RetainLongitudinalTemporalInformationModifiedDates);
        return cfg;
    }

    /** 同一患者の 2 スタディを同じオフセットで匿名化する（＝実運用と同じ条件）。 */
    private static String[] shiftTwoStudies(String da1, String da2) {
        int shift = DateShifter.shiftDaysFor("PID123", 20260907L);
        var pm = new DicomAnonymizerEngine.PatientMapping("ANON", "ANON", shift);
        var eng = new DicomAnonymizerEngine();

        Attributes a = sample();
        a.setString(Tag.StudyDate, VR.DA, da1);
        Attributes b = sample();
        b.setString(Tag.StudyDate, VR.DA, da2);
        eng.deidentify(a, modifiedDatesConfig(), pm, new HashMap<>(),
                DicomAnonymizerEngine.InstanceDeidFacts.none());
        eng.deidentify(b, modifiedDatesConfig(), pm, new HashMap<>(),
                DicomAnonymizerEngine.InstanceDeidFacts.none());
        return new String[] { a.getString(Tag.StudyDate), b.getString(Tag.StudyDate) };
    }

    @Test
    void deidentify_modifiedDates_preservesIntervalBetweenStudies() {
        String[] out = shiftTwoStudies("20260101", "20260730");

        assertNotEquals("20000101", out[0], "固定ダミーに潰れない（2026-08-20 の実測ケース）");
        assertNotEquals("20000101", out[1], "固定ダミーに潰れない（2026-08-20 の実測ケース）");
        assertNotEquals(out[0], out[1], "7 か月差の 2 スタディが同じ日にならない");

        DateTimeFormatter f = DateTimeFormatter.ofPattern("uuuuMMdd");
        long days = LocalDate.parse(out[1], f).toEpochDay() - LocalDate.parse(out[0], f).toEpochDay();
        assertEquals(210, days, "元の 210 日差が保たれる（＝113107 の申告が事実になる）");
    }

    @Test
    void deidentify_modifiedDates_keepsStudyTimeUnchanged() {
        // 投与後 1h / 4h のように同じ日に複数時点を撮る検査で、時点の間隔を壊さない。
        int shift = DateShifter.shiftDaysFor("PID123", 20260907L);
        Attributes ds = sample();
        ds.setString(Tag.StudyTime, VR.TM, "101530");
        new DicomAnonymizerEngine().deidentify(ds, modifiedDatesConfig(),
                new DicomAnonymizerEngine.PatientMapping("ANON", "ANON", shift), new HashMap<>(),
                DicomAnonymizerEngine.InstanceDeidFacts.none());
        assertEquals("101530", ds.getString(Tag.StudyTime), "日単位シフトなので時刻は変わらない");
    }

    @Test
    void deidentify_modifiedDates_differentPatients_getDifferentOffsets() {
        assertNotEquals(DateShifter.shiftDaysFor("PID123", 1L), DateShifter.shiftDaysFor("PID999", 1L),
                "患者間の相対関係は保たない（集団の受診日の相関から実日付が復元されるのを防ぐ）");
    }

    @Test
    void deidentify_fullDates_keepsStudyDateExactly() {
        // 排他のもう一方。ModifiedDates を入れたことで Full Dates が壊れていないこと。
        Attributes ds = sample();
        AnonymizeConfig cfg = new AnonymizeConfig();
        cfg.addOption(Option.RetainLongitudinalTemporalInformationFullDates);
        new DicomAnonymizerEngine().deidentify(ds, cfg,
                new DicomAnonymizerEngine.PatientMapping("ANON", "ANON"), new HashMap<>(),
                DicomAnonymizerEngine.InstanceDeidFacts.none());
        assertEquals("20240101", ds.getString(Tag.StudyDate), "Full Dates は原本のまま");
    }

    @Test
    void deidentify_withoutDateOption_stillRemovesStudyDate() {
        // 日付オプション無し＝Basic Profile の Z。既存の挙動を固定する。
        Attributes ds = sample();
        new DicomAnonymizerEngine().deidentify(ds, new AnonymizeConfig(),
                new DicomAnonymizerEngine.PatientMapping("ANON", "ANON"), new HashMap<>(),
                DicomAnonymizerEngine.InstanceDeidFacts.none());
        assertNull(ds.getString(Tag.StudyDate), "StudyDate は既定 Z で空");
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

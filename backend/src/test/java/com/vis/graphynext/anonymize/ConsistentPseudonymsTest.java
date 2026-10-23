/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 受信時の匿名化の部品（鍵・一貫した仮名）の単体テスト（Spring 不要）。 */
class ConsistentPseudonymsTest {

    @TempDir
    Path tmp;

    private static final String STUDY = "1.2.840.99.1";
    private static final String SERIES = "1.2.840.99.1.1";

    private PseudonymKey newKey(String name) throws IOException {
        return PseudonymKey.loadOrCreate(tmp.resolve(name));
    }

    private static Attributes image(String sop) {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        ds.setString(Tag.SOPInstanceUID, VR.UI, sop);
        ds.setString(Tag.StudyInstanceUID, VR.UI, STUDY);
        ds.setString(Tag.SeriesInstanceUID, VR.UI, SERIES);
        ds.setString(Tag.PatientID, VR.LO, "P-0001");
        ds.setString(Tag.PatientName, VR.PN, "YAMADA^TARO");
        return ds;
    }

    /** 画像を参照する SR 風のデータセット（ReferencedSOPInstanceUID を持つ）。 */
    private static Attributes referrer(String refSop) {
        Attributes ds = image("1.2.840.99.1.9.1");
        Sequence seq = ds.newSequence(Tag.ReferencedImageSequence, 1);
        Attributes item = new Attributes();
        item.setString(Tag.ReferencedSOPClassUID, VR.UI, UID.CTImageStorage);
        item.setString(Tag.ReferencedSOPInstanceUID, VR.UI, refSop);
        seq.add(item);
        return ds;
    }

    private static void run(Attributes ds, ConsistentPseudonyms p) {
        String newId = p.patientId(ds.getString(Tag.PatientID), "ANON-");
        new DicomAnonymizerEngine().deidentify(
                ds, new AnonymizeConfig(),
                new DicomAnonymizerEngine.PatientMapping(newId, newId), p.uidMap());
    }

    @Test
    void sameKey_sameUid_acrossInstancesAndRestarts() throws IOException {
        // 別々の関連付け・再起動を模す: 鍵ファイルを読み直した別インスタンスでも同じ新 UID。
        PseudonymKey k1 = newKey("a.key");
        Attributes first = image("1.2.840.99.1.1.1");
        run(first, new ConsistentPseudonyms(k1));

        PseudonymKey k2 = PseudonymKey.loadOrCreate(tmp.resolve("a.key"));
        assertFalse(k2.wasCreated(), "2 回目は読むだけ");
        Attributes second = image("1.2.840.99.1.1.2");
        run(second, new ConsistentPseudonyms(k2));

        assertEquals(first.getString(Tag.StudyInstanceUID), second.getString(Tag.StudyInstanceUID));
        assertEquals(first.getString(Tag.SeriesInstanceUID), second.getString(Tag.SeriesInstanceUID));
        assertNotEquals(first.getString(Tag.SOPInstanceUID), second.getString(Tag.SOPInstanceUID), "別の画像は別の UID");
        assertNotEquals(STUDY, first.getString(Tag.StudyInstanceUID), "元の UID は残らない");
        assertTrue(first.getString(Tag.StudyInstanceUID).startsWith("2.25."));
        assertTrue(first.getString(Tag.StudyInstanceUID).length() <= 64);
        assertEquals(first.getString(Tag.PatientID), second.getString(Tag.PatientID), "同じ患者は同じ仮名 ID");
    }

    @Test
    void randomHashMap_splitsTheStudy_negativeControl() {
        // 検出器が効いていること: 既定の乱数 HashMap では同じ検査が 2 つに分かれる。
        Attributes a = image("1.2.840.99.1.1.1");
        Attributes b = image("1.2.840.99.1.1.2");
        DicomAnonymizerEngine eng = new DicomAnonymizerEngine();
        eng.deidentify(a, new AnonymizeConfig(), new DicomAnonymizerEngine.PatientMapping("X", "X"), new HashMap<>());
        eng.deidentify(b, new AnonymizeConfig(), new DicomAnonymizerEngine.PatientMapping("X", "X"), new HashMap<>());
        assertNotEquals(a.getString(Tag.StudyInstanceUID), b.getString(Tag.StudyInstanceUID));
    }

    @Test
    void differentKey_differentPseudonyms() throws IOException {
        ConsistentPseudonyms p1 = new ConsistentPseudonyms(newKey("k1.key"));
        ConsistentPseudonyms p2 = new ConsistentPseudonyms(newKey("k2.key"));
        assertNotEquals(p1.uid(STUDY), p2.uid(STUDY));
        assertNotEquals(p1.patientId("P-0001", "ANON-"), p2.patientId("P-0001", "ANON-"));
        assertNotEquals(p1.dateSeed(), p2.dateSeed());
    }

    @Test
    void patientIds_differByPatient_andKeepPrefix() throws IOException {
        ConsistentPseudonyms p = new ConsistentPseudonyms(newKey("k.key"));
        String a = p.patientId("P-0001", "ANON-");
        String b = p.patientId("P-0002", "ANON-");
        assertNotEquals(a, b);
        assertTrue(a.startsWith("ANON-") && a.length() == "ANON-".length() + 10);
        assertThrows(IllegalArgumentException.class, () -> p.patientId("x", "x".repeat(60)));
    }

    @Test
    void references_followTheImage() throws IOException {
        // 参照 UID が、参照先の画像の新しい SOP UID と一致する（参照が切れない）。
        ConsistentPseudonyms p = new ConsistentPseudonyms(newKey("k.key"));
        Attributes img = image("1.2.840.99.1.1.1");
        Attributes ref = referrer("1.2.840.99.1.1.1");
        run(img, p);
        run(ref, p);
        String referenced = ref.getSequence(Tag.ReferencedImageSequence).get(0).getString(Tag.ReferencedSOPInstanceUID);
        assertEquals(img.getString(Tag.SOPInstanceUID), referenced);
    }

    @Test
    void dateSeed_isStable_andFeedsDateShifter() throws IOException {
        PseudonymKey k = newKey("k.key");
        long s1 = new ConsistentPseudonyms(k).dateSeed();
        long s2 = new ConsistentPseudonyms(PseudonymKey.loadOrCreate(tmp.resolve("k.key"))).dateSeed();
        assertEquals(s1, s2);
        assertEquals(DateShifter.shiftDaysFor("P-0001", s1), DateShifter.shiftDaysFor("P-0001", s2));
    }

    @Test
    void keyFile_createdOnce_ownerOnly_andCorruptIsRefused() throws IOException {
        Path f = tmp.resolve("sub/dir/k.key");
        PseudonymKey k = PseudonymKey.loadOrCreate(f);
        assertTrue(k.wasCreated());
        assertEquals(PseudonymKey.KEY_BYTES, Files.size(f));
        if (Files.getFileStore(f).supportsFileAttributeView("posix")) {
            assertTrue(Files.getPosixFilePermissions(f).stream().noneMatch(
                    p -> p.name().startsWith("GROUP") || p.name().startsWith("OTHERS")),
                    "持ち主以外に権限を付けない");
        }
        Files.write(f, new byte[5]);
        assertThrows(IllegalStateException.class, () -> PseudonymKey.loadOrCreate(f), "壊れた鍵は作り直さず止める");
        assertEquals(5, Files.size(f), "壊れたファイルを上書きしていない");
    }

    @Test
    void domainsAreSeparated() throws IOException {
        // 同じ元の値でも用途が違えば無関係（UID から患者 ID を逆算できない）。
        ConsistentPseudonyms p = new ConsistentPseudonyms(newKey("k.key"));
        Map<String, String> m = p.uidMap();
        String uid = m.computeIfAbsent("P-0001", k -> "ignored");
        assertNotEquals(uid, p.patientId("P-0001", ""));
        assertEquals(p.uid("P-0001"), uid, "生成関数は使わず、元の値だけで決まる");
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** C-FIND の照合規則（PS3.4 C.2.2.2）の境界値。正例と負例を両方置く。 */
class DicomMatcherTest {

    private static Attributes cand(String id, String name, String date, String... modalities) {
        Attributes a = new Attributes();
        a.setString(Tag.PatientID, VR.LO, id);
        a.setString(Tag.PatientName, VR.PN, name);
        a.setString(Tag.StudyDate, VR.DA, date);
        a.setString(Tag.ModalitiesInStudy, VR.CS, modalities);
        return a;
    }

    private static Attributes key(int tag, VR vr, String... v) {
        Attributes k = new Attributes();
        if (v.length == 1 && v[0].isEmpty()) {
            k.setNull(tag, vr);
        } else {
            k.setString(tag, vr, v);
        }
        return k;
    }

    private static boolean m(Attributes k, Attributes c) {
        return DicomMatcher.matches(k, c);
    }

    @Test
    void emptyKey_matchesEverything_butOnlyAsAReturnKey() {
        Attributes c = cand("P1", "A^B", "20260101", "CT");
        assertTrue(m(key(Tag.PatientID, VR.LO, ""), c));
        assertTrue(m(new Attributes(), c), "キーなしは全一致");
    }

    @Test
    void wildcard_star_and_question() {
        Attributes c = cand("PERF12", "A^B", "20260101", "CT");
        assertTrue(m(key(Tag.PatientID, VR.LO, "PERF*"), c));
        assertTrue(m(key(Tag.PatientID, VR.LO, "*12"), c));
        assertTrue(m(key(Tag.PatientID, VR.LO, "P*F1?"), c));
        assertTrue(m(key(Tag.PatientID, VR.LO, "PERF1?"), c));
        // 負例: ? は 1 文字ちょうど。* を部分一致に変えても通ってしまわないこと
        assertFalse(m(key(Tag.PatientID, VR.LO, "PERF?"), c), "? は 1 文字（PERF12 は 2 文字余る）");
        assertFalse(m(key(Tag.PatientID, VR.LO, "ERF*"), c), "先頭は固定（部分一致ではない）");
        assertFalse(m(key(Tag.PatientID, VR.LO, "PERF"), c), "ワイルドカードなしは完全一致");
        assertFalse(m(key(Tag.PatientID, VR.LO, "PERF1"), c));
    }

    @Test
    void regexMetacharacters_inKey_areLiteral() {
        Attributes c = cand("A.B", "N^M", "20260101", "CT");
        assertTrue(m(key(Tag.PatientID, VR.LO, "A.B"), c));
        assertFalse(m(key(Tag.PatientID, VR.LO, "A.*B+"), c), ". や + は正規表現として働かない");
        assertFalse(m(key(Tag.PatientID, VR.LO, "A?B"), cand("AxxB", "N^M", "20260101", "CT")));
        assertTrue(m(key(Tag.PatientID, VR.LO, "A?B"), cand("AxB", "N^M", "20260101", "CT")));
    }

    @Test
    void patientName_isCaseInsensitive_butIdIsNot() {
        Attributes c = cand("Abc", "YAMADA^TARO", "20260101", "CT");
        assertTrue(m(key(Tag.PatientName, VR.PN, "yamada*"), c));
        assertTrue(m(key(Tag.PatientName, VR.PN, "yamada^taro"), c));
        assertFalse(m(key(Tag.PatientID, VR.LO, "abc"), c), "PatientID は区別する");
        assertTrue(m(key(Tag.PatientID, VR.LO, "Abc"), c));
    }

    @Test
    void referringPhysicianName_isCaseInsensitive_likeAnyPersonName() {
        Attributes c = new Attributes();
        c.setString(Tag.ReferringPhysicianName, VR.PN, "Smith^John");
        c.setString(Tag.StudyID, VR.SH, "AbC");
        assertTrue(m(key(Tag.ReferringPhysicianName, VR.PN, "smith*"), c));
        assertFalse(m(key(Tag.ReferringPhysicianName, VR.PN, "jones*"), c));
        assertTrue(m(key(Tag.StudyID, VR.SH, "AbC"), c));
        assertFalse(m(key(Tag.StudyID, VR.SH, "abc"), c), "人名以外は大文字小文字を区別する");
    }

    @Test
    void timeRange_inclusiveBothEnds_truncatingToTheKeyPrecision() {
        Attributes c = new Attributes();
        c.setString(Tag.StudyTime, VR.TM, "093015.250000");
        assertTrue(m(key(Tag.StudyTime, VR.TM, "0930-0930"), c), "桁数の少ない端は、値をその桁数に切って比べる");
        assertTrue(m(key(Tag.StudyTime, VR.TM, "093015-093015"), c));
        assertTrue(m(key(Tag.StudyTime, VR.TM, "0900-1000"), c));
        assertTrue(m(key(Tag.StudyTime, VR.TM, "0930-"), c));
        assertTrue(m(key(Tag.StudyTime, VR.TM, "-0930"), c));
        assertFalse(m(key(Tag.StudyTime, VR.TM, "0931-1000"), c), "下端より前");
        assertFalse(m(key(Tag.StudyTime, VR.TM, "0800-0929"), c), "上端より後");
        assertFalse(m(key(Tag.StudyTime, VR.TM, "093016-"), c), "秒まで指定した下端より前");
        Attributes empty = new Attributes();
        empty.setNull(Tag.StudyTime, VR.TM);
        assertFalse(m(key(Tag.StudyTime, VR.TM, "0000-2359"), empty), "時刻の無い候補は範囲に入らない");
    }

    @Test
    void japaneseName_matchesByWildcard() {
        Attributes c = cand("P", "山田^太郎", "20260101", "CT");
        assertTrue(m(key(Tag.PatientName, VR.PN, "山田*"), c));
        assertFalse(m(key(Tag.PatientName, VR.PN, "佐藤*"), c));
    }

    @Test
    void dateRange_inclusiveBothEnds_andOpenEnded() {
        Attributes c = cand("P", "A^B", "20260105", "CT");
        assertTrue(m(key(Tag.StudyDate, VR.DA, "20260105"), c));
        assertTrue(m(key(Tag.StudyDate, VR.DA, "20260105-20260105"), c), "両端を含む");
        assertTrue(m(key(Tag.StudyDate, VR.DA, "20260101-20260105"), c));
        assertTrue(m(key(Tag.StudyDate, VR.DA, "20260105-20260131"), c));
        assertTrue(m(key(Tag.StudyDate, VR.DA, "20260105-"), c));
        assertTrue(m(key(Tag.StudyDate, VR.DA, "-20260105"), c));
        assertFalse(m(key(Tag.StudyDate, VR.DA, "20260106-"), c));
        assertFalse(m(key(Tag.StudyDate, VR.DA, "-20260104"), c));
        assertFalse(m(key(Tag.StudyDate, VR.DA, "20260106-20260131"), c));
        assertFalse(m(key(Tag.StudyDate, VR.DA, "20260104"), c));
    }

    @Test
    void dateKey_againstMissingDate_neverMatches() {
        Attributes c = new Attributes();
        c.setString(Tag.PatientID, VR.LO, "P");
        c.setNull(Tag.StudyDate, VR.DA);
        assertFalse(m(key(Tag.StudyDate, VR.DA, "20260101-"), c));
        assertFalse(m(key(Tag.StudyDate, VR.DA, "20260101"), c));
        assertTrue(m(key(Tag.StudyDate, VR.DA, ""), c), "空のキーは全一致");
    }

    @Test
    void multiValuedKey_uidListAndModalities() {
        Attributes c = new Attributes();
        c.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        c.setString(Tag.ModalitiesInStudy, VR.CS, "CT", "MR");
        assertTrue(m(key(Tag.StudyInstanceUID, VR.UI, "9.9", "1.2.3"), c), "UID リスト: どれかに一致");
        assertFalse(m(key(Tag.StudyInstanceUID, VR.UI, "9.9", "8.8"), c));
        assertTrue(m(key(Tag.ModalitiesInStudy, VR.CS, "MR"), c), "候補の複数値のどれかに一致");
        assertTrue(m(key(Tag.ModalitiesInStudy, VR.CS, "PT", "CT"), c));
        assertFalse(m(key(Tag.ModalitiesInStudy, VR.CS, "PT"), c));
    }

    @Test
    void keyForAttributeNotInIndex_isIgnored_andReported() {
        Attributes c = cand("P", "A^B", "20260101", "CT"); // StudyID を持たない（索引に無い）
        Attributes k = key(Tag.StudyID, VR.SH, "X1");
        assertTrue(m(k, c), "索引に無い属性のキーは無視する");
        assertEquals("(0020,0010)", DicomMatcher.ignoredKeys(k, c));
        // 空のキーは「戻す属性」の指定で、無視には数えない
        assertEquals("", DicomMatcher.ignoredKeys(key(Tag.StudyID, VR.SH, ""), c));
    }

    @Test
    void attributePresentButEmpty_matchesOnlyStarOrEmptyKey() {
        Attributes c = new Attributes();
        c.setNull(Tag.AccessionNumber, VR.SH);
        assertTrue(m(key(Tag.AccessionNumber, VR.SH, "*"), c));
        assertTrue(m(key(Tag.AccessionNumber, VR.SH, ""), c));
        assertFalse(m(key(Tag.AccessionNumber, VR.SH, "A*"), c));
        assertFalse(m(key(Tag.AccessionNumber, VR.SH, "A1"), c));
    }

    @Test
    void trailingPadding_isNotPartOfValue() {
        Attributes c = cand("P1 ", "A^B", "20260101", "CT");
        assertTrue(m(key(Tag.PatientID, VR.LO, "P1"), c));
    }
}

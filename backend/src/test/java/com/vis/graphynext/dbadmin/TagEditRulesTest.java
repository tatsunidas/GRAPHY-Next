/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/** タグの編集の決まり（編集できないタグ・VR ごとの値の形）。 */
class TagEditRulesTest {

    @Test
    void 編集できないタグには理由がある() {
        assertEquals("uid", TagEditRules.lockReason(Tag.SeriesInstanceUID, VR.UI));
        assertEquals("uid", TagEditRules.lockReason(Tag.FrameOfReferenceUID, VR.UI));
        assertEquals("meta", TagEditRules.lockReason(Tag.TransferSyntaxUID, VR.UI));
        assertEquals("pixel", TagEditRules.lockReason(Tag.Rows, VR.US));
        assertEquals("pixel", TagEditRules.lockReason(Tag.PixelData, VR.OW));
        assertEquals("pixel", TagEditRules.lockReason(Tag.PhotometricInterpretation, VR.CS));
        assertEquals("geometry", TagEditRules.lockReason(Tag.ImagePositionPatient, VR.DS));
        assertEquals("geometry", TagEditRules.lockReason(Tag.PixelSpacing, VR.DS));
        assertEquals("patient", TagEditRules.lockReason(Tag.PatientName, VR.PN));
        assertEquals("patient", TagEditRules.lockReason(Tag.PatientID, VR.LO));
        assertEquals("sequence", TagEditRules.lockReason(Tag.ReferencedImageSequence, VR.SQ));
        assertEquals("audit", TagEditRules.lockReason(Tag.OriginalAttributesSequence, VR.SQ));
        assertEquals("binary", TagEditRules.lockReason(0x00091001, VR.OB));
        assertEquals("binary", TagEditRules.lockReason(0x00091001, null));
        assertEquals("privateCreator", TagEditRules.lockReason(0x00090010, VR.LO));
        assertEquals("structure", TagEditRules.lockReason(0x00080000, VR.UL));
    }

    @Test
    void 編集できるタグ() {
        assertNull(TagEditRules.lockReason(Tag.SeriesDescription, VR.LO));
        assertNull(TagEditRules.lockReason(Tag.StudyDate, VR.DA));
        assertNull(TagEditRules.lockReason(Tag.Modality, VR.CS));
        assertNull(TagEditRules.lockReason(Tag.WindowCenter, VR.DS));
        assertNull(TagEditRules.lockReason(0x00091001, VR.LO));
    }

    @Test
    void タグはキーワードと番号の両方で読める() {
        assertEquals(Tag.SeriesDescription, TagEditRules.parseTag("SeriesDescription"));
        assertEquals(Tag.SeriesDescription, TagEditRules.parseTag("(0008,103E)"));
        assertEquals(Tag.SeriesDescription, TagEditRules.parseTag("0008103e"));
        assertEquals(-1, TagEditRules.parseTag("NoSuchKeyword"));
        assertEquals("(0008,103E)", TagEditRules.format(Tag.SeriesDescription));
        assertEquals(VR.LO, TagEditRules.dictionaryVr(Tag.SeriesDescription));
        assertNull(TagEditRules.dictionaryVr(0x00091001));
    }

    @Test
    void 値の形_正例() {
        assertNull(TagEditRules.valueError(VR.DA, "20260229".replace("2026", "2024")));
        assertNull(TagEditRules.valueError(VR.TM, "235959.123456"));
        assertNull(TagEditRules.valueError(VR.TM, "07"));
        assertNull(TagEditRules.valueError(VR.DT, "20260101120000.5+0900"));
        assertNull(TagEditRules.valueError(VR.DS, "-1.5e3\\2"));
        assertNull(TagEditRules.valueError(VR.IS, "+12"));
        assertNull(TagEditRules.valueError(VR.CS, "ORIGINAL\\PRIMARY"));
        assertNull(TagEditRules.valueError(VR.LO, "Chest 1.0 mm"));
        assertNull(TagEditRules.valueError(VR.PN, "Yamada^Taro=山田^太郎"));
        assertNull(TagEditRules.valueError(VR.LT, "a\\b\nc"));
        assertNull(TagEditRules.valueError(VR.US, "65535"));
        assertNull(TagEditRules.valueError(VR.FD, "0.25"));
        assertNull(TagEditRules.valueError(VR.AS, "045Y"));
        assertNull(TagEditRules.valueError(VR.LO, ""));
    }

    @Test
    void 値の形_負例() {
        assertEquals("format", TagEditRules.valueError(VR.DA, "20261345"));
        assertEquals("format", TagEditRules.valueError(VR.DA, "20250229"));
        assertEquals("format", TagEditRules.valueError(VR.DA, "2026-01-01"));
        assertEquals("format", TagEditRules.valueError(VR.TM, "245959"));
        assertEquals("format", TagEditRules.valueError(VR.DT, "20261301"));
        assertEquals("format", TagEditRules.valueError(VR.DS, "abc"));
        assertEquals("tooLong", TagEditRules.valueError(VR.DS, "1.00000000000000001"));
        assertEquals("outOfRange", TagEditRules.valueError(VR.IS, "2147483648"));
        assertEquals("badChars", TagEditRules.valueError(VR.CS, "original"));
        assertEquals("tooLong", TagEditRules.valueError(VR.CS, "ABCDEFGHIJKLMNOPQ"));
        assertEquals("tooLong", TagEditRules.valueError(VR.SH, "12345678901234567"));
        assertEquals("tooLong", TagEditRules.valueError(VR.LO, "x".repeat(65)));
        assertEquals("badChars", TagEditRules.valueError(VR.LO, "a\nb"));
        assertEquals("format", TagEditRules.valueError(VR.PN, "a=b=c=d"));
        assertEquals("outOfRange", TagEditRules.valueError(VR.US, "65536"));
        assertEquals("format", TagEditRules.valueError(VR.FD, "NaN"));
        assertEquals("format", TagEditRules.valueError(VR.FL, "1f"));
        assertEquals("format", TagEditRules.valueError(VR.AS, "45Y"));
    }
}

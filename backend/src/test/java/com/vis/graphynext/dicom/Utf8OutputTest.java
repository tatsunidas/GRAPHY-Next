package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.CharsetFixtures.Source;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;

class Utf8OutputTest {

    static List<Source> sources() {
        return CharsetFixtures.sources();
    }

    /** 生の値のまま写す書き出し（PET の属性・位置合わせ）と同じ形で、入れ子を 2 段にする。 */
    @ParameterizedTest
    @MethodSource("sources")
    void 生の値で写した入れ子のシーケンスも復号してから差し替える(Source s) {
        String text = s.patientName().replace('^', ' ');
        Attributes t = new Attributes();
        Attributes inner = new Attributes();
        inner.setString(Tag.CodeMeaning, VR.LO, text);
        Attributes outer = new Attributes();
        outer.setString(Tag.Radiopharmaceutical, VR.LO, text);
        outer.newSequence(Tag.RadionuclideCodeSequence, 1).add(inner);
        t.newSequence(Tag.RadiopharmaceuticalInformationSequence, 1).add(outer);
        Attributes src = CharsetFixtures.asSource(t, s);

        Attributes out = new Attributes();
        for (int tag : new int[] {Tag.SpecificCharacterSet, Tag.PatientName}) {
            out.setValue(tag, src.getVR(tag), src.getValue(tag));
        }
        Attributes copy = new Attributes(src.getNestedDataset(Tag.RadiopharmaceuticalInformationSequence));
        out.newSequence(Tag.RadiopharmaceuticalInformationSequence, 1).add(copy);
        Utf8Output.apply(out);
        out.setString(Tag.SeriesDescription, VR.LO, CharsetFixtures.NEW_TEXT);

        Attributes read = CharsetFixtures.roundTrip(out);
        assertEquals("ISO_IR 192", read.getString(Tag.SpecificCharacterSet));
        assertEquals(s.patientName(), read.getString(Tag.PatientName));
        assertEquals(CharsetFixtures.NEW_TEXT, read.getString(Tag.SeriesDescription));
        Attributes item = read.getNestedDataset(Tag.RadiopharmaceuticalInformationSequence);
        assertEquals(text, item.getString(Tag.Radiopharmaceutical));
        assertEquals(text, item.getNestedDataset(Tag.RadionuclideCodeSequence).getString(Tag.CodeMeaning));
    }

    /** 宣言の無い規格外のデータ（Shift_JIS のバイトなど）は、復号せずにバイトのまま残す。 */
    @Test
    void 宣言の無い元の値はバイトを変えない() throws IOException {
        byte[] sjis = "山田^太郎".getBytes("Shift_JIS");
        Attributes t = new Attributes();
        t.setBytes(Tag.PatientName, VR.PN, sjis);
        Attributes src = CharsetFixtures.roundTrip(t);
        byte[] before = src.getBytes(Tag.PatientName);

        Utf8Output.apply(src);

        Attributes read = CharsetFixtures.roundTrip(src);
        assertEquals("ISO_IR 192", read.getString(Tag.SpecificCharacterSet));
        assertArrayEquals(before, read.getBytes(Tag.PatientName));
    }

    @Test
    void 宣言の無い元でも新しい日本語は_UTF8_で書く() throws IOException {
        Attributes a = new Attributes();
        Utf8Output.apply(a);
        a.setString(Tag.SeriesDescription, VR.LO, CharsetFixtures.NEW_TEXT);
        Attributes read = CharsetFixtures.roundTrip(a);
        assertEquals(CharsetFixtures.NEW_TEXT, new String(read.getBytes(Tag.SeriesDescription), StandardCharsets.UTF_8).trim());
    }
}

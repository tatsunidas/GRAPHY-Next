package com.vis.graphynext.plugin.video;

import com.vis.graphynext.dicom.CharsetFixtures;
import com.vis.graphynext.dicom.CharsetFixtures.Source;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import java.time.LocalDateTime;
import java.util.List;

import static com.vis.graphynext.dicom.CharsetFixtures.NEW_TEXT;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class FrameValuesSrCharsetTest {

    static java.util.List<Source> sources() {
        return CharsetFixtures.sources();
    }

    @ParameterizedTest
    @MethodSource("sources")
    void 書き出しても患者名と新しい日本語が残る(Source s) {
        Attributes t = new Attributes();
        t.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3.4");
        t.setString(Tag.StudyDescription, VR.LO, "study");
        FrameValuesSr.Content c = new FrameValuesSr.Content(
                List.of(new FrameValuesSr.Series("CPR", NEW_TEXT, "1", List.of(1.0, 2.0))), null);
        Attributes out = CharsetFixtures.roundTrip(FrameValuesSr.build(CharsetFixtures.asSource(t, s), c,
                new FrameValuesSr.Producer("uvs", "UVS", "0.3.0"), "9.9.1", "9.9.2", LocalDateTime.of(2026, 11, 27, 9, 0)));
        assertEquals(s.patientName(), out.getString(Tag.PatientName));
        assertTrue(allStrings(out).contains(NEW_TEXT), "系列の名前が残る");
    }

    private static String allStrings(Attributes a) {
        StringBuilder sb = new StringBuilder();
        for (int tag : a.tags()) {
            if (a.getVR(tag) == VR.SQ) {
                Sequence seq = a.getSequence(tag);
                for (Attributes item : seq) sb.append(allStrings(item));
            } else if (a.getVR(tag).isStringType()) {
                String[] v = a.getStrings(tag);
                if (v != null) sb.append(String.join("|", v)).append('|');
            }
        }
        return sb.toString();
    }
}

package com.vis.graphynext.registration;

import com.vis.graphynext.dicom.CharsetFixtures;
import com.vis.graphynext.dicom.CharsetFixtures.Source;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;


import static com.vis.graphynext.dicom.CharsetFixtures.NEW_TEXT;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SpatialRegistrationCharsetTest {

    static java.util.List<Source> sources() {
        return CharsetFixtures.sources();
    }

    @ParameterizedTest
    @MethodSource("sources")
    void 書き出しても患者名と新しい日本語が残る(Source s) {
        Attributes t = new Attributes();
        t.setString(Tag.PatientID, VR.LO, "P1");
        t.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3.study");
        double[] identity = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
        Attributes out = CharsetFixtures.roundTrip(SpatialRegistrationCodec.build(new SpatialRegistrationCodec.Input(
                CharsetFixtures.asSource(t, s), "1.2.3.fixed", "1.2.3.moving", identity, null, "REG", NEW_TEXT)));
        assertEquals(s.patientName(), out.getString(Tag.PatientName));
        assertEquals(NEW_TEXT, out.getString(Tag.ContentDescription));
    }
}

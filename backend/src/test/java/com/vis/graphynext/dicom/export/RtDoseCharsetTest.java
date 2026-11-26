package com.vis.graphynext.dicom.export;

import com.vis.graphynext.dicom.CharsetFixtures;
import com.vis.graphynext.dicom.CharsetFixtures.Source;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import static com.vis.graphynext.dicom.CharsetFixtures.NEW_TEXT;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RtDoseCharsetTest {

    static java.util.List<Source> sources() {
        return CharsetFixtures.sources();
    }

    @ParameterizedTest
    @MethodSource("sources")
    void 書き出しても患者名と新しい日本語が残る(Source s) {
        Attributes t = new Attributes();
        t.setString(Tag.PatientID, VR.LO, "PAT-D");
        t.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3.4");
        t.setString(Tag.FrameOfReferenceUID, VR.UI, "1.2.3.4.100");
        t.setString(Tag.SOPClassUID, VR.UI, org.dcm4che3.data.UID.PositronEmissionTomographyImageStorage);
        t.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.4.5");
        byte[] px = ByteBuffer.allocate(16).array();
        RtDoseExportRequest req = new RtDoseExportRequest("1.2.3.4", "1.2.3.4.9", NEW_TEXT, null, 2, 2,
                new double[] {1, 0, 0, 0, 1, 0}, new double[] {0, 0, 0}, new double[] {1, 1}, new double[] {0, 1},
                "GY", "PHYSICAL", "PLAN", "comment", 0.001, "IMAGE", Base64.getEncoder().encodeToString(px),
                List.of("1.2.3.4.5"), null, new RtDoseExportRequest.Producer("dosimetry", "Dosimetry", "0.2.0"));
        Attributes out = CharsetFixtures.roundTrip(new RtDoseExportService(null, null)
                .build(CharsetFixtures.asSource(t, s), req, px, new ArrayList<>()));
        assertEquals(s.patientName(), out.getString(Tag.PatientName));
        assertTrue(out.getString(Tag.SeriesDescription).contains(NEW_TEXT), out.getString(Tag.SeriesDescription));
    }
}

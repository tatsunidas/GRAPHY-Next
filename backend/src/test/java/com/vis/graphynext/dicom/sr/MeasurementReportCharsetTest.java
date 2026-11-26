package com.vis.graphynext.dicom.sr;

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

class MeasurementReportCharsetTest {

    static java.util.List<Source> sources() {
        return CharsetFixtures.sources();
    }

    @ParameterizedTest
    @MethodSource("sources")
    void 書き出しても患者名と新しい日本語が残る(Source s) {
        Attributes t = new Attributes();
        t.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3.4");
        MeasurementReportRequest req = new MeasurementReportRequest("1.2.3.4", NEW_TEXT, "title", null,
                List.of(new MeasurementReportRequest.MeasurementGroup("g1", null, NEW_TEXT, null, null,
                        List.of(new MeasurementReportRequest.Measurement("longAxis", 10.0, null)))), null, null);
        Attributes out = CharsetFixtures.roundTrip(new MeasurementReportService(null)
                .build(CharsetFixtures.asSource(t, s), req, LocalDateTime.of(2026, 11, 27, 9, 0)));
        assertEquals(s.patientName(), out.getString(Tag.PatientName));
        assertEquals(NEW_TEXT, out.getString(Tag.SeriesDescription));
    }
}

package com.vis.graphynext.dicom.derived;

import com.vis.graphynext.dicom.CharsetFixtures;
import com.vis.graphynext.dicom.CharsetFixtures.Source;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import java.util.List;

import static com.vis.graphynext.dicom.CharsetFixtures.NEW_TEXT;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DerivedSeriesCharsetTest {

    static java.util.List<Source> sources() {
        return CharsetFixtures.sources();
    }

    @ParameterizedTest
    @MethodSource("sources")
    void 書き出しても患者名と新しい日本語が残る(Source s) {
        Attributes t = new Attributes();
        t.setString(Tag.Modality, VR.CS, "PT");
        t.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        t.setString(Tag.Units, VR.CS, "BQML");
        // シーケンスの中の文字も、元の文字コードで書かれている（PET の放射性医薬品）。
        Attributes ph = new Attributes();
        ph.setString(Tag.Radiopharmaceutical, VR.LO, s.patientName().replace('^', ' '));
        ph.setString(Tag.RadionuclideTotalDose, VR.DS, "1000");
        t.newSequence(Tag.RadiopharmaceuticalInformationSequence, 1).add(ph);
        DerivedSeriesRequest r = new DerivedSeriesRequest("1.2.3", "1.2.4", NEW_TEXT, null, 2, 2,
                new double[] {1.0, 1.0}, 1.0, 1.0, null, null, null, null, null, null, null, null, null, null, null, null,
                List.of(new DerivedSeriesRequest.Frame(1, null, "")));
        Attributes out = CharsetFixtures.roundTrip(new DerivedSeriesService(null, null)
                .buildInstance(CharsetFixtures.asSource(t, s), r, "1.2.9", 1001, "PT", r.frames().get(0), new byte[8]));
        assertEquals(s.patientName(), out.getString(Tag.PatientName));
        assertTrue(out.getString(Tag.SeriesDescription).contains(NEW_TEXT), out.getString(Tag.SeriesDescription));
        assertEquals(s.patientName().replace('^', ' '),
                out.getNestedDataset(Tag.RadiopharmaceuticalInformationSequence).getString(Tag.Radiopharmaceutical));
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.sr;

import com.vis.graphynext.dicom.sr.MeasurementReportRequest.Measurement;
import com.vis.graphynext.dicom.sr.MeasurementReportRequest.MeasurementGroup;
import com.vis.graphynext.dicom.sr.MeasurementReportRequest.Producer;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.dcm4che3.util.TagUtils;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 既存の計測種別（12 種）の SR が、種別を足しても **1 文字も変わらない**ことを固定する。
 *
 * <p>基準（{@code sr/legacy-types.golden.txt}）は、種別を足す前のコードで生成した正規化ダンプ
 * （UID を値に持つ項目だけ値を伏せる。それ以外はタグ・VR・値をそのまま並べる）。
 * 作り直すときは {@code -Dgolden.write=true} を付けて実行する（**意図して SR の形を変えたときだけ**）。
 */
class MeasurementReportLegacyGoldenTest {

    private static final LocalDateTime NOW = LocalDateTime.of(2026, 8, 2, 10, 30, 0);
    private static final String GOLDEN = "/sr/legacy-types.golden.txt";

    private final MeasurementReportService service = new MeasurementReportService(null);

    private static Attributes template() {
        Attributes t = new Attributes();
        t.setSpecificCharacterSet("ISO_IR 192");
        t.setString(Tag.PatientID, VR.LO, "PAT-1");
        t.setString(Tag.PatientName, VR.PN, "Phantom^Golden");
        t.setString(Tag.PatientBirthDate, VR.DA, "19700101");
        t.setString(Tag.PatientSex, VR.CS, "O");
        t.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3.4");
        t.setString(Tag.StudyDate, VR.DA, "20260105");
        t.setString(Tag.AccessionNumber, VR.SH, "ACC-1");
        t.setString(Tag.StudyDescription, VR.LO, "golden");
        t.setString(Tag.Modality, VR.CS, "CT");
        t.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.4.5");
        return t;
    }

    /** 12 種別。単位を明示するものと、表の既定に任せるもの（null）を混ぜる。 */
    private static List<Measurement> legacyMeasurements() {
        return List.of(
                new Measurement("longAxis", 76.0, "mm"),
                new Measurement("shortAxis", 31.5, null),
                new Measurement("volume", 6.822, null),
                new Measurement("mass", 7.11, "g"),
                new Measurement("absorbedDose", 12.5, null),
                new Measurement("timeIntegratedActivity", 4.393e11, null),
                new Measurement("effectiveHalfLife", 60.0, null),
                new Measurement("bed", 30.2, null),
                new Measurement("eqd2", 28.1, null),
                new Measurement("area", 14.25, null),
                new Measurement("meanValue", -35.5, "[hnsf'U]"),
                new Measurement("stdDev", 6.1, "[hnsf'U]"));
    }

    private Attributes buildSr() {
        MeasurementGroup g = new MeasurementGroup("golden-1", "1.2.826.0.1.3680043.9.7133.1", "Target lesion",
                "1.2.3.4.9", "1.2.3.4.9.1", legacyMeasurements());
        MeasurementReportRequest req = new MeasurementReportRequest("1.2.3.4", "Golden", "Golden report",
                "Kobayashi^Tatsuaki", List.of(g), null, new Producer("golden", "Golden", "0.0.1"));
        return service.build(template(), req, NOW);
    }

    /** タグ・VR・値を深さ優先で並べる。VR が UI の値は採番で変わるので伏せる。 */
    static void dump(Attributes a, int depth, StringBuilder sb) {
        for (int tag : a.tags()) {
            VR vr = a.getVR(tag);
            String indent = "  ".repeat(depth);
            if (vr == VR.SQ) {
                Sequence seq = a.getSequence(tag);
                sb.append(indent).append(TagUtils.toString(tag)).append(" SQ[").append(seq.size()).append("]\n");
                for (int i = 0; i < seq.size(); i++) {
                    sb.append(indent).append("- item ").append(i).append('\n');
                    dump(seq.get(i), depth + 1, sb);
                }
            } else if (vr == VR.UI) {
                sb.append(indent).append(TagUtils.toString(tag)).append(" UI <uid>\n");
            } else {
                String[] v = a.getStrings(tag);
                sb.append(indent).append(TagUtils.toString(tag)).append(' ').append(vr).append(' ')
                        .append(v == null ? "" : String.join("\\", v)).append('\n');
            }
        }
    }

    @Test
    void 既存の12種別のSRは種別を足しても変わらない() throws IOException {
        StringBuilder sb = new StringBuilder();
        dump(buildSr(), 0, sb);
        String actual = sb.toString();
        if (Boolean.getBoolean("golden.write")) {
            Path out = Path.of("src/test/resources" + GOLDEN);
            Files.createDirectories(out.getParent());
            Files.writeString(out, actual, StandardCharsets.UTF_8);
            return;
        }
        try (InputStream in = getClass().getResourceAsStream(GOLDEN)) {
            // Windows の checkout は autocrlf で CRLF になりうる。改行の違いで落とさない。
            String expected = new String(in.readAllBytes(), StandardCharsets.UTF_8).replace("\r\n", "\n");
            assertEquals(expected, actual);
        }
    }
}

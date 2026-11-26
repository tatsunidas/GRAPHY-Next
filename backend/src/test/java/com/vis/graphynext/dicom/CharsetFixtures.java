package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.List;

/**
 * 文字コードの検査の共通部品。<b>メモリ上の文字列は、書き出すまで失われない</b>ので、
 * 元データも出力も一度ファイルの形に書き出して読み直してから比べる。
 */
public final class CharsetFixtures {

    private CharsetFixtures() {}

    /** 書き出すコードに渡す新しい文字（日本語）。 */
    public static final String NEW_TEXT = "線量マップ（肝）";

    /** 元画像の文字コードと、その文字コードで書ける患者名。 */
    public record Source(String label, String[] charset, String patientName) {
        @Override
        public String toString() {
            return label;
        }
    }

    public static List<Source> sources() {
        return List.of(
                new Source("ISO_IR 100", new String[] {"ISO_IR 100"}, "Müller^José"),
                new Source("ISO 2022 IR 87", new String[] {"", "ISO 2022 IR 87"}, "Yamada^Tarou=山田^太郎=やまだ^たろう"),
                new Source("ISO_IR 192", new String[] {"ISO_IR 192"}, "Müller^太郎"));
    }

    /** {@code template} に元の文字コードと患者名を入れ、ファイルから読んだ状態（生のバイト）にする。 */
    public static Attributes asSource(Attributes template, Source s) {
        template.setSpecificCharacterSet(s.charset());
        template.setString(Tag.PatientName, VR.PN, s.patientName());
        return roundTrip(template);
    }

    public static Attributes roundTrip(Attributes a) {
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (DicomOutputStream out = new DicomOutputStream(bytes, UID.ExplicitVRLittleEndian)) {
                out.writeDataset(null, a);
            }
            try (DicomInputStream in = new DicomInputStream(
                    new ByteArrayInputStream(bytes.toByteArray()), UID.ExplicitVRLittleEndian)) {
                return in.readDataset();
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}

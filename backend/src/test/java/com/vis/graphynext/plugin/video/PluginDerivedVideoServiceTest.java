/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.video;

import com.vis.graphynext.nondicom.VideoConverter;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** H54: 派生の動画シリーズの属性（本体が決める。単体アプリの SummaryDicomExporter と同じ規則）。 */
class PluginDerivedVideoServiceTest {

    private static Attributes source() {
        Attributes s = new Attributes();
        s.setString(Tag.SOPClassUID, VR.UI, UID.UltrasoundMultiFrameImageStorage);
        s.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.4");
        s.setString(Tag.SeriesInstanceUID, VR.UI, "1.2.3");
        s.setString(Tag.StudyInstanceUID, VR.UI, "1.2");
        s.setString(Tag.PatientID, VR.LO, "K12");
        s.setString(Tag.PatientName, VR.PN, "KOSEI^TWELVE");
        s.setString(Tag.Modality, VR.CS, "US");
        s.setString(Tag.SeriesDescription, VR.LO, "original");
        s.setInt(Tag.NumberOfFrames, VR.IS, 600);
        s.setString(Tag.ImageType, VR.CS, "ORIGINAL", "PRIMARY");
        s.newSequence(Tag.SourceImageSequence, 1).add(new Attributes());
        return s;
    }

    private static VideoConverter.Mp4Info mp4(int frames) {
        Attributes a = new Attributes();
        a.setInt(Tag.Rows, VR.US, 440);
        a.setInt(Tag.Columns, VR.US, 720);
        a.setInt(Tag.NumberOfFrames, VR.IS, frames);
        a.setString(Tag.PhotometricInterpretation, VR.CS, "YBR_PARTIAL_420");
        return new VideoConverter.Mp4Info(a, UID.MPEG4HP41);
    }

    @Test
    void 派生の印_参照_出所を本体が入れ_患者と検査は元を継ぐ() {
        Attributes a = PluginDerivedVideoService.build(source(), mp4(3),
                new PluginDerivedVideoService.DerivedRequest("job", "1.2.3.4", List.of(10, 20, 30),
                        "Summarized (composite, th=0.75)", "UVS summarization: 600→3 frames", "db"),
                new FrameValuesSr.Producer("uvs", "UVS", "0.3.8"), 7, LocalDateTime.of(2026, 9, 28, 12, 0));
        assertThat(a.getString(Tag.PatientID)).isEqualTo("K12");
        assertThat(a.getString(Tag.StudyInstanceUID)).isEqualTo("1.2");
        assertThat(a.getString(Tag.SeriesInstanceUID)).isNotEqualTo("1.2.3");
        assertThat(a.getString(Tag.SOPInstanceUID)).isNotEqualTo("1.2.3.4");
        assertThat(a.getString(Tag.SOPClassUID)).isEqualTo(UID.UltrasoundMultiFrameImageStorage);
        assertThat(a.getInt(Tag.SeriesNumber, 0)).isEqualTo(7);
        assertThat(a.getString(Tag.SeriesDescription)).isEqualTo("[Plugin] Summarized (composite, th=0.75)");
        assertThat(a.getStrings(Tag.ImageType)).containsExactly("DERIVED", "SECONDARY");
        assertThat(a.getString(Tag.DerivationDescription)).isEqualTo("UVS summarization: 600→3 frames");
        assertThat(a.getInt(Tag.NumberOfFrames, 0)).isEqualTo(3); // MP4 のもの（元の 600 は持ち越さない）
        assertThat(a.contains(Tag.SourceImageSequence)).isFalse();
        Attributes series = a.getNestedDataset(Tag.ReferencedSeriesSequence);
        assertThat(series.getString(Tag.SeriesInstanceUID)).isEqualTo("1.2.3");
        Attributes inst = series.getNestedDataset(Tag.ReferencedInstanceSequence);
        assertThat(inst.getString(Tag.ReferencedSOPInstanceUID)).isEqualTo("1.2.3.4");
        assertThat(inst.getInts(Tag.ReferencedFrameNumber)).containsExactly(10, 20, 30);
        assertThat(a.getNestedDataset(Tag.ContributingEquipmentSequence)).isNotNull();
        assertThat(a.getString(Tag.LossyImageCompression)).isEqualTo("01");
    }

    @Test
    void 動画でない元は_US_Multi_frame_にする() {
        Attributes src = source();
        src.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        Attributes a = PluginDerivedVideoService.build(src, mp4(2),
                new PluginDerivedVideoService.DerivedRequest("job", "1.2.3.4", List.of(), null, null, "file"),
                new FrameValuesSr.Producer("p", "P", "1"), 1, LocalDateTime.now());
        assertThat(a.getString(Tag.SOPClassUID)).isEqualTo(UID.UltrasoundMultiFrameImageStorage);
        assertThat(a.getString(Tag.SeriesDescription)).isEqualTo("[Plugin] Derived video");
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.microscopy;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.net.TransferCapability;
import org.junit.jupiter.api.Test;

import com.vis.graphynext.dicom.ConfocalGeometry;
import com.vis.graphynext.dicom.ParametricMapFrameExpander;
import com.vis.graphynext.dicom.SegFrameExpander;
import com.vis.graphynext.dicom.SeriesLayout;
import com.vis.graphynext.dicom.SeriesLayoutAssembler;
import com.vis.graphynext.dicom.StorageSopClasses;

/** CFM（32 ビット・規格外）の書き出しと、表示用の展開（fw/microscopy-cfm.md）。 */
class ConfocalMicroscopyTest {

    private static final int W = 8;
    private static final int H = 6;
    private static final int NZ = 5;
    private static final double[] SPACING = { 0.000332, 0.000332, 0.002 }; // mm（0.332 µm・2 µm）

    private static float valueAt(int ch, int z, int i) {
        return ch * 1000 + z * 10 + i * 0.25f;
    }

    private static Attributes channel(int ch, Double wavelength) {
        List<float[]> frames = new ArrayList<>();
        for (int z = 0; z < NZ; z++) {
            float[] f = new float[W * H];
            for (int i = 0; i < f.length; i++) {
                f[i] = valueAt(ch, z, i);
            }
            frames.add(f);
        }
        return ConfocalMicroscopyWriter.write(new ConfocalMicroscopyWriter.Request(W, H, NZ, 1, frames, SPACING,
                "Ch" + ch, wavelength, null, "Zeiss LSM", "sample.lsm", null,
                new ConfocalMicroscopyWriter.Equipment("Visionary Imaging Services, Inc.", "GRAPHY-Next", "uuid-1", "test"),
                "P", "P^Q", null, null, "1.2.3", null, null, null, ch + 1, "1.2.3.4", "1.2.3.5"));
    }

    private static Attributes header(Attributes full) {
        Attributes h = new Attributes(full);
        h.remove(Tag.FloatPixelData);
        return h;
    }

    private static Attributes parse(byte[] part10) throws IOException {
        try (DicomInputStream in = new DicomInputStream(new ByteArrayInputStream(part10))) {
            in.readFileMetaInformation();
            return in.readDataset();
        }
    }

    @Test
    void CFM_の必須の骨組みと規格外の注記() {
        Attributes ds = channel(0, 633.0);
        assertThat(ds.getString(Tag.SOPClassUID)).isEqualTo(UID.ConfocalMicroscopyImageStorage);
        assertThat(ds.getString(Tag.Modality)).isEqualTo("CFM");
        assertThat(ds.getInt(Tag.NumberOfFrames, 0)).isEqualTo(NZ);
        assertThat(ds.getInt(Tag.BitsAllocated, 0)).isEqualTo(32);
        assertThat(ds.contains(Tag.FloatPixelData)).isTrue();
        assertThat(ds.getStrings(Tag.ImageType)).containsExactly("ORIGINAL", "PRIMARY", "VOLUME", "NONE");
        assertThat(ds.getString(Tag.ConfocalMode)).isEqualTo("FLUORESCENCE");
        assertThat(ds.getString(Tag.TissueLocation)).isEqualTo("EXVIVO");
        assertThat(ds.getString(Tag.DeviceSerialNumber)).isEqualTo("uuid-1");
        assertThat(ds.getString(Tag.ImageComments)).contains("Non-standard").doesNotContain("Illumination wavelength/color unknown");
        Attributes op = ds.getNestedDataset(Tag.OpticalPathSequence);
        assertThat(op.getFloat(Tag.IlluminationWaveLength, 0f)).isEqualTo(633f);
        assertThat(op.getNestedDataset(Tag.IlluminationTypeCodeSequence).getString(Tag.CodeValue)).isEqualTo("111743");
        Attributes shared = ds.getNestedDataset(Tag.SharedFunctionalGroupsSequence);
        assertThat(shared.getNestedDataset(Tag.FrameAnatomySequence).getNestedDataset(Tag.AnatomicRegionSequence)
                .getString(Tag.CodeValue)).isEqualTo("91723000");
        assertThat(shared.getNestedDataset(Tag.PixelMeasuresSequence).getDoubles(Tag.PixelSpacing)).containsExactly(0.000332, 0.000332);
        assertThat(ds.getNestedDataset(Tag.SpecimenDescriptionSequence).getString(Tag.SpecimenUID)).isEqualTo("1.2.3.5");
        // スライド座標の Z は µm（PS3.3 C.8.12.2）: 2 µm 間隔
        Attributes f3 = ds.getSequence(Tag.PerFrameFunctionalGroupsSequence).get(3).getNestedDataset(Tag.PlanePositionSlideSequence);
        assertThat(f3.getDouble(Tag.ZOffsetInSlideCoordinateSystem, -1)).isEqualTo(6.0);
    }

    @Test
    void 波長が分からなければ波長も色も入れず不明と記録する() {
        Attributes ds = channel(0, null);
        Attributes op = ds.getNestedDataset(Tag.OpticalPathSequence);
        assertThat(op.contains(Tag.IlluminationWaveLength)).isFalse();
        assertThat(op.contains(Tag.IlluminationColorCodeSequence)).isFalse();
        assertThat(ds.getString(Tag.ImageComments)).contains("Illumination wavelength/color unknown");
    }

    @Test
    void 表示用の展開で_Z_は_mm_の仮の患者座標になり値は差0() throws IOException {
        List<Attributes> headers = List.of(header(channel(0, 633.0)));
        SeriesLayout lay = ParametricMapFrameExpander.layout(headers);
        assertThat(lay).isNotNull();
        assertThat(lay.nZ()).isEqualTo(NZ);
        assertThat(lay.imageOrientationPatient()).containsExactly(1, 0, 0, 0, 1, 0);
        assertThat(lay.zSpatial().get(4).imagePositionPatient()[2]).isCloseTo(0.008, org.assertj.core.data.Offset.offset(1e-12));
        // web の経路（SeriesLayoutAssembler）でも同じ
        SeriesLayout web = SeriesLayoutAssembler.fromAttributes(headers);
        assertThat(web.nZ()).isEqualTo(NZ);

        Attributes full = channel(1, 633.0);
        Attributes f2 = parse(ParametricMapFrameExpander.extractFrame(full, 2));
        assertThat(f2.getDoubles(Tag.ImagePositionPatient)[2]).isCloseTo(0.004, org.assertj.core.data.Offset.offset(1e-12));
        assertThat(f2.getDoubles(Tag.ImageOrientationPatient)).containsExactly(1.0, 0.0, 0.0, 0.0, 1.0, 0.0);
        assertThat(f2.getDoubles(Tag.PixelSpacing)).containsExactly(0.000332, 0.000332);
        assertThat(f2.getString(Tag.ImageComments)).contains(ConfocalGeometry.DISPLAY_NOTE).contains("Non-standard");
        float[] v = new float[W * H];
        ByteBuffer.wrap(f2.getBytes(Tag.FloatPixelData)).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(v);
        for (int i = 0; i < v.length; i++) {
            assertThat(v[i]).isEqualTo(valueAt(1, 2, i));
        }
    }

    @Test
    void 負例_患者座標の読み方では位置が取れず_Z_を_µm_のまま使うと間隔が1000倍() {
        Attributes ds = channel(0, null);
        assertThat(SegFrameExpander.perFrameIpp(ds, 1)).isNull(); // 今までの読み方では 1 枚しか並ばなかった
        double zUm = ds.getSequence(Tag.PerFrameFunctionalGroupsSequence).get(1)
                .getNestedDataset(Tag.PlanePositionSlideSequence).getDouble(Tag.ZOffsetInSlideCoordinateSystem, 0);
        double zMm = ConfocalGeometry.framePosition(ds, 1)[2];
        assertThat(zUm / zMm).isEqualTo(1000.0);
        assertThat(zMm).isCloseTo(SPACING[2], org.assertj.core.data.Offset.offset(1e-12));
    }

    @Test
    void 整数の_CFM_も読める() throws IOException {
        Attributes ds = channel(0, 633.0);
        ds.remove(Tag.FloatPixelData);
        ds.setInt(Tag.BitsAllocated, org.dcm4che3.data.VR.US, 8);
        ds.setInt(Tag.BitsStored, org.dcm4che3.data.VR.US, 8);
        ds.setInt(Tag.PixelRepresentation, org.dcm4che3.data.VR.US, 0);
        byte[] px = new byte[W * H * NZ];
        for (int i = 0; i < px.length; i++) {
            px[i] = (byte) (i % 251);
        }
        ds.setBytes(Tag.PixelData, org.dcm4che3.data.VR.OB, px);
        float[] f = ParametricMapFrameExpander.frameValues(ds, 1);
        assertThat(f[0]).isEqualTo((W * H) % 251);
    }

    @Test
    void フレーム数が合わなければ断る() {
        assertThatThrownBy(() -> ConfocalMicroscopyWriter.write(new ConfocalMicroscopyWriter.Request(W, H, NZ, 1,
                List.of(new float[W * H]), SPACING, null, null, null, null, null, null,
                new ConfocalMicroscopyWriter.Equipment("m", "n", "s", "v"), null, null, null, null, null, null, null,
                null, 1, null, null))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void SCP_の受信一覧に顕微鏡の_SOP_クラスがある() {
        List<String> uids = StorageSopClasses.scpCapabilities("/dicom/storage-sop-classes.properties").stream()
                .map(TransferCapability::getSopClass).toList();
        assertThat(uids).contains(UID.ConfocalMicroscopyImageStorage, UID.VLMicroscopicImageStorage,
                UID.VLSlideCoordinatesMicroscopicImageStorage, UID.VLWholeSlideMicroscopyImageStorage);
    }
}

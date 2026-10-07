/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.junit.jupiter.api.Test;

import com.vis.graphynext.dicom.ParametricMapFrameExpander;
import com.vis.graphynext.dicom.SeriesLayout;
import com.vis.graphynext.dicom.SeriesLayoutAssembler;

/**
 * NIfTI（整数でない float）→ Parametric Map → 展開（layout・フレームの切り出し・空白）の往復（fw/nifti-import.md §3.1）。
 *
 * <p>表示側（cornerstone dicom-image-loader 3.33.5）は、BitsAllocated 32 で <b>PixelRepresentation が無いとき</b>だけ
 * Float32 として読む。切り出したフレームがその形になっているか、値が元の float32 と一致するかを見る。
 */
class ParametricMapRoundTripTest {

    private static final int NX = 3;
    private static final int NY = 2;
    private static final int NZ = 4;
    private static final int NT = 2;
    private static final double DX = 0.7;
    private static final double DY = 0.8;
    private static final double DZ = 2.5;

    /** 値 = 0.25 × 通し番号 + 0.1（整数でない）。(z=1, t=0, x=1, y=0) を NaN にする。 */
    private static float valueAt(int x, int y, int z, int t) {
        if (x == 1 && y == 0 && z == 1 && t == 0) {
            return Float.NaN;
        }
        return (float) (0.25 * (((t * NZ + z) * NY + y) * NX + x) + 0.1);
    }

    private static Path nifti4d() throws IOException {
        ByteBuffer d = ByteBuffer.allocate(NX * NY * NZ * NT * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (int t = 0; t < NT; t++) {
            for (int z = 0; z < NZ; z++) {
                for (int y = 0; y < NY; y++) {
                    for (int x = 0; x < NX; x++) {
                        d.putFloat(valueAt(x, y, z, t));
                    }
                }
            }
        }
        ByteBuffer b = ByteBuffer.allocate(352 + d.capacity()).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(0, 348);
        b.putShort(40, (short) 4);
        b.putShort(42, (short) NX);
        b.putShort(44, (short) NY);
        b.putShort(46, (short) NZ);
        b.putShort(48, (short) NT);
        b.putShort(50, (short) 1);
        b.putShort(70, (short) NiftiHeader.DT_FLOAT32);
        b.putShort(72, (short) 32);
        float[] pixdim = { 1, (float) DX, (float) DY, (float) DZ, 1.5f, 0, 0, 0 };
        for (int i = 0; i < 8; i++) {
            b.putFloat(76 + i * 4, pixdim[i]);
        }
        b.putFloat(108, 352f);
        b.putFloat(112, 1f);
        b.putFloat(116, 0f);
        b.put(123, (byte) 10); // mm・s
        b.putShort(254, (short) 1);
        // RAS の sform（右手系）。原点 (10, 20, 30)
        float[][] srow = { { (float) DX, 0, 0, 10 }, { 0, (float) DY, 0, 20 }, { 0, 0, (float) DZ, 30 } };
        for (int r = 0; r < 3; r++) {
            for (int i = 0; i < 4; i++) {
                b.putFloat(280 + r * 16 + i * 4, srow[r][i]);
            }
        }
        b.position(352);
        b.put(d.array());
        Path f = Files.createTempFile("pm", ".nii");
        Files.write(f, b.array());
        return f;
    }

    private static List<Attributes> convert() throws IOException {
        return convert(null);
    }

    private static List<Attributes> convert(String unit) throws IOException {
        List<Attributes> out = new ArrayList<>();
        NiftiToDicom.convert(nifti4d(), new NiftiToDicom.Options("MR", "P", "T^P", "", "", "20261006",
                "s", "adc", 1, null, null, Map.of(), unit), (ds, ts) -> out.add(new Attributes(ds)));
        return out;
    }

    /** ヘッダだけ（画素なし）。保管庫のヘッダ読みと同じ条件にする。 */
    private static Attributes headerOf(Attributes full) {
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
    void 取り込むと_NZ_x_NT_の_Parametric_Map_になる() throws IOException {
        List<Attributes> frames = convert();
        assertThat(frames).hasSize(NZ * NT);
        assertThat(frames).allMatch(ParametricMapFrameExpander::isParametricMap);
    }

    @Test
    void layout_は_z_と_t_と幾何をFunctional_Groupsから組む() throws IOException {
        List<Attributes> headers = new ArrayList<>();
        for (Attributes ds : convert()) {
            headers.add(headerOf(ds));
        }
        SeriesLayout layout = ParametricMapFrameExpander.layout(headers);
        assertThat(layout).isNotNull();
        assertThat(layout.nZ()).isEqualTo(NZ);
        assertThat(layout.nT()).isEqualTo(NT);
        assertThat(layout.nC()).isEqualTo(1);
        assertThat(layout.cells()).hasSize(NZ * NT);
        assertThat(layout.imageWidth()).isEqualTo(NX);
        assertThat(layout.imageHeight()).isEqualTo(NY);
        assertThat(layout.pixelSpacingRow()).isCloseTo(DY, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(layout.pixelSpacingCol()).isCloseTo(DX, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(layout.pixelFormat().bitsAllocated()).isEqualTo(32);
        // z は法線方向の位置で昇順。隣り合う z の IPP の差はスライス間隔
        List<SeriesLayout.ZSpatial> zs = layout.zSpatial();
        assertThat(zs).hasSize(NZ);
        for (int k = 1; k < NZ; k++) {
            double[] a = zs.get(k - 1).imagePositionPatient();
            double[] c = zs.get(k).imagePositionPatient();
            assertThat(Math.hypot(Math.hypot(c[0] - a[0], c[1] - a[1]), c[2] - a[2]))
                    .isCloseTo(DZ, org.assertj.core.data.Offset.offset(1e-6));
        }
        // web の組み立て（SeriesLayoutAssembler）も同じ展開器を通る
        SeriesLayout web = SeriesLayoutAssembler.fromAttributes(headers);
        assertThat(web.nZ()).isEqualTo(NZ);
        assertThat(web.nT()).isEqualTo(NT);
    }

    @Test
    void 切り出したフレームは表示側が_float_として読める形で値も一致する() throws IOException {
        List<Attributes> frames = convert();
        // NIfTI は z 最速 → t の順で 1 インスタンスずつ出る
        for (int t = 0; t < NT; t++) {
            for (int z = 0; z < NZ; z++) {
                Attributes src = frames.get(t * NZ + z);
                Attributes out = parse(ParametricMapFrameExpander.extractFrame(src, 0));
                assertThat(out.getString(Tag.SOPClassUID)).isEqualTo(UID.SecondaryCaptureImageStorage);
                assertThat(out.getInt(Tag.BitsAllocated, 0)).isEqualTo(32);
                // ★ PixelRepresentation があると表示側は整数として読む
                assertThat(out.contains(Tag.PixelRepresentation)).isFalse();
                assertThat(out.contains(Tag.PixelData)).isFalse();
                assertThat(out.getDouble(Tag.RescaleSlope, 0)).isEqualTo(1.0);
                assertThat(out.getDouble(Tag.RescaleIntercept, 1)).isEqualTo(0.0);
                assertThat(out.getDoubles(Tag.ImagePositionPatient)).hasSize(3);
                assertThat(out.getDoubles(Tag.ImageOrientationPatient)).hasSize(6);
                float[] v = new float[NX * NY];
                ByteBuffer.wrap(out.getBytes(Tag.FloatPixelData)).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(v);
                for (int y = 0; y < NY; y++) {
                    for (int x = 0; x < NX; x++) {
                        // sform が右手系なので行は反転しない
                        float want = valueAt(x, y, z, t);
                        if (Float.isNaN(want)) {
                            assertThat(v[y * NX + x]).isNaN();
                        } else {
                            assertThat(v[y * NX + x]).isEqualTo(want);
                        }
                    }
                }
                // W/L は NaN を除いた最小・最大から
                assertThat(Double.isFinite(out.getDouble(Tag.WindowCenter, Double.NaN))).isTrue();
                assertThat(out.getString(Tag.VOILUTFunction)).isEqualTo("LINEAR_EXACT");
            }
        }
    }

    @Test
    void 空白のフレームは_NaN_で幾何は指定した位置() throws IOException {
        Attributes header = headerOf(convert().get(0));
        double[] ipp = { 1.5, -2.5, 99.0 };
        Attributes out = parse(ParametricMapFrameExpander.blankFrame(header, ipp));
        assertThat(out.getDoubles(Tag.ImagePositionPatient)).containsExactly(ipp);
        assertThat(out.contains(Tag.PixelRepresentation)).isFalse();
        float[] v = new float[NX * NY];
        ByteBuffer.wrap(out.getBytes(Tag.FloatPixelData)).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(v);
        for (float f : v) {
            assertThat(f).isNaN();
        }
    }

    @Test
    void 通常の画像は展開器の対象にならない() throws IOException {
        Attributes ct = new Attributes();
        ct.setString(Tag.SOPClassUID, org.dcm4che3.data.VR.UI, UID.CTImageStorage);
        assertThat(ParametricMapFrameExpander.isParametricMap(ct)).isFalse();
        assertThat(ParametricMapFrameExpander.layout(List.of(ct))).isNull();
        assertThat(ParametricMapFrameExpander.extractFrame(ct, 0)).isNull();
    }

    private static Attributes rwvmUnit(Attributes pm) {
        return pm.getNestedDataset(Tag.SharedFunctionalGroupsSequence)
                .getNestedDataset(Tag.RealWorldValueMappingSequence)
                .getNestedDataset(Tag.MeasurementUnitsCodeSequence);
    }

    @Test
    void 単位は_RWVM_の_UCUM_に入り_切り出したフレームの_RescaleType_に出る() throws IOException {
        Attributes pm = convert("mm2/s").get(0);
        Attributes u = rwvmUnit(pm);
        assertThat(u.getString(Tag.CodeValue)).isEqualTo("mm2/s");
        assertThat(u.getString(Tag.CodingSchemeDesignator)).isEqualTo("UCUM");
        Attributes out = parse(ParametricMapFrameExpander.extractFrame(pm, 0));
        assertThat(out.getString(Tag.RescaleType)).isEqualTo("mm2/s");
    }

    @Test
    void 単位を指定しなければ無次元の_1_で表示は空() throws IOException {
        Attributes pm = convert(null).get(0);
        assertThat(rwvmUnit(pm).getString(Tag.CodeValue)).isEqualTo("1");
        Attributes out = parse(ParametricMapFrameExpander.extractFrame(pm, 0));
        assertThat(out.getString(Tag.RescaleType, "")).isEmpty();
    }

    @Test
    void 既知の_UCUM_は表示名に直す() throws IOException {
        assertThat(NiftiToDicom.unitLabel("[hnsf'U]")).isEqualTo("HU");
        assertThat(NiftiToDicom.unitLabel("{SUVbw}g/ml")).isEqualTo("SUVbw");
        assertThat(NiftiToDicom.unitLabel("1")).isEmpty();
        assertThat(NiftiToDicom.unitLabel("ms")).isEqualTo("ms");
        Attributes pm = convert("[hnsf'U]").get(0);
        assertThat(rwvmUnit(pm).getString(Tag.CodeMeaning)).isEqualTo("HU");
        assertThat(parse(ParametricMapFrameExpander.extractFrame(pm, 0)).getString(Tag.RescaleType)).isEqualTo("HU");
        assertThat(NiftiToDicom.validUnit("ABCDEFGHIJKLMNOPQ")).isFalse(); // 17 文字
        assertThat(NiftiToDicom.validUnit("mm2/s")).isTrue();
    }
}

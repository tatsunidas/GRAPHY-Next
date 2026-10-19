/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
import org.junit.jupiter.api.Test;

/**
 * Raw データ（ヘッダの無い画素配列）の変換（fw/nifti-import.md「Raw データ」）。
 * 既知の値で Raw を作り、取り込んだ DICOM の値・幾何を申告どおりかで確かめる。申告を誤った負例では一致しないことも見る。
 */
class RawImportTest {

    private static final int NX = 64;
    private static final int NY = 48;
    private static final int NZ = 10;
    private static final int OFFSET = 512;

    /** x 最速 → y → z の順の int16（値はボクセル番号から決まる。負の値も含む）。 */
    private static short valueAt(int x, int y, int z) {
        return (short) (x * 37 - y * 11 + z * 1000 - 3000);
    }

    private static Path rawInt16(ByteOrder order, int offset, byte[] head) throws IOException {
        ByteBuffer b = ByteBuffer.allocate(offset + NX * NY * NZ * 2).order(order);
        if (head != null) {
            b.put(0, head);
        }
        b.position(offset);
        for (int z = 0; z < NZ; z++) {
            for (int y = 0; y < NY; y++) {
                for (int x = 0; x < NX; x++) {
                    b.putShort(valueAt(x, y, z));
                }
            }
        }
        Path f = Files.createTempFile("raw", ".raw");
        Files.write(f, b.array());
        return f;
    }

    private static RawSpec spec(String type, String order, String orientation) {
        return new RawSpec(NX, NY, NZ, 1, type, order, OFFSET, new double[] { 0.5, 0.5, 2.0 }, orientation, null);
    }

    private static List<Attributes> convert(Path f, RawSpec s) throws IOException {
        List<Attributes> out = new ArrayList<>();
        NiftiToDicom.convert(f, s.toHeader(), new NiftiToDicom.Options("CT", "P", "T^P", "", "", "20261017",
                null, null, 1, null, null, Map.of()), (ds, ts) -> out.add(new Attributes(ds)));
        return out;
    }

    /** 取り込んだ値（Rescale で戻した値）を [z][y][x] で返す。 */
    private static double[][][] values(List<Attributes> frames) throws IOException {
        double[][][] v = new double[frames.size()][NY][NX];
        for (int z = 0; z < frames.size(); z++) {
            Attributes ds = frames.get(z);
            double slope = ds.getDouble(Tag.RescaleSlope, 1);
            double intercept = ds.getDouble(Tag.RescaleIntercept, 0);
            boolean signed = ds.getInt(Tag.PixelRepresentation, 0) == 1;
            short[] s = new short[NX * NY];
            ByteBuffer.wrap(ds.getBytes(Tag.PixelData)).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(s);
            for (int y = 0; y < NY; y++) {
                for (int x = 0; x < NX; x++) {
                    short code = s[y * NX + x];
                    v[z][y][x] = (signed ? code : code & 0xFFFF) * slope + intercept;
                }
            }
        }
        return v;
    }

    private static int mismatches(double[][][] v) {
        int bad = 0;
        for (int z = 0; z < NZ; z++) {
            for (int y = 0; y < NY; y++) {
                for (int x = 0; x < NX; x++) {
                    if (v[z][y][x] != valueAt(x, y, z)) {
                        bad++;
                    }
                }
            }
        }
        return bad;
    }

    @Test
    void int16_リトルエンディアンを読み飛ばし付きで取り込むと値と幾何が申告どおり() throws IOException {
        List<Attributes> frames = convert(rawInt16(ByteOrder.LITTLE_ENDIAN, OFFSET, null), spec("int16", "little", "axial"));
        assertThat(frames).hasSize(NZ);
        assertThat(mismatches(values(frames))).isZero();
        for (int z = 0; z < NZ; z++) {
            Attributes ds = frames.get(z);
            assertThat(ds.getDoubles(Tag.PixelSpacing)).containsExactly(0.5, 0.5);
            assertThat(ds.getDoubles(Tag.ImagePositionPatient)).containsExactly(0.0, 0.0, 2.0 * z);
            assertThat(ds.getDoubles(Tag.ImageOrientationPatient)).containsExactly(1.0, 0.0, 0.0, 0.0, 1.0, 0.0);
            assertThat(ds.getInt(Tag.Rows, 0)).isEqualTo(NY);
            assertThat(ds.getInt(Tag.Columns, 0)).isEqualTo(NX);
        }
        Attributes first = frames.get(0);
        assertThat(first.getString(Tag.DerivationDescription)).contains("raw data").contains("user input");
        assertThat(first.getString(Tag.ImageComments)).contains("user input");
        assertThat(first.getString(Tag.StudyDescription)).isEqualTo("Imported from raw data");
        assertThat(first.getDouble(Tag.SliceThickness, 0)).isEqualTo(2.0);
    }

    @Test
    void ビッグエンディアンの正例と_バイト順を誤った負例() throws IOException {
        Path be = rawInt16(ByteOrder.BIG_ENDIAN, OFFSET, null);
        assertThat(mismatches(values(convert(be, spec("int16", "big", "axial"))))).isZero();
        // 負例: リトルの画素をビッグと申告すると値が一致しない（照合が効いていることの確認）
        Path le = rawInt16(ByteOrder.LITTLE_ENDIAN, OFFSET, null);
        assertThat(mismatches(values(convert(le, spec("int16", "big", "axial"))))).isGreaterThan(NX * NY * NZ / 2);
    }

    @Test
    void 読み飛ばしを誤ると値が一致しない() throws IOException {
        Path f = rawInt16(ByteOrder.LITTLE_ENDIAN, OFFSET, null);
        RawSpec wrong = new RawSpec(NX, NY, NZ, 1, "int16", "little", 0, new double[] { 0.5, 0.5, 2.0 }, "axial", null);
        assertThat(mismatches(values(convert(f, wrong)))).isGreaterThan(0);
    }

    @Test
    void 先頭が_gzip_のマジックと同じ並びでも_Raw_として読める() throws IOException {
        // 読み飛ばし領域の先頭が 0x1F 0x8B。gzip と判定すると読めない
        Path f = rawInt16(ByteOrder.LITTLE_ENDIAN, OFFSET, new byte[] { 0x1F, (byte) 0x8B, 8, 0 });
        assertThat(mismatches(values(convert(f, spec("int16", "little", "axial"))))).isZero();
    }

    @Test
    void 冠状と矢状の向き() throws IOException {
        Path f = rawInt16(ByteOrder.LITTLE_ENDIAN, OFFSET, null);
        List<Attributes> cor = convert(f, spec("int16", "little", "coronal"));
        assertThat(cor.get(0).getDoubles(Tag.ImageOrientationPatient)).containsExactly(1.0, 0.0, 0.0, 0.0, 0.0, -1.0);
        // スライス方向は 行 × 列 = (0,1,0)（後ろ向き）
        assertThat(cor.get(3).getDoubles(Tag.ImagePositionPatient)).containsExactly(0.0, 6.0, 0.0);
        assertThat(mismatches(values(cor))).isZero(); // 画素の並びは向きで変わらない（行 0 が上）

        List<Attributes> sag = convert(f, spec("int16", "little", "sagittal"));
        assertThat(sag.get(0).getDoubles(Tag.ImageOrientationPatient)).containsExactly(0.0, 1.0, 0.0, 0.0, 0.0, -1.0);
        assertThat(sag.get(3).getDoubles(Tag.ImagePositionPatient)).containsExactly(-6.0, 0.0, 0.0);
        assertThat(mismatches(values(sag))).isZero();
    }

    @Test
    void 原点を指定するとその位置から並ぶ() throws IOException {
        Path f = rawInt16(ByteOrder.LITTLE_ENDIAN, OFFSET, null);
        RawSpec s = new RawSpec(NX, NY, NZ, 1, "int16", "little", OFFSET, new double[] { 0.5, 0.5, 2.0 }, "axial",
                new double[] { -16, -12, 30 });
        List<Attributes> frames = convert(f, s);
        assertThat(frames.get(2).getDoubles(Tag.ImagePositionPatient)).containsExactly(-16.0, -12.0, 34.0);
    }

    @Test
    void float32_の非整数は_Parametric_Map_で値の差が0() throws IOException {
        int n = 8 * 6 * 3;
        ByteBuffer b = ByteBuffer.allocate(n * 4).order(ByteOrder.LITTLE_ENDIAN);
        float[] want = new float[n];
        for (int i = 0; i < n; i++) {
            want[i] = 0.25f + i * 0.137f - 7.5f;
            b.putFloat(want[i]);
        }
        Path f = Files.createTempFile("raw", ".f32");
        Files.write(f, b.array());
        RawSpec s = new RawSpec(8, 6, 3, 1, "float32", "little", 0, new double[] { 1, 1, 1 }, "axial", null);
        List<Attributes> frames = convert(f, s);
        assertThat(frames).allMatch(ds -> UID.ParametricMapStorage.equals(ds.getString(Tag.SOPClassUID)));
        float[] got = new float[n];
        int k = 0;
        for (Attributes ds : frames) {
            float[] fr = new float[8 * 6];
            ByteBuffer.wrap(ds.getBytes(Tag.FloatPixelData)).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(fr);
            System.arraycopy(fr, 0, got, k, fr.length);
            k += fr.length;
        }
        assertThat(got).containsExactly(want);
    }

    @Test
    void 必要なバイト数と申告の誤り() {
        assertThat(spec("int16", "little", "axial").requiredBytes()).isEqualTo(OFFSET + (long) NX * NY * NZ * 2);
        assertThat(new RawSpec(2, 2, 2, 3, "float64", "big", 10, new double[] { 1, 1, 1 }, "axial", null).requiredBytes())
                .isEqualTo(10 + 2 * 2 * 2 * 3 * 8);
        assertThatThrownBy(() -> spec("int12", "little", "axial").requiredBytes()).isInstanceOf(RawSpec.InvalidSpec.class);
        assertThatThrownBy(() -> spec("int16", "middle", "axial").requiredBytes()).isInstanceOf(RawSpec.InvalidSpec.class);
        assertThatThrownBy(() -> spec("int16", "little", "oblique").toHeader()).isInstanceOf(RawSpec.InvalidSpec.class);
        assertThatThrownBy(() -> new RawSpec(0, 2, 2, 1, "int16", "little", 0, new double[] { 1, 1, 1 }, "axial", null)
                .requiredBytes()).isInstanceOf(RawSpec.InvalidSpec.class);
        assertThatThrownBy(() -> new RawSpec(2, 2, 2, 1, "int16", "little", 0, new double[] { 1, 0, 1 }, "axial", null)
                .requiredBytes()).isInstanceOf(RawSpec.InvalidSpec.class);
    }

    @Test
    void 画素がファイルに足りなければ変換が失敗する() throws IOException {
        Path f = rawInt16(ByteOrder.LITTLE_ENDIAN, OFFSET, null);
        RawSpec tooMany = new RawSpec(NX, NY, NZ + 1, 1, "int16", "little", OFFSET, new double[] { 0.5, 0.5, 2.0 }, "axial", null);
        assertThatThrownBy(() -> convert(f, tooMany)).isInstanceOf(IOException.class).hasMessageContaining("足りません");
    }
}

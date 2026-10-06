/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import static org.assertj.core.api.Assertions.assertThat;

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
import org.junit.jupiter.api.Test;

/**
 * NIfTI の画素の取り込みの正確さ（fw/nifti-import.md §3）。
 *
 * <p>既知の値で NIfTI を作り、取り込んだ DICOM から Rescale で値を戻して元と比べる。
 * <b>整数値で 16 bit に収まるものは完全一致</b>、それ以外は<b>誤差が刻み（RescaleSlope）の半分以内</b>。
 * 2026-10-06 に NLSTseg の int32 CT（−2048〜1508）が量子化されて最大 0.056 HU ずれたのが発端。
 */
class NiftiPixelExactnessTest {

    private static final int NX = 4;
    private static final int NY = 3;
    private static final int NZ = 2;
    private static final int N = NX * NY * NZ;

    /** 値の並び（x 最速 → y → z）を、指定のデータ型で NIfTI-1 にする。 */
    private static Path nifti(int datatype, double[] values, double sclSlope, double sclInter) throws IOException {
        int bytes = switch (datatype) {
            case NiftiHeader.DT_INT32, NiftiHeader.DT_UINT32, NiftiHeader.DT_FLOAT32 -> 4;
            case NiftiHeader.DT_INT64, NiftiHeader.DT_UINT64, NiftiHeader.DT_FLOAT64 -> 8;
            default -> throw new IllegalArgumentException("datatype " + datatype);
        };
        ByteBuffer d = ByteBuffer.allocate(values.length * bytes).order(ByteOrder.LITTLE_ENDIAN);
        for (double v : values) {
            switch (datatype) {
                case NiftiHeader.DT_INT32 -> d.putInt((int) v);
                case NiftiHeader.DT_UINT32 -> d.putInt((int) (long) v);
                case NiftiHeader.DT_FLOAT32 -> d.putFloat((float) v);
                case NiftiHeader.DT_INT64, NiftiHeader.DT_UINT64 -> d.putLong((long) v);
                default -> d.putDouble(v);
            }
        }
        ByteBuffer b = ByteBuffer.allocate(352 + d.capacity()).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(0, 348);
        b.putShort(40, (short) 3);
        b.putShort(42, (short) NX);
        b.putShort(44, (short) NY);
        b.putShort(46, (short) NZ);
        b.putShort(48, (short) 1);
        b.putShort(50, (short) 1);
        b.putShort(70, (short) datatype);
        b.putShort(72, (short) (bytes * 8));
        float[] pixdim = { 1, 1, 1, 1, 0, 0, 0, 0 };
        for (int i = 0; i < 8; i++) {
            b.putFloat(76 + i * 4, pixdim[i]);
        }
        b.putFloat(108, 352f);
        b.putFloat(112, (float) sclSlope);
        b.putFloat(116, (float) sclInter);
        b.put(123, (byte) 2);
        b.putShort(254, (short) 1);
        float[][] srow = { { 1, 0, 0, 0 }, { 0, 1, 0, 0 }, { 0, 0, 1, 0 } };
        for (int r = 0; r < 3; r++) {
            for (int i = 0; i < 4; i++) {
                b.putFloat(280 + r * 16 + i * 4, srow[r][i]);
            }
        }
        b.position(352);
        b.put(d.array());
        Path f = Files.createTempFile("px", ".nii");
        Files.write(f, b.array());
        return f;
    }

    private record Converted(List<Attributes> frames, NiftiToDicom.Summary summary) {
        /** 取り込んだ値（Rescale で戻した値。パディングは NaN）を元の並びで返す。 */
        double[] values() throws IOException {
            double[] out = new double[N];
            int k = 0;
            for (Attributes ds : frames) {
                boolean signed = ds.getInt(Tag.PixelRepresentation, 0) == 1;
                double slope = ds.getDouble(Tag.RescaleSlope, 1);
                double intercept = ds.getDouble(Tag.RescaleIntercept, 0);
                Integer pad = ds.contains(Tag.PixelPaddingValue) ? ds.getInt(Tag.PixelPaddingValue, 0) : null;
                short[] s = new short[NX * NY];
                ByteBuffer.wrap(ds.getBytes(Tag.PixelData)).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(s);
                // sform が単位行列（右手系）なので行の反転は起きない＝NIfTI と同じ並び
                for (int y = 0; y < NY; y++) {
                    for (int x = 0; x < NX; x++) {
                        short code = s[y * NX + x];
                        int stored = signed ? code : code & 0xFFFF;
                        out[k + y * NX + x] = pad != null && stored == pad ? Double.NaN : stored * slope + intercept;
                    }
                }
                k += NX * NY;
            }
            return out;
        }

        double slope() {
            return frames.get(0).getDouble(Tag.RescaleSlope, 1);
        }
    }

    private static Converted convert(Path f) throws IOException {
        List<Attributes> out = new ArrayList<>();
        NiftiToDicom.Summary s = NiftiToDicom.convert(f, new NiftiToDicom.Options("CT", "P", "T^P", "", "", "20261006",
                "s", "s", 1, null, null, Map.of()), (ds, ts) -> out.add(new Attributes(ds)));
        return new Converted(out, s);
    }

    private static double[] ramp(double start, double step) {
        double[] v = new double[N];
        for (int i = 0; i < N; i++) {
            v[i] = start + i * step;
        }
        return v;
    }

    private static void assertExact(Converted c, double[] expected) throws IOException {
        assertThat(c.values()).containsExactly(expected);
        assertThat(c.summary().pixelConversion()).contains("可逆");
    }

    @Test
    void int32_で16bitに収まる値はそのまま可逆() throws IOException {
        double[] v = ramp(-2048, 155); // −2048〜1517
        Converted c = convert(nifti(NiftiHeader.DT_INT32, v, 1, 0));
        assertExact(c, v);
        assertThat(c.slope()).isEqualTo(1.0);
        assertThat(c.frames().get(0).getInt(Tag.PixelRepresentation, -1)).isEqualTo(1);
    }

    @Test
    void int32_で0から65535は_unsigned_で可逆() throws IOException {
        double[] v = ramp(0, 2849); // 0〜65527
        Converted c = convert(nifti(NiftiHeader.DT_INT32, v, 1, 0));
        assertExact(c, v);
        assertThat(c.frames().get(0).getInt(Tag.PixelRepresentation, -1)).isEqualTo(0);
    }

    @Test
    void 範囲が65535以内なら符号付きの範囲を外れていてもオフセットで可逆() throws IOException {
        double[] v = ramp(-40000, 2849); // −40000〜25527（幅 65527）
        Converted c = convert(nifti(NiftiHeader.DT_INT32, v, 1, 0));
        assertExact(c, v);
        assertThat(c.summary().pixelConversion()).contains("オフセット");
    }

    @Test
    void 範囲が16bitを超える整数は全域で量子化し誤差は刻みの半分以内() throws IOException {
        double[] v = ramp(0, 4500); // 0〜103500
        Converted c = convert(nifti(NiftiHeader.DT_INT32, v, 1, 0));
        assertThat(c.summary().pixelConversion()).contains("量子化");
        double half = c.slope() / 2;
        double[] got = c.values();
        for (int i = 0; i < N; i++) {
            assertThat(Math.abs(got[i] - v[i])).isLessThanOrEqualTo(half + 1e-9);
        }
        // 16 bit の全域を使う（今までは 32000 段階だけだった）
        assertThat(c.slope()).isCloseTo(103500.0 / 65535, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void uint32_int64_uint64_も整数値なら可逆() throws IOException {
        double[] v = ramp(100, 1000);
        for (int dt : new int[] { NiftiHeader.DT_UINT32, NiftiHeader.DT_INT64, NiftiHeader.DT_UINT64 }) {
            assertExact(convert(nifti(dt, v, 1, 0)), v);
        }
    }

    @Test
    void int64_の両端のような極端な範囲でも落ちずに量子化する() throws IOException {
        double[] v = ramp(0, 1);
        v[0] = Long.MIN_VALUE;
        v[N - 1] = Long.MAX_VALUE;
        Converted c = convert(nifti(NiftiHeader.DT_INT64, v, 1, 0));
        assertThat(c.summary().pixelConversion()).contains("量子化");
    }

    @Test
    void 値が整数の_float_は可逆_HU_を_float_で保存した_CT() throws IOException {
        double[] v = ramp(-1024, 97);
        assertExact(convert(nifti(NiftiHeader.DT_FLOAT32, v, 1, 0)), v);
        assertExact(convert(nifti(NiftiHeader.DT_FLOAT64, v, 1, 0)), v);
    }

    @Test
    void scl_slope_と_scl_inter_は_Rescale_に合成する() throws IOException {
        double[] raw = ramp(0, 7);
        Converted c = convert(nifti(NiftiHeader.DT_FLOAT64, raw, 2, -1024));
        double[] expected = new double[N];
        for (int i = 0; i < N; i++) {
            expected[i] = raw[i] * 2 - 1024;
        }
        assertExact(c, expected);
    }

    @Test
    void 整数でない_float_は全域で量子化し誤差は刻みの半分以内() throws IOException {
        double[] v = ramp(0.001, 0.0137); // ADC のような小さい値
        Converted c = convert(nifti(NiftiHeader.DT_FLOAT32, v, 1, 0));
        assertThat(c.summary().pixelConversion()).contains("量子化").contains("最大誤差");
        double half = c.slope() / 2;
        double[] got = c.values();
        for (int i = 0; i < N; i++) {
            assertThat(Math.abs(got[i] - (float) v[i])).isLessThanOrEqualTo(half + 1e-12);
        }
    }

    @Test
    void NaN_と無限大はパディング値になりほかの値は可逆のまま() throws IOException {
        double[] v = ramp(-1000, 50);
        v[3] = Double.NaN;
        v[10] = Double.POSITIVE_INFINITY;
        v[17] = Double.NEGATIVE_INFINITY;
        Converted c = convert(nifti(NiftiHeader.DT_FLOAT32, v, 1, 0));
        assertThat(c.frames().get(0).getInt(Tag.PixelPaddingValue, 0)).isEqualTo(Short.MIN_VALUE);
        assertThat(c.summary().pixelConversion()).contains("可逆").contains("3 ボクセル");
        double[] got = c.values();
        for (int i = 0; i < N; i++) {
            if (Double.isFinite(v[i])) {
                assertThat(got[i]).isEqualTo(v[i]);
            } else {
                assertThat(got[i]).isNaN();
            }
        }
    }

    @Test
    void NaN_があっても量子化の係数は壊れない() throws IOException {
        // 以前は NaN が最小・最大に混ざって係数が 1 になり、画像全体が潰れていた
        double[] v = ramp(0.5, 0.25);
        v[0] = Double.NaN;
        Converted c = convert(nifti(NiftiHeader.DT_FLOAT32, v, 1, 0));
        double half = c.slope() / 2;
        assertThat(c.slope()).isLessThan(1e-3);
        double[] got = c.values();
        assertThat(got[0]).isNaN();
        for (int i = 1; i < N; i++) {
            assertThat(Math.abs(got[i] - v[i])).isLessThanOrEqualTo(half + 1e-12);
        }
    }

    @Test
    void すべて_NaN_でも落ちない() throws IOException {
        double[] v = new double[N];
        java.util.Arrays.fill(v, Double.NaN);
        Converted c = convert(nifti(NiftiHeader.DT_FLOAT32, v, 1, 0));
        assertThat(java.util.Arrays.stream(c.values()).allMatch(Double::isNaN)).isTrue();
    }
}

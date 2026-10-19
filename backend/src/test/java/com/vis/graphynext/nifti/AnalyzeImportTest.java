/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPOutputStream;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** ANALYZE 7.5 と NIfTI の 2 ファイル形式（.hdr＋.img）の取り込み（fw/nifti-import.md §9）。 */
class AnalyzeImportTest {

    private static final int NX = 4;
    private static final int NY = 3;
    private static final int NZ = 2;

    /** NIfTI の qform=sform=0 で合成される向き（既存の扱い、fw/nifti-import.md §2）。 */
    private static final double[] SYNTH_IOP = { -1, 0, 0, 0, -1, 0 };

    @TempDir
    Path dir;

    /** 348 バイトのヘッダ。niftiPair なら "ni1" と sform（x を 2 倍に伸ばす）を書く。 */
    private static byte[] header(int bitpix, int orient, boolean niftiPair) {
        ByteBuffer b = ByteBuffer.allocate(348).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(0, 348);
        b.putShort(40, (short) 3);
        b.putShort(42, (short) NX);
        b.putShort(44, (short) NY);
        b.putShort(46, (short) NZ);
        b.putShort(48, (short) 1);
        b.putShort(70, (short) NiftiHeader.DT_INT16);
        b.putShort(72, (short) bitpix);
        float[] pixdim = { 1, 0.5f, 0.5f, 3, 0, 0, 0, 0 };
        for (int i = 0; i < 8; i++) {
            b.putFloat(76 + i * 4, pixdim[i]);
        }
        b.putFloat(108, 0f);
        if (niftiPair) {
            b.putShort(254, (short) 1);
            // RAS で x・y 行を −0.5（=LPS の +x・+y）、z を 3。右手系なので行の反転は起きない
            float[][] srow = { { -0.5f, 0, 0, 0 }, { 0, -0.5f, 0, 0 }, { 0, 0, 3, 0 } };
            for (int r = 0; r < 3; r++) {
                for (int i = 0; i < 4; i++) {
                    b.putFloat(280 + r * 16 + i * 4, srow[r][i]);
                }
            }
            b.put(344, (byte) 'n').put(345, (byte) 'i').put(346, (byte) '1').put(347, (byte) 0);
        } else {
            b.put(252, (byte) orient);
            // originator（253〜）にも値を入れておく。parse はここを sform_code として読んでしまう
            b.put(254, (byte) 7);
        }
        return b.array();
    }

    private static byte[] pixels() {
        ByteBuffer b = ByteBuffer.allocate(NX * NY * NZ * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < NX * NY * NZ; i++) {
            b.putShort((short) (i * 10 - 50));
        }
        return b.array();
    }

    private Path pair(String stem, byte[] hdr, boolean gzip) throws IOException {
        Files.write(dir.resolve(stem + ".hdr"), hdr);
        if (gzip) {
            try (OutputStream out = new GZIPOutputStream(Files.newOutputStream(dir.resolve(stem + ".img.gz")))) {
                out.write(pixels());
            }
        } else {
            Files.write(dir.resolve(stem + ".img"), pixels());
        }
        return dir.resolve(stem + ".hdr");
    }

    private static List<Attributes> convert(Path selected) throws IOException {
        NiftiPair p = NiftiPair.resolve(selected);
        List<Attributes> out = new ArrayList<>();
        NiftiToDicom.convert(p.data(), p.readHeader(), new NiftiToDicom.Options("MR", "P", "T^P", "", "", "20261017",
                null, null, 1, null, null, Map.of()), (ds, ts) -> out.add(new Attributes(ds)));
        return out;
    }

    private static int mismatches(List<Attributes> frames) throws IOException {
        int bad = 0;
        int k = 0;
        for (Attributes ds : frames) {
            short[] s = new short[NX * NY];
            ByteBuffer.wrap(ds.getBytes(Tag.PixelData)).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(s);
            double slope = ds.getDouble(Tag.RescaleSlope, 1);
            double icpt = ds.getDouble(Tag.RescaleIntercept, 0);
            for (short v : s) {
                if (v * slope + icpt != k * 10 - 50) {
                    bad++;
                }
                k++;
            }
        }
        return bad;
    }

    @Test
    void ANALYZE_は値の差0で_向きは合成の軸位断() throws IOException {
        List<Attributes> f = convert(pair("a", header(16, 0, false), false));
        assertThat(f).hasSize(NZ);
        assertThat(mismatches(f)).isZero();
        // 合成の向きは NIfTI の qform=sform=0 と同じ（pixdim の対角を RAS とみなして LPS へ直す）
        assertThat(f.get(0).getDoubles(Tag.ImageOrientationPatient)).containsExactly(SYNTH_IOP);
        assertThat(f.get(0).getDoubles(Tag.PixelSpacing)).containsExactly(0.5, 0.5);
        assertThat(f.get(1).getDoubles(Tag.ImagePositionPatient)[2]).isEqualTo(3.0);
        assertThat(f.get(0).getString(Tag.DerivationDescription)).contains("ANALYZE").contains("SYNTHESIZED");
        assertThat(f.get(0).getString(Tag.ImageComments)).contains("ANALYZE").contains("orient=0");
    }

    @Test
    void img_gz_でも_img_を選んでも同じ() throws IOException {
        Path hdr = pair("g", header(16, 0, false), true);
        assertThat(mismatches(convert(hdr))).isZero();
        assertThat(mismatches(convert(dir.resolve("g.img.gz")))).isZero();
        Path plain = pair("p", header(16, 0, false), false);
        assertThat(NiftiPair.resolve(dir.resolve("p.img"))).isEqualTo(NiftiPair.resolve(plain));
    }

    @Test
    void orient_を入れても向きは変わらず_parse_で読むと_sform_を取り違える() throws IOException {
        byte[] hdr = header(16, 1, false);
        List<Attributes> f = convert(pair("o", hdr, false));
        assertThat(f.get(0).getDoubles(Tag.ImageOrientationPatient)).containsExactly(SYNTH_IOP);
        assertThat(f.get(0).getString(Tag.ImageComments)).contains("orient=1");
        // 負例: 1 ファイル形式の parse で読むと、orient・originator の領域を qform・sform として読んでしまう
        NiftiHeader wrong = NiftiHeader.parse(java.util.Arrays.copyOf(hdr, 540));
        assertThat(wrong.qformCode != 0 || wrong.sformCode != 0).isTrue();
        assertThat(NiftiHeader.parsePair(java.util.Arrays.copyOf(hdr, 540)).sformCode).isZero();
    }

    @Test
    void NIfTI_の_2_ファイル形式は_sform_を使う() throws IOException {
        List<Attributes> f = convert(pair("n", header(16, 0, true), false));
        assertThat(mismatches(f)).isZero();
        assertThat(f.get(0).getDoubles(Tag.ImageOrientationPatient)).containsExactly(1.0, 0.0, 0.0, 0.0, 1.0, 0.0);
        assertThat(f.get(0).getDoubles(Tag.ImageOrientationPatient)).isNotEqualTo(SYNTH_IOP); // アフィンが効いている
        assertThat(f.get(0).getString(Tag.DerivationDescription)).contains("NIfTI pair").contains("sform");
        assertThat(f.get(0).contains(Tag.ImageComments)).isFalse();
    }

    @Test
    void bitpix_が食い違っても_datatype_から読む() throws IOException {
        Path hdr = pair("b", header(5, 0, false), false);
        NiftiHeader h = NiftiPair.resolve(hdr).readHeader();
        assertThat(h.bitpix).isEqualTo(16);
        assertThat(h.bitpixNote).contains("bitpix=5");
        assertThat(mismatches(convert(hdr))).isZero();
    }

    @Test
    void 対が無ければ理由つきで失敗() throws IOException {
        Files.write(dir.resolve("lonely.hdr"), header(16, 0, false));
        assertThatThrownBy(() -> NiftiPair.resolve(dir.resolve("lonely.hdr"))).hasMessageContaining(".img");
        Files.write(dir.resolve("only.img"), pixels());
        assertThatThrownBy(() -> NiftiPair.resolve(dir.resolve("only.img"))).hasMessageContaining(".hdr");
    }

    @Test
    void 圧縮していない_img_の先頭が_gzip_のマジックでも読める() throws IOException {
        Files.write(dir.resolve("m.hdr"), header(16, 0, false));
        byte[] px = pixels();
        px[0] = 0x1f;
        px[1] = (byte) 0x8b;
        Files.write(dir.resolve("m.img"), px);
        List<Attributes> f = convert(dir.resolve("m.hdr"));
        assertThat(f).hasSize(NZ);
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
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
import org.dcm4che3.data.UID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * NIfTI → DICOM 変換のテスト。
 *
 * <p>ヘッダを自前で組み立てた合成ファイルで、**幾何・次元・画素・メタデータの写し**を数値で確認する。
 */
class NiftiToDicomTest {

    /** NIfTI-1 のヘッダ＋データを組み立てる。 */
    private static byte[] nifti1(int nx, int ny, int nz, int nt, int datatype, int bitpix,
            double[] pixdim, double[] srowX, double[] srowY, double[] srowZ, int sformCode,
            byte[] data) {
        ByteBuffer b = ByteBuffer.allocate(352 + data.length).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(0, 348);
        short dims = (short) (nt > 1 ? 4 : 3);
        b.putShort(40, dims);
        b.putShort(42, (short) nx);
        b.putShort(44, (short) ny);
        b.putShort(46, (short) nz);
        b.putShort(48, (short) Math.max(1, nt));
        b.putShort(50, (short) 1);
        b.putShort(70, (short) datatype);
        b.putShort(72, (short) bitpix);
        for (int i = 0; i < pixdim.length && i < 8; i++) {
            b.putFloat(76 + i * 4, (float) pixdim[i]);
        }
        b.putFloat(108, 352f); // vox_offset
        b.putFloat(112, 1f); // scl_slope
        b.putFloat(116, 0f); // scl_inter
        b.put(123, (byte) 2); // xyzt_units = mm
        b.putShort(252, (short) 0); // qform_code
        b.putShort(254, (short) sformCode);
        if (srowX != null) {
            for (int i = 0; i < 4; i++) {
                b.putFloat(280 + i * 4, (float) srowX[i]);
                b.putFloat(296 + i * 4, (float) srowY[i]);
                b.putFloat(312 + i * 4, (float) srowZ[i]);
            }
        }
        b.position(352);
        b.put(data);
        return b.array();
    }

    private static byte[] int16Data(int voxels, int seedBase) {
        ByteBuffer d = ByteBuffer.allocate(voxels * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < voxels; i++) {
            d.putShort((short) (seedBase + i));
        }
        return d.array();
    }

    private static List<Attributes> convert(Path file, NiftiToDicom.Options opts) throws IOException {
        List<Attributes> out = new ArrayList<>();
        NiftiToDicom.convert(file, opts, (ds, tsuid) -> out.add(new Attributes(ds)));
        return out;
    }

    private static NiftiToDicom.Options opts() {
        return new NiftiToDicom.Options("MR", "P1", "TEST^PATIENT", "", "", "20260811",
                "study", "series", 1, null, null, Map.of());
    }

    @Test
    void 展開すると1フレーム1インスタンスになる() throws IOException, Exception {
        int nx = 4;
        int ny = 3;
        int nz = 2;
        int nt = 5;
        byte[] bytes = nifti1(nx, ny, nz, nt, NiftiHeader.DT_INT16, 16,
                new double[] { 1, 2.0, 2.0, 5.0, 0.04, 0, 0, 0 },
                new double[] { 2, 0, 0, 10 }, new double[] { 0, 2, 0, 20 }, new double[] { 0, 0, 5, 30 }, 1,
                int16Data(nx * ny * nz * nt, 0));
        Path f = Files.createTempFile("t", ".nii");
        Files.write(f, bytes);

        List<Attributes> frames = convert(f, opts());
        assertThat(frames).hasSize(nz * nt);
        assertThat(frames.get(0).getInt(Tag.Rows, 0)).isEqualTo(ny);
        assertThat(frames.get(0).getInt(Tag.Columns, 0)).isEqualTo(nx);
        // 時相は TemporalPositionIndex と TriggerTime に入る（本体の ZCT 判定がこれを見る）
        assertThat(frames.get(0).getInt(Tag.TemporalPositionIndex, -1)).isEqualTo(1);
        assertThat(frames.get(nz).getInt(Tag.TemporalPositionIndex, -1)).isEqualTo(2);
        assertThat(frames.get(0).getInt(Tag.NumberOfTemporalPositions, -1)).isEqualTo(nt);
        // pixdim[4]=0.04 秒 → 1 時相あたり 40 ms（pixdim は float なので誤差を許容）
        assertThat(frames.get(nz).getDouble(Tag.TriggerTime, -1))
                .isCloseTo(40.0, org.assertj.core.data.Offset.offset(0.001));
        // InstanceNumber は通し番号
        assertThat(frames.get(0).getInt(Tag.InstanceNumber, -1)).isEqualTo(1);
        assertThat(frames.get(frames.size() - 1).getInt(Tag.InstanceNumber, -1)).isEqualTo(nz * nt);
    }

    @Test
    void sform_から_IOP_と_IPP_を作る_RAS_から_LPS_へ反転する() throws IOException, Exception {
        // 単純な軸位断（RAS）: x=+2mm/voxel, y=+2mm/voxel, z=+5mm/slice、原点 (10,20,30)
        byte[] bytes = nifti1(4, 4, 3, 1, NiftiHeader.DT_INT16, 16,
                new double[] { 1, 2, 2, 5, 0, 0, 0, 0 },
                new double[] { 2, 0, 0, 10 }, new double[] { 0, 2, 0, 20 }, new double[] { 0, 0, 5, 30 }, 1,
                int16Data(4 * 4 * 3, 0));
        Path f = Files.createTempFile("t", ".nii");
        Files.write(f, bytes);
        List<Attributes> frames = convert(f, opts());

        double[] iop = frames.get(0).getDoubles(Tag.ImageOrientationPatient);
        // RAS→LPS で x/y が反転するので、行方向は (-1,0,0)、列方向は (0,-1,0)
        assertThat(iop).containsExactly(-1.0, 0.0, 0.0, 0.0, -1.0, 0.0);
        double[] ipp0 = frames.get(0).getDoubles(Tag.ImagePositionPatient);
        assertThat(ipp0).containsExactly(-10.0, -20.0, 30.0);
        // スライスが進むと z が 5mm ずつ動く
        assertThat(frames.get(1).getDoubles(Tag.ImagePositionPatient)[2]).isEqualTo(35.0);
        assertThat(frames.get(0).getDouble(Tag.SpacingBetweenSlices, 0)).isEqualTo(5.0);
        // 面内間隔は [行方向, 列方向] の順
        assertThat(frames.get(0).getDoubles(Tag.PixelSpacing)).containsExactly(2.0, 2.0);
    }

    @Test
    void 幾何が無いファイルは合成したことを画像に残す() throws IOException, Exception {
        byte[] bytes = nifti1(4, 4, 2, 1, NiftiHeader.DT_INT16, 16,
                new double[] { 1, 1.5, 1.5, 8, 0, 0, 0, 0 }, null, null, null, 0,
                int16Data(4 * 4 * 2, 0));
        Path f = Files.createTempFile("t", ".nii");
        Files.write(f, bytes);
        List<Attributes> frames = convert(f, opts());

        assertThat(frames.get(0).getString(Tag.ImageComments)).contains("synthesized");
        assertThat(frames.get(0).getString(Tag.DerivationDescription)).contains("pixdim");
        // 合成でも面内間隔は正しい（mm を捏造しているのは向きだけ）
        assertThat(frames.get(0).getDoubles(Tag.PixelSpacing)).containsExactly(1.5, 1.5);
        assertThat(frames.get(0).getDouble(Tag.SpacingBetweenSlices, 0)).isEqualTo(8.0);
    }

    @Test
    void 左手系は列方向を反転して右手系に直す() throws IOException, Exception {
        // y 方向を負にすると LPS 変換後に左手系になる
        byte[] bytes = nifti1(2, 2, 1, 1, NiftiHeader.DT_INT16, 16,
                new double[] { 1, 1, 1, 1, 0, 0, 0, 0 },
                new double[] { 1, 0, 0, 0 }, new double[] { 0, -1, 0, 0 }, new double[] { 0, 0, 1, 0 }, 1,
                new byte[] { 1, 0, 2, 0, 3, 0, 4, 0 }); // [1,2 / 3,4]
        Path f = Files.createTempFile("t", ".nii");
        Files.write(f, bytes);
        List<Attributes> frames = convert(f, opts());

        // 反転により行が入れ替わる（[3,4] が先に来る）
        byte[] px = frames.get(0).getBytes(Tag.PixelData);
        short[] shorts = new short[4];
        ByteBuffer.wrap(px).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts);
        assertThat(shorts).containsExactly((short) 3, (short) 4, (short) 1, (short) 2);
    }

    @Test
    void float32_は_16bit_へ量子化し_Rescale_で戻せる() throws IOException, Exception {
        int voxels = 4 * 4 * 2;
        ByteBuffer d = ByteBuffer.allocate(voxels * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < voxels; i++) {
            d.putFloat(i * 0.5f); // 0.0 〜 15.5
        }
        byte[] bytes = nifti1(4, 4, 2, 1, NiftiHeader.DT_FLOAT32, 32,
                new double[] { 1, 1, 1, 1, 0, 0, 0, 0 },
                new double[] { 1, 0, 0, 0 }, new double[] { 0, 1, 0, 0 }, new double[] { 0, 0, 1, 0 }, 1,
                d.array());
        Path f = Files.createTempFile("t", ".nii");
        Files.write(f, bytes);
        List<Attributes> frames = convert(f, opts());

        Attributes first = frames.get(0);
        assertThat(first.getInt(Tag.BitsAllocated, 0)).isEqualTo(16);
        double slope = first.getDouble(Tag.RescaleSlope, 0);
        double intercept = first.getDouble(Tag.RescaleIntercept, Double.NaN);
        assertThat(intercept).isEqualTo(0.0); // 最小値
        // **係数はボリューム全体で 1 つ**（スライスごとに変わらない）
        assertThat(frames.get(1).getDouble(Tag.RescaleSlope, -1)).isEqualTo(slope);
        // 復元して元の値に戻る（量子化誤差の範囲で）
        byte[] px = first.getBytes(Tag.PixelData);
        short[] shorts = new short[16];
        ByteBuffer.wrap(px).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts);
        assertThat(shorts[3] * slope + intercept).isCloseTo(1.5, org.assertj.core.data.Offset.offset(0.001));
    }

    @Test
    void gzip_でも読める() throws IOException, Exception {
        byte[] bytes = nifti1(2, 2, 1, 1, NiftiHeader.DT_INT16, 16,
                new double[] { 1, 1, 1, 1, 0, 0, 0, 0 },
                new double[] { 1, 0, 0, 0 }, new double[] { 0, 1, 0, 0 }, new double[] { 0, 0, 1, 0 }, 1,
                int16Data(4, 7));
        Path f = Files.createTempFile("t", ".nii.gz");
        try (ByteArrayOutputStream bos = new ByteArrayOutputStream();
                GZIPOutputStream gz = new GZIPOutputStream(bos)) {
            gz.write(bytes);
            gz.finish();
            Files.write(f, bos.toByteArray());
        }
        assertThat(convert(f, opts())).hasSize(1);
    }

    @Test
    void 未対応のデータ型は理由を添えて失敗する() throws IOException {
        byte[] bytes = nifti1(2, 2, 1, 1, 1536 /* float128 */, 128,
                new double[] { 1, 1, 1, 1, 0, 0, 0, 0 },
                new double[] { 1, 0, 0, 0 }, new double[] { 0, 1, 0, 0 }, new double[] { 0, 0, 1, 0 }, 1,
                new byte[64]);
        Path f = Files.createTempFile("t", ".nii");
        Files.write(f, bytes);
        assertThatThrownBy(() -> convert(f, opts()))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("datatype=1536");
    }

    @Test
    void NIfTI_でないファイルは弾く(@TempDir Path dir) throws IOException {
        Path f = dir.resolve("x.nii");
        Files.write(f, new byte[400]);
        assertThatThrownBy(() -> NiftiToDicom.readHeader(f))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("NIfTI ではありません");
    }

    @Test
    void モダリティに応じた_SOP_クラスを選ぶ() {
        assertThat(NiftiToDicom.sopClassOf("CT")).isEqualTo(UID.CTImageStorage);
        assertThat(NiftiToDicom.sopClassOf("PT")).isEqualTo(UID.PositronEmissionTomographyImageStorage);
        assertThat(NiftiToDicom.sopClassOf(null)).isEqualTo(UID.MRImageStorage);
        assertThat(NiftiToDicom.sopClassOf("なにか")).isEqualTo(UID.MRImageStorage);
    }
}

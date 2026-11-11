/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.vis.graphynext.nifti.FloatNiftiFixture;
import com.vis.graphynext.nifti.NiftiGeometry;
import com.vis.graphynext.nifti.NiftiHeader;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.zip.GZIPInputStream;

import static com.vis.graphynext.compute.DatasetFixture.PHI_ID;
import static com.vis.graphynext.compute.DatasetFixture.PHI_NAME;
import static com.vis.graphynext.compute.DatasetFixture.STUDY;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * NIfTI-1 の書き出し（{@link NiftiWriter}）。正解は**書き手の式を写さず**、テストに手で書いた RAS 行列と、
 * 仕様のバイト位置からの読み直しで作る。向きの取り違え（過去に矢状断が上下反転した）を 4 向きで押さえる。
 */
class NiftiWriterTest {

    private static final String SERIES = "1.2.3.100.30";
    private static final int NX = 32, NY = 24, NZ = 16;          // 列 × 行 × 枚数（非正方）
    private static final double DC = 0.8, DR = 0.6, DS = 2.5;    // 列間隔 = PixelSpacing[1]、行間隔 = PixelSpacing[0]、スライス間隔
    private static final double[] P0 = {-10, 20, 30};            // 先頭スライスの IPP（LPS）

    @TempDir
    Path dir;

    /** 向き 1 つ（IOP と、手で書いた RAS の列ベクトル）。 */
    private record Orient(String name, double[] iop, double[][] rasCols) {
    }

    private static final double C20 = Math.cos(Math.toRadians(20)), S20 = Math.sin(Math.toRadians(20));

    /**
     * 手で書いた期待値。RAS の srow は {@code [列 i | 列 j | 列 k | 原点]} を行ごとに並べたもの。
     * LPS → RAS は x・y の符号反転。k（段差）は IOP から作る法線 = r × c の向き。
     */
    private static List<Orient> orients() {
        // 軸位: r=(1,0,0) c=(0,1,0) n=(0,0,1)
        Orient ax = new Orient("axial", new double[]{1, 0, 0, 0, 1, 0},
                new double[][]{{-DC, 0, 0}, {0, -DR, 0}, {0, 0, DS}});
        // 冠状: r=(1,0,0) c=(0,0,-1) n=(0,1,0)
        Orient co = new Orient("coronal", new double[]{1, 0, 0, 0, 0, -1},
                new double[][]{{-DC, 0, 0}, {0, 0, -DR}, {0, -DS, 0}});
        // 矢状: r=(0,1,0) c=(0,0,-1) n=(-1,0,0)  → RAS: i→(0,-DC,0) j→(0,0,-DR) k→(+DS,0,0)
        Orient sa = new Orient("sagittal", new double[]{0, 1, 0, 0, 0, -1},
                new double[][]{{0, -DC, 0}, {0, 0, -DR}, {DS, 0, 0}});
        // 斜位: 軸位を x 軸まわりに 20°、続けて z 軸まわりに 20° 回す（回転行列を手で掛ける）。
        // r = Rz·Rx·(1,0,0), c = Rz·Rx·(0,1,0), n = Rz·Rx·(0,0,1)
        double[] r = {C20, S20, 0};
        double[] c = {-S20 * C20, C20 * C20, S20};
        double[] n = {S20 * S20, -C20 * S20, C20};
        Orient ob = new Orient("oblique", new double[]{r[0], r[1], r[2], c[0], c[1], c[2]},
                new double[][]{
                        {-DC * r[0], -DC * r[1], DC * r[2]},
                        {-DR * c[0], -DR * c[1], DR * c[2]},
                        {-DS * n[0], -DS * n[1], DS * n[2]}});
        return List.of(ax, co, sa, ob);
    }

    private static double[] cross(double[] a, double[] b) {
        return new double[]{a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
    }

    /** 印の格納値。自然な画素値（最大 (NZ*NY)*NX = 12288 未満）と重ならない値にする（重なると印の数が合わなくなる）。 */
    private static final int MARK = 30000;

    /** 画素値 = (k*NY + j)*NX + i（格納値）。{@code marks} の添字には {@link #MARK} を置く。 */
    private static int stored(int i, int j, int k, List<int[]> marks) {
        for (int[] m : marks) {
            if (m[0] == i && m[1] == j && m[2] == k) {
                return MARK;
            }
        }
        return (k * NY + j) * NX + i;
    }

    private record Spec(double[] iop, double[] step, boolean reverse, int skip, boolean sheared, int bits, boolean signed,
                        double slope, double intercept, int samples, int count, List<int[]> marks, Double thickness) {
        static Spec basic(double[] iop) {
            return new Spec(iop, null, true, -1, false, 16, true, 1.0, -1024.0, 1, NZ, List.of(), null);
        }
    }

    /** 合成 CT（または PET 相当）を保管庫の形で書く。{@code reverse} で InstanceNumber を位置の逆順にする。 */
    private DatasetFixture series(Spec sp, String modality) throws IOException {
        DatasetFixture fx = new DatasetFixture(dir);
        double[] r = {sp.iop()[0], sp.iop()[1], sp.iop()[2]};
        double[] c = {sp.iop()[3], sp.iop()[4], sp.iop()[5]};
        double[] n = cross(r, c);
        List<Integer> ks = new ArrayList<>();
        for (int k = 0; k < sp.count(); k++) {
            if (k != sp.skip()) {
                ks.add(k);
            }
        }
        if (sp.reverse()) {
            Collections.reverse(ks);
        }
        int inst = 0;
        for (int k : ks) {
            inst++;
            String sop = SERIES + "." + inst;
            Attributes ds = new Attributes();
            ds.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
            ds.setString(Tag.SOPInstanceUID, VR.UI, sop);
            ds.setString(Tag.StudyInstanceUID, VR.UI, STUDY);
            ds.setString(Tag.SeriesInstanceUID, VR.UI, SERIES);
            ds.setString(Tag.PatientName, VR.PN, PHI_NAME);
            ds.setString(Tag.PatientID, VR.LO, PHI_ID);
            ds.setString(Tag.Modality, VR.CS, modality);
            ds.setInt(Tag.InstanceNumber, VR.IS, inst);
            double[] step = sp.step() != null ? sp.step() : new double[]{n[0] * DS, n[1] * DS, n[2] * DS};
            double[] shear = sp.sheared() ? new double[]{r[0] * 1.0, r[1] * 1.0, r[2] * 1.0} : new double[]{0, 0, 0};
            ds.setDouble(Tag.ImagePositionPatient, VR.DS, P0[0] + k * (step[0] + shear[0]), P0[1] + k * (step[1] + shear[1]),
                    P0[2] + k * (step[2] + shear[2]));
            ds.setDouble(Tag.ImageOrientationPatient, VR.DS, sp.iop()[0], sp.iop()[1], sp.iop()[2], sp.iop()[3], sp.iop()[4], sp.iop()[5]);
            ds.setDouble(Tag.PixelSpacing, VR.DS, DR, DC);
            if (sp.thickness() != null) {
                ds.setDouble(Tag.SliceThickness, VR.DS, sp.thickness());
            }
            ds.setDouble(Tag.RescaleSlope, VR.DS, sp.slope());
            ds.setDouble(Tag.RescaleIntercept, VR.DS, sp.intercept());
            ds.setString(Tag.PhotometricInterpretation, VR.CS, sp.samples() == 3 ? "RGB" : "MONOCHROME2");
            ds.setInt(Tag.SamplesPerPixel, VR.US, sp.samples());
            ds.setInt(Tag.Rows, VR.US, NY);
            ds.setInt(Tag.Columns, VR.US, NX);
            ds.setInt(Tag.BitsAllocated, VR.US, sp.bits());
            ds.setInt(Tag.BitsStored, VR.US, sp.bits());
            ds.setInt(Tag.HighBit, VR.US, sp.bits() - 1);
            ds.setInt(Tag.PixelRepresentation, VR.US, sp.signed() ? 1 : 0);
            ds.setString(Tag.RescaleType, VR.LO, "HU");
            ds.setDouble(Tag.WindowCenter, VR.DS, 40);
            ds.setDouble(Tag.WindowWidth, VR.DS, 400);
            ByteBuffer px = ByteBuffer.allocate(NX * NY * 2 * sp.samples()).order(ByteOrder.LITTLE_ENDIAN);
            for (int j = 0; j < NY; j++) {
                for (int i = 0; i < NX; i++) {
                    for (int s = 0; s < sp.samples(); s++) {
                        px.putShort((short) stored(i, j, k, sp.marks()));
                    }
                }
            }
            ds.setBytes(Tag.PixelData, VR.OW, px.array());
            Path f = dir.resolve("s" + inst + ".dcm");
            try (DicomOutputStream out = new DicomOutputStream(f.toFile())) {
                out.writeDataset(ds.createFileMetaInformation(UID.ExplicitVRLittleEndian), ds);
            }
            fx.index(SERIES, sop, f, modality, UID.CTImageStorage);
        }
        return fx;
    }

    private static byte[] gunzip(Path f) throws IOException {
        try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(Files.readAllBytes(f)))) {
            return in.readAllBytes();
        }
    }

    private ComputeDatasetService.Dataset write(DatasetFixture fx) {
        return fx.service().create(STUDY, SERIES, ComputeDatasetService.Format.NIFTI, true);
    }

    private static ByteBuffer le(byte[] nii) {
        return ByteBuffer.wrap(nii).order(ByteOrder.LITTLE_ENDIAN);
    }

    private static void assertHeader(byte[] nii) {
        ByteBuffer b = le(nii);
        assertEquals(348, b.getInt(0), "sizeof_hdr");
        assertEquals(3, b.getShort(40), "dim[0]");
        assertEquals(NX, b.getShort(42));
        assertEquals(NY, b.getShort(44));
        assertEquals(NZ, b.getShort(46));
        assertEquals(1, b.getShort(48));
        assertEquals(16, b.getShort(70), "datatype FLOAT32");
        assertEquals(32, b.getShort(72), "bitpix");
        assertEquals(+1f, b.getFloat(76), 0f, "pixdim[0] = qfac");
        assertEquals(DC, b.getFloat(80), 1e-6);
        assertEquals(DR, b.getFloat(84), 1e-6);
        assertEquals(DS, b.getFloat(88), 1e-6);
        assertEquals(352f, b.getFloat(108), 0f, "vox_offset");
        assertEquals(1f, b.getFloat(112), 0f, "scl_slope");
        assertEquals(0f, b.getFloat(116), 0f, "scl_inter");
        assertEquals(2, b.get(123), "xyzt_units = mm");
        assertEquals(1, b.getShort(252), "qform_code");
        assertEquals(1, b.getShort(254), "sform_code");
        assertEquals('n', b.get(344));
        assertEquals('+', b.get(345));
        assertEquals('1', b.get(346));
        assertEquals(0, b.get(347));
        assertEquals(352 + NX * NY * NZ * 4, nii.length, "ヘッダ 352 バイト + float32 の画素");
    }

    private static double[][] srows(byte[] nii) {
        ByteBuffer b = le(nii);
        double[][] s = new double[3][4];
        for (int row = 0; row < 3; row++) {
            for (int col = 0; col < 4; col++) {
                s[row][col] = b.getFloat(280 + row * 16 + col * 4);
            }
        }
        return s;
    }

    private static float voxel(byte[] nii, int i, int j, int k) {
        return le(nii).getFloat(352 + 4 * ((k * NY + j) * NX + i));
    }

    // ── 901-1: 幾何の数値（手で書いた RAS 行列） ─────────────────────────────

    @Test
    void srowMatchesTheHandWrittenRasMatrixInFourOrientationsWithReversedStorage() throws Exception {
        for (Orient o : orients()) {
            DatasetFixture fx = series(Spec.basic(o.iop()), "CT");
            byte[] nii = gunzip(write(fx).file());
            assertHeader(nii);
            double[][] s = srows(nii);
            double[] origin = {-P0[0], -P0[1], P0[2]}; // IPP の x・y の符号を反転
            for (int row = 0; row < 3; row++) {
                for (int col = 0; col < 3; col++) {
                    assertEquals(o.rasCols()[col][row], s[row][col], 1e-4, o.name() + " srow[" + row + "][" + col + "]");
                }
                assertEquals(origin[row], s[row][3], 1e-4, o.name() + " 原点 " + row);
            }
            // qform: 回転部（srow の各列を間隔で割ったもの）と、quaternion から作り直した回転が一致する（別の式）
            ByteBuffer b = le(nii);
            double qb = b.getFloat(256), qc = b.getFloat(260), qd = b.getFloat(264);
            double qa = Math.sqrt(Math.max(0, 1 - qb * qb - qc * qc - qd * qd));
            double[][] rot = {
                    {qa * qa + qb * qb - qc * qc - qd * qd, 2 * (qb * qc - qa * qd), 2 * (qb * qd + qa * qc)},
                    {2 * (qb * qc + qa * qd), qa * qa + qc * qc - qb * qb - qd * qd, 2 * (qc * qd - qa * qb)},
                    {2 * (qb * qd - qa * qc), 2 * (qc * qd + qa * qb), qa * qa + qd * qd - qc * qc - qb * qb}};
            double[] sp = {DC, DR, DS};
            for (int row = 0; row < 3; row++) {
                for (int col = 0; col < 3; col++) {
                    // quaternion は float で持つので、回転角が 180° に近い（a ≈ 0。冠状）と a の復元が √ で増幅される（実測 3e-4）。
                    // 軸の取り違えなら誤差は 1 になるので、1e-3 で見分けられる。
                    assertEquals(s[row][col] / sp[col], rot[row][col], 1e-3, o.name() + " qform 回転 " + row + "," + col);
                }
            }
            assertEquals(origin[0], b.getFloat(268), 1e-4);
            assertEquals(origin[1], b.getFloat(272), 1e-4);
            assertEquals(origin[2], b.getFloat(276), 1e-4);
        }
    }

    @Test
    void sagittalSeriesStartsAtThePatientsLeftAndGrowsToTheRight() throws Exception {
        // IOP 0,1,0,0,0,-1: 法線は LPS で (-1,0,0)。先頭は法線方向で最小 = 患者の左端、k が増えると患者の右（RAS の +x）へ進む
        Orient sa = orients().get(2);
        byte[] nii = gunzip(write(series(Spec.basic(sa.iop()), "CT")).file());
        double[][] s = srows(nii);
        assertEquals(+DS, s[0][2], 1e-4, "k が増えると RAS の +x（患者の右）");
        assertEquals(10.0, s[0][3], 1e-4, "原点の x = -(IPP の x)");
    }

    // ── 901-2: 向きの印（LPS で既知の 3 点） ───────────────────────────────

    @Test
    void markersLandAtTheirKnownLpsPositionsAfterTheRasFlip() throws Exception {
        List<int[]> marks = List.of(new int[]{0, 0, 0}, new int[]{NX - 1, NY - 1, NZ - 1}, new int[]{NX / 2, NY / 2, NZ / 2});
        for (Orient o : orients()) {
            Spec sp = new Spec(o.iop(), null, true, -1, false, 16, true, 1.0, -1024.0, 1, NZ, marks, null);
            byte[] nii = gunzip(write(series(sp, "CT")).file());
            double[] r = {o.iop()[0], o.iop()[1], o.iop()[2]};
            double[] c = {o.iop()[3], o.iop()[4], o.iop()[5]};
            double[] n = cross(r, c);
            double[][] s = srows(nii);
            int found = 0;
            for (int k = 0; k < NZ; k++) {
                for (int j = 0; j < NY; j++) {
                    for (int i = 0; i < NX; i++) {
                        if (voxel(nii, i, j, k) != (float) (MARK - 1024.0)) {
                            continue;
                        }
                        found++;
                        double[] ras = new double[3];
                        for (int a = 0; a < 3; a++) {
                            ras[a] = s[a][0] * i + s[a][1] * j + s[a][2] * k + s[a][3];
                        }
                        // 同じ印の LPS（DICOM の式で別に作る）→ RAS は (-x, -y, z)
                        double[] lps = new double[3];
                        for (int a = 0; a < 3; a++) {
                            lps[a] = P0[a] + i * DC * r[a] + j * DR * c[a] + k * DS * n[a];
                        }
                        assertEquals(-lps[0], ras[0], 0.01, o.name() + " x");
                        assertEquals(-lps[1], ras[1], 0.01, o.name() + " y");
                        assertEquals(lps[2], ras[2], 0.01, o.name() + " z");
                    }
                }
            }
            assertEquals(3, found, o.name() + ": 印は 3 つ（書き手が値の並びを入れ替えていない）");
        }
    }

    // ── 901-3: 値 ─────────────────────────────────────────────────────

    @Test
    void ctValuesAreHuAsFloat32AndPetLikeValuesApplyTheSlope() throws Exception {
        byte[] ct = gunzip(write(series(Spec.basic(orients().get(0).iop()), "CT")).file());
        for (int k = 0; k < NZ; k += 5) {
            for (int j = 0; j < NY; j += 7) {
                for (int i = 0; i < NX; i += 9) {
                    assertEquals(Float.floatToIntBits((float) (stored(i, j, k, List.of()) * 1.0 + (-1024.0))),
                            Float.floatToIntBits(voxel(ct, i, j, k)), "CT HU i=" + i + " j=" + j + " k=" + k);
                }
            }
        }
        assertEquals("HU", cstr(ct, 328, 16), "intent_name に単位");
        assertEquals(240f, le(ct).getFloat(124), 0f, "cal_max = 窓の上端");
        assertEquals(-160f, le(ct).getFloat(128), 0f, "cal_min = 窓の下端");
        Spec pet = new Spec(orients().get(0).iop(), null, true, -1, false, 16, false, 0.0123, 0.0, 1, NZ, List.of(), null);
        byte[] pt = gunzip(write(series(pet, "PT")).file());
        for (int k = 0; k < NZ; k += 5) {
            for (int j = 0; j < NY; j += 7) {
                for (int i = 0; i < NX; i += 9) {
                    assertEquals(Float.floatToIntBits((float) (stored(i, j, k, List.of()) * 0.0123)),
                            Float.floatToIntBits(voxel(pt, i, j, k)), "PET i=" + i + " j=" + j + " k=" + k);
                }
            }
        }
    }

    private static String cstr(byte[] b, int off, int max) {
        int e = off;
        while (e < off + max && b[e] != 0) {
            e++;
        }
        return new String(b, off, e - off, java.nio.charset.StandardCharsets.US_ASCII);
    }

    @Test
    void parametricMapKeepsFloatValuesNaNAndTheUnit() throws Exception {
        DatasetFixture fx = new DatasetFixture(dir);
        int px = 4, py = 3, pz = 3;
        Path nii = FloatNiftiFixture.write(dir.resolve("adc.nii"), px, py, pz, 0.9, 1.1, 2.5,
                (i, j, k) -> i == 1 && j == 2 && k == 1 ? Float.NaN : (float) (0.0005 + 0.0001 * ((k * py + j) * px + i)));
        int n = 0;
        String pm = "1.2.3.100.9";
        for (Attributes ds : FloatNiftiFixture.toParametricMap(nii, PHI_ID, PHI_NAME, STUDY, pm, "mm2/s")) {
            Path f = dir.resolve("pm" + (n++) + ".dcm");
            try (DicomOutputStream out = new DicomOutputStream(f.toFile())) {
                out.writeDataset(ds.createFileMetaInformation(UID.ExplicitVRLittleEndian), ds);
            }
            fx.index(pm, ds.getString(Tag.SOPInstanceUID), f, "MR", UID.ParametricMapStorage);
        }
        byte[] out = gunzip(fx.service().create(STUDY, pm, ComputeDatasetService.Format.NIFTI, true).file());
        ByteBuffer b = le(out);
        assertEquals(px, b.getShort(42));
        assertEquals(py, b.getShort(44));
        assertEquals(pz, b.getShort(46));
        assertEquals("mm2/s", cstr(out, 328, 16));
        int nan = 0;
        for (int k = 0; k < pz; k++) {
            for (int j = 0; j < py; j++) {
                for (int i = 0; i < px; i++) {
                    float got = b.getFloat(352 + 4 * ((k * py + j) * px + i));
                    // 取り込み（RAS の NIfTI → LPS の DICOM）と書き出し（LPS → RAS）は逆の変換なので、同じ添字に同じ値が戻る
                    if (i == 1 && j == 2 && k == 1) {
                        assertTrue(Float.isNaN(got), "NaN のまま");
                        nan++;
                    } else {
                        assertEquals((float) (0.0005 + 0.0001 * ((k * py + j) * px + i)), got, 0f, "i=" + i + " j=" + j + " k=" + k);
                    }
                }
            }
        }
        assertEquals(1, nan);
    }

    // ── 901-4: 断る（ファイルを作る前に）と、同じ形の正例 ──────────────────────

    @Test
    void refusesWhatCannotBeAGrid_andThePositiveTwinOfEachPasses() throws Exception {
        double[] axial = orients().get(0).iop();
        assertEquals(NZ, write(series(Spec.basic(axial), "CT")).instances(), "（正例）まっすぐな格子は通る");

        // 欠けたスライス
        Spec gap = new Spec(axial, null, true, 7, false, 16, true, 1.0, -1024.0, 1, NZ, List.of(), null);
        assertEquals("npz-uneven-spacing", reason(series(gap, "CT")));
        // 同じ位置に 2 枚: 段差ベクトルをゼロに近い値にして位置を重ねる
        Spec dup = new Spec(axial, new double[]{0, 0, 0}, true, -1, false, 16, true, 1.0, -1024.0, 1, NZ, List.of(), null);
        assertEquals("npz-duplicate-positions", reason(series(dup, "CT")));
        // ガントリーチルト: スライスの位置が法線方向以外（行方向）にもずれる
        Spec tilt = new Spec(axial, null, true, -1, true, 16, true, 1.0, -1024.0, 1, NZ, List.of(), null);
        assertEquals("volume-sheared", reason(series(tilt, "CT")));
        // RGB
        Spec rgb = new Spec(axial, null, true, -1, false, 16, false, 1.0, 0.0, 3, NZ, List.of(), null);
        assertEquals("npz-not-grayscale", reason(series(rgb, "CT")));
    }

    private String reason(DatasetFixture fx) {
        return assertThrows(ComputeDatasetService.DatasetRefused.class, () -> write(fx)).reason();
    }

    @Test
    void aSingleSliceTakesItsStepFromSpacingBetweenSlicesThenSliceThickness() throws Exception {
        double[] axial = orients().get(0).iop();
        Spec one = new Spec(axial, null, false, -1, false, 16, true, 1.0, -1024.0, 1, 1, List.of(), 3.0);
        byte[] nii = gunzip(write(series(one, "CT")).file());
        assertEquals(3.0f, le(nii).getFloat(88), 1e-6, "pixdim[3] = SliceThickness");
        assertEquals(3.0, srows(nii)[2][2], 1e-4);
    }

    // ── 回帰: 取り込み側の幾何（本体の読み込み）に戻しても IOP・IPP が一致する ────

    @Test
    void roundTripsThroughTheImportersGeometry() throws Exception {
        for (Orient o : orients()) {
            byte[] nii = gunzip(write(series(Spec.basic(o.iop()), "CT")).file());
            NiftiHeader h = NiftiHeader.parse(java.util.Arrays.copyOf(nii, 348));
            NiftiGeometry g = NiftiGeometry.of(h);
            double[] r = {o.iop()[0], o.iop()[1], o.iop()[2]};
            double[] c = {o.iop()[3], o.iop()[4], o.iop()[5]};
            double[] n = cross(r, c);
            // 取り込みは行を反転しうる（左手系のとき）。ここは右手系なので反転しない
            assertFalse(g.flipRows, o.name());
            assertArrayEquals(o.iop(), g.iop, 1e-5, o.name() + " IOP");
            assertArrayEquals(P0, g.origin, 1e-4, o.name() + " 先頭の IPP");
            for (int a = 0; a < 3; a++) {
                assertEquals(DS * n[a], g.sliceStep[a], 1e-4, o.name() + " 段差 " + a);
            }
        }
    }

    @Test
    void writesNothingThatIdentifiesThePatient() throws Exception {
        byte[] gz = Files.readAllBytes(write(series(Spec.basic(orients().get(0).iop()), "CT")).file());
        String all = new String(gunzip2(gz), java.nio.charset.StandardCharsets.ISO_8859_1);
        for (String phi : List.of(PHI_NAME, PHI_ID, SERIES, STUDY)) {
            assertFalse(all.contains(phi), phi);
        }
        assertEquals("GRAPHY-Next export", cstr(gunzip2(gz), 148, 80));
    }

    @Test
    void niftiIsNotAnEgressFormat() {
        assertTrue(ComputeDatasetService.Format.of("nifti").isPresent(), "書き出しでは使える");
        assertFalse(ComputeDatasetService.Format.forEgress("nifti").isPresent(), "計算機への送信では開けない");
        assertTrue(ComputeDatasetService.Format.forEgress("npz").isPresent(), "（対）npz は送れる");
        assertTrue(ComputeDatasetService.Format.forEgress("dicom-zip").isPresent());
    }

    @Test
    void theExportEndpointStreamsAGzipOnSuccessAndRefusesBeforeStreamingOtherwise() throws Exception {
        DatasetFixture ok = series(Spec.basic(orients().get(0).iop()), "CT");
        var ctl = new com.vis.graphynext.nifti.NiftiExportController(ok.service());
        var res = ctl.export(new com.vis.graphynext.nifti.NiftiExportController.ExportRequest(STUDY, SERIES));
        assertEquals(200, res.getStatusCode().value());
        assertEquals("application/gzip", res.getHeaders().getContentType().toString());
        assertEquals("16", res.getHeaders().getFirst("X-Graphy-Slices"));
        assertEquals("attachment; filename=\"CT_volume.nii.gz\"", res.getHeaders().getFirst("Content-Disposition"));
        var sink = new java.io.ByteArrayOutputStream();
        ((org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody) res.getBody()).writeTo(sink);
        assertEquals(res.getHeaders().getContentLength(), sink.size(), "Content-Length どおりに流れる");
        assertHeader(gunzip2(sink.toByteArray()));
    }

    @Test
    void theExportEndpointRefusesBeforeStreamingAnythingForATiltedSeries() throws Exception {
        Spec tilt = new Spec(orients().get(0).iop(), null, true, -1, true, 16, true, 1.0, -1024.0, 1, NZ, List.of(), null);
        var ctl = new com.vis.graphynext.nifti.NiftiExportController(series(tilt, "CT").service());
        var ex = assertThrows(com.vis.graphynext.nifti.NiftiExportController.Refusal.class,
                () -> ctl.export(new com.vis.graphynext.nifti.NiftiExportController.ExportRequest(STUDY, SERIES)),
                "断るときは本体（ストリーム）を作らず例外にする");
        var refused = ctl.refused(ex);
        assertEquals(422, refused.getStatusCode().value());
        assertEquals("volume-sheared", refused.getBody().get("error"));
        assertEquals(400, ctl.refused(assertThrows(com.vis.graphynext.nifti.NiftiExportController.Refusal.class,
                () -> ctl.export(new com.vis.graphynext.nifti.NiftiExportController.ExportRequest(null, SERIES)))).getStatusCode().value());
    }

    private static byte[] gunzip2(byte[] gz) throws IOException {
        try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(gz))) {
            return in.readAllBytes();
        }
    }
}

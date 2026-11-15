/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

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
import java.util.function.BiConsumer;
import java.util.zip.GZIPInputStream;

import static com.vis.graphynext.compute.DatasetFixture.PHI_ID;
import static com.vis.graphynext.compute.DatasetFixture.PHI_NAME;
import static com.vis.graphynext.compute.DatasetFixture.STUDY;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * NIfTI-1 の 4D の時相の鍵（TemporalPosition → FrameReferenceTime → TriggerTime → AcquisitionTime）と、時間間隔の出どころ。
 * InstanceNumber だけでは 4D にしないこと（手がかりの無い 2 回分の撮影が黙って時相になるのを防ぐ）を押さえる。
 * 正解は書き手の式を写さず、テストが作る画素値（時相・位置・添字から決まる式）と、仕様のバイト位置からの読み直しで作る。
 */
class Nifti4dKeysTest {

    private static final String SERIES = "1.2.3.200.41";
    private static final int NX = 16, NY = 12, NZ = 8;
    private static final double DC = 0.8, DR = 0.6, DS = 2.5;
    private static final double[] P0 = {-10, 20, 30};
    /** 矢状（IOP 0,1,0,0,0,-1）。法線は LPS で (-1,0,0)。 */
    private static final double[] IOP = {0, 1, 0, 0, 0, -1};
    private static final double[] N = {-1, 0, 0};

    @TempDir
    Path dir;

    /** 時相の手がかり。{@code tpi}/{@code frt}/{@code trig} は null なら付けない。{@code (t, k) -> 値} の形で位置ごとにも変えられる。 */
    private record Keys(Integer[] tpi, double[] frt, double[] trig) {
        static Keys none() {
            return new Keys(null, null, null);
        }
    }

    private record Spec(int frames, Keys keys, int dropT, int dropK, BiConsumer<int[], Attributes> extra, double frtUpperOffset) {
        static Spec of(int frames, Keys keys) {
            return new Spec(frames, keys, -1, -1, null, 0);
        }

        Spec withFrtUpperOffset(double ms) {
            return new Spec(frames, keys, dropT, dropK, extra, ms);
        }
    }

    /** 格納値（t・位置 k・添字で決まる。16 bit に収まり、時相ごとに全部違う）。 */
    private static int stored(int t, int i, int j, int k) {
        return (t * 4001 + k * 331 + j * 17 + i) % 20000;
    }

    private static double[] cross(double[] a, double[] b) {
        return new double[]{a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
    }

    private DatasetFixture series(Spec sp) throws IOException {
        DatasetFixture fx = new DatasetFixture(dir);
        List<int[]> tk = new ArrayList<>();   // (t, k)
        for (int t = 0; t < sp.frames(); t++) {
            for (int k = 0; k < NZ; k++) {
                if (t == sp.dropT() && k == sp.dropK()) {
                    continue;
                }
                tk.add(new int[]{t, k});
            }
        }
        Collections.reverse(tk); // InstanceNumber は時相・位置の逆順（並べ替えを確かめる）
        int inst = 0;
        for (int[] e : tk) {
            int t = e[0], k = e[1];
            inst++;
            String sop = SERIES + "." + inst;
            Attributes ds = new Attributes();
            ds.setString(Tag.SOPClassUID, VR.UI, UID.PositronEmissionTomographyImageStorage);
            ds.setString(Tag.SOPInstanceUID, VR.UI, sop);
            ds.setString(Tag.StudyInstanceUID, VR.UI, STUDY);
            ds.setString(Tag.SeriesInstanceUID, VR.UI, SERIES);
            ds.setString(Tag.PatientName, VR.PN, PHI_NAME);
            ds.setString(Tag.PatientID, VR.LO, PHI_ID);
            ds.setString(Tag.Modality, VR.CS, "PT");
            ds.setInt(Tag.InstanceNumber, VR.IS, inst);
            ds.setDouble(Tag.ImagePositionPatient, VR.DS, P0[0] + k * DS * N[0], P0[1] + k * DS * N[1], P0[2] + k * DS * N[2]);
            ds.setDouble(Tag.ImageOrientationPatient, VR.DS, IOP[0], IOP[1], IOP[2], IOP[3], IOP[4], IOP[5]);
            ds.setDouble(Tag.PixelSpacing, VR.DS, DR, DC);
            ds.setDouble(Tag.RescaleSlope, VR.DS, 0.5);
            ds.setDouble(Tag.RescaleIntercept, VR.DS, -100.0);
            ds.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
            ds.setInt(Tag.SamplesPerPixel, VR.US, 1);
            ds.setInt(Tag.Rows, VR.US, NY);
            ds.setInt(Tag.Columns, VR.US, NX);
            ds.setInt(Tag.BitsAllocated, VR.US, 16);
            ds.setInt(Tag.BitsStored, VR.US, 16);
            ds.setInt(Tag.HighBit, VR.US, 15);
            ds.setInt(Tag.PixelRepresentation, VR.US, 0);
            ds.setString(Tag.RescaleType, VR.LO, "BQML");
            Keys kk = sp.keys();
            if (kk.tpi() != null) {
                ds.setInt(Tag.TemporalPositionIdentifier, VR.IS, kk.tpi()[t] + (sp.extra() != null && k >= NZ / 2 ? 100 : 0));
            }
            if (kk.frt() != null) {
                ds.setDouble(Tag.FrameReferenceTime, VR.DS, kk.frt()[t] + (k >= NZ / 2 ? sp.frtUpperOffset() : 0));
            }
            if (kk.trig() != null) {
                ds.setDouble(Tag.TriggerTime, VR.DS, kk.trig()[t]);
            }
            if (sp.extra() != null) {
                sp.extra().accept(e, ds);
            }
            ByteBuffer px = ByteBuffer.allocate(NX * NY * 2).order(ByteOrder.LITTLE_ENDIAN);
            for (int j = 0; j < NY; j++) {
                for (int i = 0; i < NX; i++) {
                    px.putShort((short) stored(t, i, j, k));
                }
            }
            ds.setBytes(Tag.PixelData, VR.OW, px.array());
            Path f = dir.resolve("s" + inst + ".dcm");
            try (DicomOutputStream out = new DicomOutputStream(f.toFile())) {
                out.writeDataset(ds.createFileMetaInformation(UID.ExplicitVRLittleEndian), ds);
            }
            fx.index(SERIES, sop, f, "PT", UID.PositronEmissionTomographyImageStorage);
        }
        return fx;
    }

    private static byte[] gunzip(Path f) throws IOException {
        try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(Files.readAllBytes(f)))) {
            return in.readAllBytes();
        }
    }

    private static ComputeDatasetService.Dataset write(DatasetFixture fx) {
        return fx.service().create(STUDY, SERIES, ComputeDatasetService.Format.NIFTI, true);
    }

    private static ByteBuffer le(byte[] nii) {
        return ByteBuffer.wrap(nii).order(ByteOrder.LITTLE_ENDIAN);
    }

    /** 4D のボクセル: x が最速、次に y、z、最後に t。 */
    private static float voxel(byte[] nii, int t, int i, int j, int k) {
        return le(nii).getFloat(352 + 4 * (((t * NZ + k) * NY + j) * NX + i));
    }

    private static void assertEveryVoxel(byte[] nii, int frames) {
        for (int t = 0; t < frames; t++) {
            for (int k = 0; k < NZ; k++) {
                for (int j = 0; j < NY; j++) {
                    for (int i = 0; i < NX; i++) {
                        // 期待値は別の式（格納値 × slope + intercept を float32 に）。位置 k は IPP の昇順（法線方向）＝ k の昇順
                        float want = (float) (stored(t, i, j, k) * 0.5 + (-100.0));
                        assertEquals(Float.floatToIntBits(want), Float.floatToIntBits(voxel(nii, t, i, j, k)),
                                "t=" + t + " k=" + k + " j=" + j + " i=" + i);
                    }
                }
            }
        }
    }

    private static ComputeDatasetService.DatasetRefused refusal(DatasetFixture fx) {
        return assertThrows(ComputeDatasetService.DatasetRefused.class, () -> write(fx));
    }

    // ── 4D の書き出し（正例） ───────────────────────────────────────────────

    @Test
    void frameReferenceTimeGivesFourDimensionsAndTheTimeStepInSeconds() throws Exception {
        Keys k = new Keys(null, new double[]{0, 5000, 10000}, null);
        ComputeDatasetService.Dataset d = write(series(Spec.of(3, k)));
        byte[] nii = gunzip(d.file());
        ByteBuffer b = le(nii);
        assertEquals(4, b.getShort(40), "dim[0]");
        assertEquals(NX, b.getShort(42));
        assertEquals(NY, b.getShort(44));
        assertEquals(NZ, b.getShort(46));
        assertEquals(3, b.getShort(48), "dim[4] = 時相数");
        assertEquals(5.0f, b.getFloat(92), 0f, "pixdim[4] = 5000 ms → 5 秒");
        assertEquals(2 | 8, b.get(123), "xyzt_units = mm | sec");
        assertEquals(352 + 4 * NX * NY * NZ * 3, nii.length);
        assertEveryVoxel(nii, 3);
    }

    @Test
    void geometryIsTheSameAsThe3DExportAndMarkersStayAtTheirPositionInEveryFrame() throws Exception {
        Keys k = new Keys(null, new double[]{1000, 3000}, null);
        byte[] nii = gunzip(write(series(Spec.of(2, k))).file());
        // 矢状（手で書いた RAS）: i→(0,-DC,0) j→(0,0,-DR) k→(+DS,0,0)、原点 = (-IPP.x, -IPP.y, IPP.z)
        ByteBuffer b = le(nii);
        double[][] want = {{0, 0, DS, 10.0}, {-DC, 0, 0, -20.0}, {0, -DR, 0, 30.0}};
        for (int row = 0; row < 3; row++) {
            for (int col = 0; col < 4; col++) {
                assertEquals(want[row][col], b.getFloat(280 + row * 16 + col * 4), 1e-4, "srow[" + row + "][" + col + "]");
            }
        }
        assertEquals(DC, b.getFloat(80), 1e-6);
        assertEquals(DR, b.getFloat(84), 1e-6);
        assertEquals(DS, b.getFloat(88), 1e-6);
        // 時相が違っても、同じ添字は同じ位置（同じ幾何）。値は時相ごとに違う（時相の取り違えを拾う）
        assertTrue(voxel(nii, 0, 3, 4, 5) != voxel(nii, 1, 3, 4, 5));
    }

    @Test
    void triggerTimeIsUsedWhenThereIsNoFrameReferenceTime() throws Exception {
        Keys k = new Keys(null, null, new double[]{0, 250, 500});
        ComputeDatasetService.Dataset d = write(series(Spec.of(3, k)));
        byte[] nii = gunzip(d.file());
        assertEquals(0.25f, le(nii).getFloat(92), 0f);
        assertEquals(2 | 8, le(nii).get(123));
        assertEveryVoxel(nii, 3);
    }

    @Test
    void temporalPositionIdentifierAloneOrdersTheFramesButTheTimeStepIsUnknown() throws Exception {
        // 時刻の手がかりが無いので、間隔は推測で埋めない（pixdim[4] = 0・mm だけ）
        Keys k = new Keys(new Integer[]{1, 2, 3}, null, null);
        ComputeDatasetService.Dataset d = write(series(Spec.of(3, k)));
        byte[] nii = gunzip(d.file());
        assertEquals(4, le(nii).getShort(40));
        assertEquals(0f, le(nii).getFloat(92), 0f, "pixdim[4]");
        assertEquals(2, le(nii).get(123), "xyzt_units = mm のみ");
        assertEveryVoxel(nii, 3);
    }

    @Test
    void unevenFrameTimesAreOrderedButTheTimeStepIsNotInvented() throws Exception {
        // 動態 PET の典型（フレーム長が段階的に伸びる）。NIfTI のヘッダは時相ごとの時刻を持てない
        Keys k = new Keys(null, new double[]{0, 5000, 12000, 25000}, null);
        ComputeDatasetService.Dataset d = write(series(Spec.of(4, k)));
        byte[] nii = gunzip(d.file());
        assertEquals(0f, le(nii).getFloat(92), 0f);
        assertEquals(2, le(nii).get(123));
        assertEveryVoxel(nii, 4);
    }

    @Test
    void temporalPositionIdentifierOrdersFramesEvenWhenInstanceNumbersAreReversed() throws Exception {
        // 時相 TPI = 3,1,2 の順に格納されたシリーズ: 並びは TPI の昇順（t=0 が TPI 1）
        Keys k = new Keys(new Integer[]{3, 1, 2}, null, null);
        byte[] nii = gunzip(write(series(Spec.of(3, k))).file());
        // stored(t, ...) の t は「作った順」。TPI 昇順に並べ替わるので、書き出しの t=0 は作った順 t=1 のもの
        int[] outToMade = {1, 2, 0};
        for (int t = 0; t < 3; t++) {
            float want = (float) (stored(outToMade[t], 5, 6, 3) * 0.5 - 100.0);
            assertEquals(Float.floatToIntBits(want), Float.floatToIntBits(voxel(nii, t, 5, 6, 3)), "t=" + t);
        }
    }

    @Test
    void temporalPositionOrdersTheFramesAndFrameReferenceTimeGivesTheStep() throws Exception {
        // 順序は TemporalPosition（3,1,2 で格納）、間隔は FrameReferenceTime から（TemporalPosition は時刻ではない）
        Keys k = new Keys(new Integer[]{3, 1, 2}, new double[]{10000, 0, 5000}, null);
        byte[] nii = gunzip(write(series(Spec.of(3, k))).file());
        assertEquals(5.0f, le(nii).getFloat(92), 0f, "pixdim[4]");
        assertEquals(2 | 8, le(nii).get(123));
        int[] outToMade = {1, 2, 0}; // TPI 昇順 = 作った順の 1, 2, 0
        for (int t = 0; t < 3; t++) {
            float want = (float) (stored(outToMade[t], 5, 6, 3) * 0.5 - 100.0);
            assertEquals(Float.floatToIntBits(want), Float.floatToIntBits(voxel(nii, t, 5, 6, 3)), "t=" + t);
        }
    }

    @Test
    void frameReferenceTimeComesBeforeTriggerTimeAsTheKeyAndTheSource() throws Exception {
        // FrameReferenceTime は増え、TriggerTime は減る。鍵・間隔とも FrameReferenceTime（優先順）
        Keys k = new Keys(null, new double[]{0, 5000, 10000}, new double[]{500, 250, 0});
        byte[] nii = gunzip(write(series(Spec.of(3, k))).file());
        assertEquals(5.0f, le(nii).getFloat(92), 0f);
        assertEveryVoxel(nii, 3);
    }

    @Test
    void aFrameReferenceTimeThatDiffersByPositionIsNotAKey() throws Exception {
        // 上半分の位置だけ 100 ms ずれる → 時相 t の値が位置の間で同じでないので鍵にしない
        Keys frtOnly = new Keys(null, new double[]{0, 5000, 10000}, null);
        assertEquals("nifti-ambiguous-phases", refusal(series(Spec.of(3, frtOnly).withFrtUpperOffset(100))).reason());
        assertEveryVoxel(gunzip(write(series(Spec.of(3, frtOnly))).file()), 3); // 対: 揃っていれば通る
    }

    @Test
    void instanceNumberAloneIsNotAPhaseKey() throws Exception {
        // 実測した問題: 手がかりの無い 2 回分の撮影が各位置に 2 枚ずつ。InstanceNumber の順だけでは時相を決められない
        assertEquals("nifti-ambiguous-phases", refusal(series(Spec.of(2, Keys.none()))).reason());
        assertEquals("nifti-ambiguous-phases", refusal(series(Spec.of(3, Keys.none()))).reason());
    }

    @Test
    void aSingleFrameStillWritesAThreeDimensionalFile() throws Exception {
        ComputeDatasetService.Dataset d = write(series(Spec.of(1, Keys.none())));
        byte[] nii = gunzip(d.file());
        assertEquals(3, le(nii).getShort(40), "dim[0]");
        assertEquals(1, le(nii).getShort(48));
        assertEquals(2, le(nii).get(123));
        assertEquals(352 + 4 * NX * NY * NZ, nii.length);
    }

    // ── 断る（負例）。正例と対 ───────────────────────────────────────────────

    @Test
    void duplicatePositionsWithoutAnyTimeKeyAreStillRefused() throws Exception {
        // 撮影が 2 回ぶん混ざったシリーズ（InstanceNumber だけでは時相と決められない）
        assertEquals("nifti-ambiguous-phases", refusal(series(Spec.of(2, Keys.none()))).reason());
        // 同じ形で手がかりを付けると通る（対）
        write(series(Spec.of(2, new Keys(new Integer[]{1, 2}, null, null))));
    }

    @Test
    void aFrameWithAMissingSliceIsRefused() throws Exception {
        Keys k = new Keys(new Integer[]{1, 2}, null, null);
        assertEquals("nifti-uneven-phases", refusal(series(new Spec(2, k, 1, 3, null, 0))).reason());
        write(series(Spec.of(2, k))); // 対: 揃っていれば通る
    }

    @Test
    void timeKeysThatDifferByPositionAreRefused() throws Exception {
        // 位置ごとに TemporalPositionIdentifier の組が違う（上半分は +100）
        Keys k = new Keys(new Integer[]{1, 2}, null, null);
        Spec bad = new Spec(2, k, -1, -1, (e, ds) -> { }, 0);
        assertEquals("nifti-ambiguous-phases", refusal(series(bad)).reason());
    }

    @Test
    void duplicatesAtSomePositionsAreStillRefusedForTheirCounts() throws Exception {
        // 実例（C-A-P）: 位置の一部だけ 2 枚（撮影が 2 回ぶん混ざった）。位置ごとの枚数が揃わないので、鍵の有無によらず断る
        assertEquals("nifti-uneven-phases", refusal(series(new Spec(2, Keys.none(), 1, 0, null, 0))).reason());
        assertEquals("nifti-uneven-phases", refusal(series(new Spec(2, new Keys(new Integer[]{1, 2}, null, null), 1, 0, null, 0))).reason());
    }

    @Test
    void duplicateTimeKeysInsideAPositionAreRefused() throws Exception {
        // 同じ位置の 2 枚が同じ TemporalPositionIdentifier → 時相を決められない（従来の重複の理由のまま）
        assertEquals("nifti-ambiguous-phases", refusal(series(Spec.of(2, new Keys(new Integer[]{1, 1}, null, null)))).reason());
    }

    @Test
    void anUnevenStackWithoutDuplicatesIsStillRefusedAsBefore() throws Exception {
        // 欠けた位置（重複なし）: 4D にはせず、従来の理由
        Keys k = new Keys(null, null, null);
        assertEquals("npz-uneven-spacing", refusal(series(new Spec(1, k, 0, 3, null, 0))).reason());
    }
}

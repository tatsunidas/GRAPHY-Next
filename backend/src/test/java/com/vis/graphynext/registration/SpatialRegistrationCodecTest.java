/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.registration;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DICOM SRO の往復テスト。
 *
 * <p>★ ここで固定したいのは<b>向きの規約</b>である。GRAPHY 内部の変換は
 * fixed → moving だが、SRO の行列は「その項目の FoR を登録先 RCS へ写す」ものなので、
 * <b>逆行列</b>を書く必要がある。1 行の取り違えで「見た目は合っているのに他システムで
 * 反対にずれる」という最も厄介な壊れ方をするため、書いて読んで戻ることを数値で確かめる。
 */
class SpatialRegistrationCodecTest {

    private static final String FIXED_FOR = "1.2.3.fixed";
    private static final String MOVING_FOR = "1.2.3.moving";

    /** 並進 (7.3, -4.1, 11.6) ＋ z まわり 5.5 度。GNBP-2R の rigid と同じ性質の値。 */
    private static double[] rigidTransform() {
        double th = Math.toRadians(5.5);
        double c = Math.cos(th), s = Math.sin(th);
        return new double[]{
                c, -s, 0, 7.3,
                s, c, 0, -4.1,
                0, 0, 1, 11.6,
                0, 0, 0, 1,
        };
    }

    private static Attributes template() {
        Attributes a = new Attributes();
        a.setString(Tag.PatientID, VR.LO, "P1");
        a.setString(Tag.PatientName, VR.PN, "TEST^PATIENT");
        a.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3.study");
        return a;
    }

    private static SpatialRegistrationCodec.Input rigidInput() {
        return new SpatialRegistrationCodec.Input(
                template(), FIXED_FOR, MOVING_FOR, rigidTransform(), null,
                "PET CT REG", "GNBP-2R rigid");
    }

    @Test
    void rigidRoundTripRecoversTheSameTransform() {
        Attributes sro = SpatialRegistrationCodec.build(rigidInput());
        SpatialRegistrationCodec.Parsed p = SpatialRegistrationCodec.parse(sro);

        assertArrayEquals(rigidTransform(), p.fixedToMoving(), 1e-9);
        assertEquals(FIXED_FOR, p.fixedFrameOfReferenceUid());
        assertEquals(MOVING_FOR, p.movingFrameOfReferenceUid());
        assertEquals(SpatialRegistrationCodec.RIGID_SOP_CLASS, p.sopClassUid());
    }

    @Test
    void theStoredMatrixIsTheInverse() {
        // ★ 規約そのものの確認。SRO には moving → fixed が入る（内部の T の逆）。
        Attributes sro = SpatialRegistrationCodec.build(rigidInput());
        Sequence reg = sro.getSequence(Tag.RegistrationSequence);
        assertEquals(2, reg.size(), "fixed の恒等と moving の変換で 2 項目");

        double[] movingItem = reg.get(1)
                .getSequence(Tag.MatrixRegistrationSequence).get(0)
                .getSequence(Tag.MatrixSequence).get(0)
                .getDoubles(Tag.FrameOfReferenceTransformationMatrix);
        assertArrayEquals(
                SpatialRegistrationCodec.invertAffine(rigidTransform()), movingItem, 1e-9,
                "SRO には内部変換の逆行列が入っていなければならない");

        // fixed 側は恒等（RCS が fixed であることを示す）。
        double[] fixedItem = reg.get(0)
                .getSequence(Tag.MatrixRegistrationSequence).get(0)
                .getSequence(Tag.MatrixSequence).get(0)
                .getDoubles(Tag.FrameOfReferenceTransformationMatrix);
        assertTrue(SpatialRegistrationCodec.isIdentity(fixedItem));
    }

    @Test
    void patientAndStudyAreInheritedSoTheSroLandsInTheSameStudy() {
        Attributes sro = SpatialRegistrationCodec.build(rigidInput());
        assertEquals("P1", sro.getString(Tag.PatientID));
        assertEquals("1.2.3.study", sro.getString(Tag.StudyInstanceUID));
        assertEquals("REG", sro.getString(Tag.Modality));
        // 自身の FoR は fixed 側（＝ 登録先 RCS）。
        assertEquals(FIXED_FOR, sro.getString(Tag.FrameOfReferenceUID));
    }

    @Test
    void matrixTypeDistinguishesRigidFromAffine() {
        assertEquals("RIGID", SpatialRegistrationCodec.matrixType(rigidTransform()));

        double[] scaled = SpatialRegistrationCodec.identity();
        scaled[0] = 1.05; scaled[5] = 1.05; scaled[10] = 1.05;
        assertEquals("RIGID_SCALE", SpatialRegistrationCodec.matrixType(scaled));

        double[] sheared = SpatialRegistrationCodec.identity();
        sheared[1] = 0.03; // x が y に依存する = せん断
        assertEquals("AFFINE", SpatialRegistrationCodec.matrixType(sheared));
    }

    @Test
    void contentLabelIsSanitisedToCs() {
        // ContentLabel は CS（大文字・16 文字）。日本語や小文字をそのまま入れると不正な DICOM になる。
        Attributes sro = SpatialRegistrationCodec.build(new SpatialRegistrationCodec.Input(
                template(), FIXED_FOR, MOVING_FOR, rigidTransform(), null,
                "位置合わせ result", null));
        String label = sro.getString(Tag.ContentLabel);
        assertTrue(label.length() <= 16, label);
        assertTrue(label.matches("[A-Z0-9 _]+"), label);
    }

    // ── 非剛体 ────────────────────────────────────────────────────────────

    private static SpatialRegistrationCodec.Dvf dvf() {
        int[] dims = {3, 3, 2};
        float[] disp = new float[3 * 3 * 2 * 3];
        for (int i = 0; i < disp.length; i++) disp[i] = i * 0.25f;
        return new SpatialRegistrationCodec.Dvf(dims, new double[]{-10, -20, -30},
                new double[]{12, 12, 12}, disp);
    }

    @Test
    void deformableRoundTripRecoversGridAndPostMatrix() {
        Attributes sro = SpatialRegistrationCodec.build(new SpatialRegistrationCodec.Input(
                template(), FIXED_FOR, MOVING_FOR, rigidTransform(), dvf(), "DEFORM", null));
        SpatialRegistrationCodec.Parsed p = SpatialRegistrationCodec.parse(sro);

        assertTrue(p.deformable());
        assertEquals(SpatialRegistrationCodec.DEFORMABLE_SOP_CLASS, p.sopClassUid());
        assertArrayEquals(new int[]{3, 3, 2}, p.dvf().dims());
        assertArrayEquals(new double[]{-10, -20, -30}, p.dvf().originMm(), 1e-9);
        assertArrayEquals(new double[]{12, 12, 12}, p.dvf().spacingMm(), 1e-9);
        assertArrayEquals(dvf().displacementsMm(), p.dvf().displacementsMm(), 1e-6f);
        // 剛体部は post に入る（変位が先・剛体が後、という合成順のため）。
        assertArrayEquals(rigidTransform(), p.fixedToMoving(), 1e-9);
    }

    @Test
    void deformableSourceIsTheFixedFrame() {
        // 変位格子は fixed の格子上で定義されているので、source は fixed 側でなければならない。
        Attributes sro = SpatialRegistrationCodec.build(new SpatialRegistrationCodec.Input(
                template(), FIXED_FOR, MOVING_FOR, rigidTransform(), dvf(), "DEFORM", null));
        Attributes item = sro.getSequence(Tag.DeformableRegistrationSequence).get(0);
        assertEquals(FIXED_FOR, item.getString(Tag.SourceFrameOfReferenceUID));

        // pre は恒等（GRAPHY は変位の前に何も掛けない）。
        double[] pre = item.getSequence(Tag.PreDeformationMatrixRegistrationSequence).get(0)
                .getDoubles(Tag.FrameOfReferenceTransformationMatrix);
        assertTrue(SpatialRegistrationCodec.isIdentity(pre));
    }

    @Test
    void unknownSopClassIsRejected() {
        Attributes a = new Attributes();
        a.setString(Tag.SOPClassUID, VR.UI, "1.2.840.10008.5.1.4.1.1.2"); // CT
        assertThrows(IllegalArgumentException.class, () -> SpatialRegistrationCodec.parse(a));
    }

    @Test
    void singularMatrixIsRejectedInsteadOfProducingNonsense() {
        double[] singular = SpatialRegistrationCodec.identity();
        singular[0] = 0; singular[5] = 0; singular[10] = 0;
        assertThrows(IllegalArgumentException.class,
                () -> SpatialRegistrationCodec.invertAffine(singular));
    }

    @Test
    void inverseOfInverseIsTheOriginal() {
        double[] m = rigidTransform();
        double[] back = SpatialRegistrationCodec.invertAffine(
                SpatialRegistrationCodec.invertAffine(m));
        assertArrayEquals(m, back, 1e-9);
    }

    @Test
    void generatedInstanceHasItsOwnUids() {
        Attributes a = SpatialRegistrationCodec.build(rigidInput());
        Attributes b = SpatialRegistrationCodec.build(rigidInput());
        assertNotNull(a.getString(Tag.SOPInstanceUID));
        assertTrue(!a.getString(Tag.SOPInstanceUID).equals(b.getString(Tag.SOPInstanceUID)));
        assertTrue(!a.getString(Tag.SeriesInstanceUID).equals(b.getString(Tag.SeriesInstanceUID)));
    }
}

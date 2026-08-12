/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.registration;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.util.UIDUtils;

import java.util.Date;

/**
 * DICOM Spatial Registration Object（SRO）の組み立てと読み出し
 * （設計 {@code fw/registration-design.md} R5）。
 *
 * <ul>
 *   <li>剛体・アフィン → <b>Spatial Registration Storage</b>（{@code 1.2.840.10008.5.1.4.1.1.66.1}）</li>
 *   <li>非剛体 → <b>Deformable Spatial Registration Storage</b>（{@code …66.3}）</li>
 * </ul>
 *
 * <h3>★ 向きの規約 — ここを取り違えると全部おかしくなる</h3>
 *
 * <p>GRAPHY が内部で持つ変換 {@code T} は <b>fixed world → moving world</b> である
 * （`regTransform.ts` と GNBP-2R の {@code transform_fixed_to_moving} と同じ向き）。
 *
 * <p>一方 DICOM の SRO は、各項目の {@code FrameOfReferenceTransformationMatrix} が
 * <b>その項目の Frame of Reference を、登録先の RCS へ写す</b>行列である。
 * 慣行として <b>fixed の FoR を恒等（＝ RCS を fixed 側に置く）</b>とし、
 * moving の FoR の項目に「moving → fixed」の行列を入れる。
 *
 * <p>したがって SRO に書くのは <b>{@code T} の逆行列</b>である。読み出すときは
 * もう一度逆にして {@code T} に戻す。この 1 行の取り違えが、
 * 「見た目は合っているのに他システムで反対にずれる」という最も厄介な壊れ方を生む。
 * 往復テスト（{@code SpatialRegistrationCodecTest}）でここを固定してある。
 *
 * <h3>非剛体の向きと、既知の限界</h3>
 *
 * <p>非剛体（66.3）は「pre 行列 → 変位格子 → post 行列」の順に適用して source FoR を
 * RCS へ写す。GRAPHY の合成は {@code q = R(p + u(p))}（変位が先・剛体が後）なので、
 * <b>source を fixed 側に置く</b>と pre=恒等・格子=u・post=R がそのまま対応する。
 * この向きで書き、同じ規約で読み戻す。
 *
 * <p>⚠️ <b>他ベンダとの相互運用は未検証</b>である。変位格子がどの座標系で定義されるかの
 * 解釈には実装差がありうるため、外部システムと交換する前に参照実装との突き合わせが要る。
 * ここで保証しているのは <b>GRAPHY 内での往復の一貫性</b>までである。
 */
public final class SpatialRegistrationCodec {

    /** Spatial Registration Storage（剛体・アフィン）。 */
    public static final String RIGID_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.66.1";
    /** Deformable Spatial Registration Storage（非剛体）。 */
    public static final String DEFORMABLE_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.66.3";

    private SpatialRegistrationCodec() {
    }

    /** SRO 生成の入力。 */
    public record Input(
            /** 患者・検査属性の引き継ぎ元（通常は fixed シリーズの代表インスタンス）。 */
            Attributes template,
            String fixedFrameOfReferenceUid,
            String movingFrameOfReferenceUid,
            /** fixed → moving の 4×4（row-major, 16 要素）。 */
            double[] fixedToMoving,
            /** 非剛体のとき: 変位場。null なら剛体 SRO を作る。 */
            Dvf dvf,
            String contentLabel,
            String contentDescription) {
    }

    /** 変位場。格子は世界軸に平行で等間隔（GRAPHY のエンジンの出力そのまま）。 */
    public record Dvf(
            int[] dims,
            double[] originMm,
            double[] spacingMm,
            /** 制御点ごとに x,y,z の順（長さ = dims 積 × 3）。 */
            float[] displacementsMm) {
    }

    /** 読み出した結果。{@code fixedToMoving} は GRAPHY 内部の向きに戻してある。 */
    public record Parsed(
            String sopInstanceUid,
            String sopClassUid,
            String fixedFrameOfReferenceUid,
            String movingFrameOfReferenceUid,
            double[] fixedToMoving,
            Dvf dvf,
            String contentLabel,
            String contentDescription,
            String contentDate,
            String contentTime) {
        public boolean deformable() {
            return dvf != null;
        }
    }

    // ── 生成 ─────────────────────────────────────────────────────────────

    public static Attributes build(Input in) {
        Attributes a = new Attributes();
        Attributes tmpl = in.template();

        // 患者・検査は fixed 側から引き継ぐ。SRO は同じ検査の中に置く。
        for (int tag : new int[]{
                Tag.SpecificCharacterSet,
                Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex,
                Tag.StudyInstanceUID, Tag.StudyDate, Tag.StudyTime, Tag.StudyID,
                Tag.AccessionNumber, Tag.StudyDescription, Tag.ReferringPhysicianName,
        }) {
            if (tmpl != null && tmpl.contains(tag)) {
                a.setValue(tag, tmpl.getVR(tag), tmpl.getValue(tag));
            }
        }
        if (a.getString(Tag.SpecificCharacterSet) == null) {
            a.setSpecificCharacterSet("ISO_IR 192");
        }

        boolean deformable = in.dvf() != null;
        String sopClass = deformable ? DEFORMABLE_SOP_CLASS : RIGID_SOP_CLASS;
        a.setString(Tag.SOPClassUID, VR.UI, sopClass);
        a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        a.setString(Tag.SeriesInstanceUID, VR.UI, UIDUtils.createUID());
        a.setString(Tag.Modality, VR.CS, "REG");
        a.setInt(Tag.SeriesNumber, VR.IS, deformable ? 9902 : 9901);
        a.setInt(Tag.InstanceNumber, VR.IS, 1);
        a.setString(Tag.SeriesDescription, VR.LO,
                deformable ? "GRAPHY deformable registration" : "GRAPHY spatial registration");

        Date now = new Date();
        a.setDate(Tag.ContentDateAndTime, now);
        a.setDate(Tag.InstanceCreationDateAndTime, now);
        a.setString(Tag.ContentLabel, VR.CS, sanitizeLabel(in.contentLabel()));
        a.setString(Tag.ContentDescription, VR.LO,
                in.contentDescription() != null ? in.contentDescription() : "");
        a.setString(Tag.ContentCreatorName, VR.PN, "GRAPHY-Next");
        a.setString(Tag.Manufacturer, VR.LO, "Visionary Imaging Services, Inc.");

        // 登録先の RCS は fixed 側。fixed の FoR をそのまま自分の FoR にする。
        a.setString(Tag.FrameOfReferenceUID, VR.UI, in.fixedFrameOfReferenceUid());

        if (deformable) {
            buildDeformable(a, in);
        } else {
            buildRigid(a, in);
        }
        return a;
    }

    private static void buildRigid(Attributes a, Input in) {
        Sequence reg = a.newSequence(Tag.RegistrationSequence, 2);

        // 1) fixed 側 = 恒等。RCS が fixed であることを明示する項目。
        reg.add(matrixItem(in.fixedFrameOfReferenceUid(), identity(), "RIGID"));

        // 2) moving 側 = moving → fixed（＝ 内部の T の逆）。
        double[] movingToFixed = invertAffine(in.fixedToMoving());
        reg.add(matrixItem(in.movingFrameOfReferenceUid(), movingToFixed, matrixType(in.fixedToMoving())));
    }

    private static Attributes matrixItem(String forUid, double[] matrix, String type) {
        Attributes item = new Attributes();
        item.setString(Tag.FrameOfReferenceUID, VR.UI, forUid);
        Sequence mrs = item.newSequence(Tag.MatrixRegistrationSequence, 1);
        Attributes mr = new Attributes();
        Sequence ms = mr.newSequence(Tag.MatrixSequence, 1);
        Attributes m = new Attributes();
        m.setString(Tag.FrameOfReferenceTransformationMatrixType, VR.CS, type);
        m.setDouble(Tag.FrameOfReferenceTransformationMatrix, VR.DS, matrix);
        ms.add(m);
        mrs.add(mr);
        return item;
    }

    private static void buildDeformable(Attributes a, Input in) {
        Sequence seq = a.newSequence(Tag.DeformableRegistrationSequence, 1);
        Attributes item = new Attributes();
        // source は fixed 側。pre=恒等 → 変位格子 → post=剛体 の順で fixed → moving になる
        // （GRAPHY の合成 q = R(p + u(p)) と同じ並び）。
        item.setString(Tag.SourceFrameOfReferenceUID, VR.UI, in.fixedFrameOfReferenceUid());

        Sequence pre = item.newSequence(Tag.PreDeformationMatrixRegistrationSequence, 1);
        Attributes preItem = new Attributes();
        preItem.setString(Tag.FrameOfReferenceTransformationMatrixType, VR.CS, "RIGID");
        preItem.setDouble(Tag.FrameOfReferenceTransformationMatrix, VR.DS, identity());
        pre.add(preItem);

        Sequence post = item.newSequence(Tag.PostDeformationMatrixRegistrationSequence, 1);
        Attributes postItem = new Attributes();
        postItem.setString(Tag.FrameOfReferenceTransformationMatrixType, VR.CS, matrixType(in.fixedToMoving()));
        postItem.setDouble(Tag.FrameOfReferenceTransformationMatrix, VR.DS, in.fixedToMoving());
        post.add(postItem);

        Dvf d = in.dvf();
        Sequence grid = item.newSequence(Tag.DeformableRegistrationGridSequence, 1);
        Attributes g = new Attributes();
        g.setDouble(Tag.ImagePositionPatient, VR.DS, d.originMm());
        // 格子は世界軸に平行。エンジンの出力がそうなっている（`buildPyramid` と同じ作法）。
        g.setDouble(Tag.ImageOrientationPatient, VR.DS, 1, 0, 0, 0, 1, 0);
        g.setInt(Tag.GridDimensions, VR.UL, d.dims());
        g.setDouble(Tag.GridResolution, VR.FD, d.spacingMm());
        g.setFloat(Tag.VectorGridData, VR.OF, d.displacementsMm());
        grid.add(g);

        seq.add(item);
    }

    // ── 読み出し ─────────────────────────────────────────────────────────

    public static Parsed parse(Attributes a) {
        String sopClass = a.getString(Tag.SOPClassUID, "");
        if (DEFORMABLE_SOP_CLASS.equals(sopClass)) return parseDeformable(a);
        if (RIGID_SOP_CLASS.equals(sopClass)) return parseRigid(a);
        throw new IllegalArgumentException("Spatial Registration ではありません: SOPClassUID=" + sopClass);
    }

    private static Parsed parseRigid(Attributes a) {
        Sequence reg = a.getSequence(Tag.RegistrationSequence);
        if (reg == null || reg.isEmpty()) {
            throw new IllegalArgumentException("RegistrationSequence がありません");
        }
        String fixedFor = a.getString(Tag.FrameOfReferenceUID);
        String movingFor = null;
        double[] movingToFixed = null;

        for (Attributes item : reg) {
            String forUid = item.getString(Tag.FrameOfReferenceUID);
            double[] m = firstMatrix(item);
            if (m == null) continue;
            if (forUid != null && forUid.equals(fixedFor) && isIdentity(m)) continue; // fixed 側の恒等
            movingFor = forUid;
            movingToFixed = m;
        }
        if (movingToFixed == null) {
            throw new IllegalArgumentException("moving 側の変換行列が見つかりません");
        }
        // 内部の向き（fixed → moving）へ戻す。
        return new Parsed(
                a.getString(Tag.SOPInstanceUID), RIGID_SOP_CLASS, fixedFor, movingFor,
                invertAffine(movingToFixed), null,
                a.getString(Tag.ContentLabel), a.getString(Tag.ContentDescription),
                a.getString(Tag.ContentDate), a.getString(Tag.ContentTime));
    }

    private static Parsed parseDeformable(Attributes a) {
        Sequence seq = a.getSequence(Tag.DeformableRegistrationSequence);
        if (seq == null || seq.isEmpty()) {
            throw new IllegalArgumentException("DeformableRegistrationSequence がありません");
        }
        Attributes item = seq.get(0);
        Sequence grid = item.getSequence(Tag.DeformableRegistrationGridSequence);
        if (grid == null || grid.isEmpty()) {
            throw new IllegalArgumentException("DeformableRegistrationGridSequence がありません");
        }
        Attributes g = grid.get(0);

        double[] post = firstMatrixIn(item.getSequence(Tag.PostDeformationMatrixRegistrationSequence));
        Dvf dvf = new Dvf(
                g.getInts(Tag.GridDimensions),
                g.getDoubles(Tag.ImagePositionPatient),
                g.getDoubles(Tag.GridResolution),
                g.getFloats(Tag.VectorGridData));

        return new Parsed(
                a.getString(Tag.SOPInstanceUID), DEFORMABLE_SOP_CLASS,
                item.getString(Tag.SourceFrameOfReferenceUID),
                a.getString(Tag.FrameOfReferenceUID),
                post != null ? post : identity(), dvf,
                a.getString(Tag.ContentLabel), a.getString(Tag.ContentDescription),
                a.getString(Tag.ContentDate), a.getString(Tag.ContentTime));
    }

    private static double[] firstMatrix(Attributes item) {
        return firstMatrixIn(item.getSequence(Tag.MatrixRegistrationSequence) != null
                ? item.getSequence(Tag.MatrixRegistrationSequence).get(0).getSequence(Tag.MatrixSequence)
                : null);
    }

    private static double[] firstMatrixIn(Sequence seq) {
        if (seq == null || seq.isEmpty()) return null;
        return seq.get(0).getDoubles(Tag.FrameOfReferenceTransformationMatrix);
    }

    // ── 行列ユーティリティ ───────────────────────────────────────────────

    static double[] identity() {
        return new double[]{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    }

    static boolean isIdentity(double[] m) {
        double[] id = identity();
        for (int i = 0; i < 16; i++) {
            if (Math.abs(m[i] - id[i]) > 1e-9) return false;
        }
        return true;
    }

    /**
     * 行列の種別。DICOM は {@code RIGID} / {@code RIGID_SCALE} / {@code AFFINE} を区別する。
     * 誤って RIGID と書くと、受け手が「回転と平行移動しか無い」と仮定して最適化や
     * 逆変換の計算を簡略化しうるので、実際にスケール・せん断があるなら AFFINE と書く。
     */
    static String matrixType(double[] m) {
        // 左上 3×3 が直交（RᵀR = I）なら RIGID。
        double[][] r = {
                {m[0], m[1], m[2]},
                {m[4], m[5], m[6]},
                {m[8], m[9], m[10]},
        };
        double[] scales = new double[3];
        for (int c = 0; c < 3; c++) {
            scales[c] = Math.sqrt(r[0][c] * r[0][c] + r[1][c] * r[1][c] + r[2][c] * r[2][c]);
        }
        boolean unitScale = true;
        for (double s : scales) {
            if (Math.abs(s - 1) > 1e-6) unitScale = false;
        }
        boolean orthogonal = true;
        for (int i = 0; i < 3 && orthogonal; i++) {
            for (int j = i + 1; j < 3; j++) {
                double dot = r[0][i] * r[0][j] + r[1][i] * r[1][j] + r[2][i] * r[2][j];
                if (Math.abs(dot) > 1e-6) { orthogonal = false; break; }
            }
        }
        if (orthogonal && unitScale) return "RIGID";
        if (orthogonal) return "RIGID_SCALE";
        return "AFFINE";
    }

    /** アフィン 4×4 の逆行列（最終行は [0,0,0,1] 前提）。 */
    static double[] invertAffine(double[] m) {
        double a = m[0], b = m[1], c = m[2];
        double d = m[4], e = m[5], f = m[6];
        double g = m[8], h = m[9], i = m[10];

        double A = e * i - f * h;
        double B = -(d * i - f * g);
        double C = d * h - e * g;
        double det = a * A + b * B + c * C;
        if (!Double.isFinite(det) || Math.abs(det) < 1e-12) {
            throw new IllegalArgumentException("変換行列が特異です（逆変換を作れません）");
        }
        double inv = 1 / det;
        double r00 = A * inv;
        double r01 = -(b * i - c * h) * inv;
        double r02 = (b * f - c * e) * inv;
        double r10 = B * inv;
        double r11 = (a * i - c * g) * inv;
        double r12 = -(a * f - c * d) * inv;
        double r20 = C * inv;
        double r21 = -(a * h - b * g) * inv;
        double r22 = (a * e - b * d) * inv;

        double tx = m[3], ty = m[7], tz = m[11];
        return new double[]{
                r00, r01, r02, -(r00 * tx + r01 * ty + r02 * tz),
                r10, r11, r12, -(r10 * tx + r11 * ty + r12 * tz),
                r20, r21, r22, -(r20 * tx + r21 * ty + r22 * tz),
                0, 0, 0, 1,
        };
    }

    /** {@code ContentLabel} は CS（大文字・英数字・空白・アンダースコア、16 文字）。 */
    private static String sanitizeLabel(String label) {
        String base = (label == null || label.isBlank()) ? "REGISTRATION" : label;
        String up = base.toUpperCase().replaceAll("[^A-Z0-9 _]", "_");
        return up.length() > 16 ? up.substring(0, 16) : up;
    }

    /** 保存に使う転送構文（他と揃える）。 */
    public static String transferSyntax() {
        return UID.ExplicitVRLittleEndian;
    }
}

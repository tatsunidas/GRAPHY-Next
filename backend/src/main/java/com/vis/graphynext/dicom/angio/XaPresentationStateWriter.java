/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.dcm4che3.util.UIDUtils;

import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * XA/XRF Grayscale Softcopy Presentation State（{@code 1.2.840.10008.5.1.4.1.1.11.5}）を組み立てる
 * （{@code fw/angio-design.md} §14.1 / A10）。純関数（Attributes を返すだけ・保存はしない）。
 *
 * <h3>なぜ 11.1 ではなく 11.5 なのか</h3>
 * <b>Mask モジュール（マスクフレーム・ピクセルシフト）を持てるのが XA/XRF GSPS だけ</b>だから。
 * DSA の設定を保存できないと、A2 で作った差分表示を開き直したときに再現できない。
 *
 * <h3>座標の約束</h3>
 * 呼び出し側からは<b>画像ピクセル座標（0 origin・小数可）</b>で受け取り、ここで GSPS の
 * {@code PIXEL} 単位へ変換する。DICOM の PIXEL 単位は<b>左上画素の中心が (0.5, 0.5)</b> なので
 * <b>+0.5 する</b>。⚠️ 半画素の話なので画面上はほぼ気づけない。実機で他社ビューアに
 * 読ませて突き合わせること（§18）。
 *
 * <h3>空間校正の保存先</h3>
 * Displayed Area Selection Sequence の <b>Presentation Pixel Spacing (0070,0101)</b> に入れる。
 * A3 で解決した mm/px（カテーテル校正等）はここに残るので、開き直しても同じ長さが出る。
 */
final class XaPresentationStateWriter {

    /** XA/XRF Grayscale Softcopy Presentation State Storage。 */
    static final String XA_XRF_GSPS_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.11.5";

    /** GraphicLayer 名の既定（層を指定しなかった図形の置き場）。 */
    private static final String DEFAULT_LAYER = "GRAPHY";

    private XaPresentationStateWriter() {
    }

    /** 生成結果。{@code dataset} は FileMetaInformation を含まない本体。 */
    record Result(Attributes dataset, String seriesInstanceUid, String sopInstanceUid) {
    }

    /**
     * @param referenceTemplate 患者/スタディ識別情報の継承元（対象インスタンスのヘッダ）
     * @param req               作成要求
     * @param rows              参照画像の Rows（Displayed Area 用。0 ならテンプレートから読む）
     * @param columns           同 Columns
     */
    static Result build(Attributes referenceTemplate, AngioPresentationRequest req, int rows, int columns) {
        String seriesUid = UIDUtils.createUID();
        String sopUid = UIDUtils.createUID();
        Date now = new Date();

        int r = rows > 0 ? rows : referenceTemplate.getInt(Tag.Rows, 0);
        int c = columns > 0 ? columns : referenceTemplate.getInt(Tag.Columns, 0);

        Attributes ds = new Attributes();
        // 患者・スタディの識別情報は参照元から引き継ぐ（別患者に紐づく事故を防ぐ）。
        for (int tag : new int[] {
                Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex,
                Tag.StudyInstanceUID, Tag.StudyDate, Tag.StudyTime, Tag.StudyID, Tag.AccessionNumber,
                Tag.ReferringPhysicianName, Tag.StudyDescription }) {
            copy(referenceTemplate, ds, tag);
        }
        ds.setString(Tag.SpecificCharacterSet, VR.CS, "ISO_IR 192");
        ds.setString(Tag.SOPClassUID, VR.UI, XA_XRF_GSPS_SOP_CLASS);
        ds.setString(Tag.SOPInstanceUID, VR.UI, sopUid);
        ds.setString(Tag.Modality, VR.CS, "PR");
        ds.setString(Tag.SeriesInstanceUID, VR.UI, seriesUid);
        ds.setInt(Tag.SeriesNumber, VR.IS, 9000);
        ds.setInt(Tag.InstanceNumber, VR.IS, 1);
        ds.setDate(Tag.SeriesDate, VR.DA, now);
        ds.setDate(Tag.SeriesTime, VR.TM, now);
        ds.setString(Tag.SeriesDescription, VR.LO, "GRAPHY-Next Presentation State");

        // ── Presentation State Identification ──────────────────────────────
        ds.setString(Tag.ContentLabel, VR.CS, toContentLabel(req.label()));
        ds.setString(Tag.ContentDescription, VR.LO, req.description() == null ? "" : req.description());
        ds.setDate(Tag.PresentationCreationDate, VR.DA, now);
        ds.setDate(Tag.PresentationCreationTime, VR.TM, now);
        ds.setString(Tag.ContentCreatorName, VR.PN, req.creator() == null ? "" : req.creator());

        // ── Presentation State Relationship（参照画像）─────────────────────
        Attributes refSeries = new Attributes();
        refSeries.setString(Tag.SeriesInstanceUID, VR.UI, req.seriesInstanceUid());
        Attributes refImage = new Attributes();
        refImage.setString(Tag.ReferencedSOPClassUID, VR.UI,
                referenceTemplate.getString(Tag.SOPClassUID, "1.2.840.10008.5.1.4.1.1.12.1"));
        refImage.setString(Tag.ReferencedSOPInstanceUID, VR.UI, req.sopInstanceUid());
        int[] frames = toIntArray(req.frameNumbers());
        if (frames.length > 0) {
            refImage.setInt(Tag.ReferencedFrameNumber, VR.IS, frames);
        }
        refSeries.newSequence(Tag.ReferencedImageSequence, 1).add(refImage);
        ds.newSequence(Tag.ReferencedSeriesSequence, 1).add(refSeries);

        // ── Displayed Area（＋空間校正の保存先）─────────────────────────────
        Attributes area = new Attributes();
        area.setInt(Tag.DisplayedAreaTopLeftHandCorner, VR.SL, 1, 1);
        area.setInt(Tag.DisplayedAreaBottomRightHandCorner, VR.SL, Math.max(1, c), Math.max(1, r));
        area.setString(Tag.PresentationSizeMode, VR.CS, "SCALE TO FIT");
        AngioPresentationRequest.Calibration cal = req.calibration();
        if (cal != null && cal.mmPerPxRow() != null && cal.mmPerPxCol() != null
                && cal.mmPerPxRow() > 0 && cal.mmPerPxCol() > 0) {
            // Presentation Pixel Spacing は [row, column]（DICOM の PixelSpacing と同じ並び）。
            area.setDouble(Tag.PresentationPixelSpacing, VR.DS, cal.mmPerPxRow(), cal.mmPerPxCol());
        }
        ds.newSequence(Tag.DisplayedAreaSelectionSequence, 1).add(area);

        // ── Softcopy VOI LUT ───────────────────────────────────────────────
        if (req.voi() != null) {
            Attributes voi = new Attributes();
            voi.setDouble(Tag.WindowCenter, VR.DS, req.voi().windowCenter());
            voi.setDouble(Tag.WindowWidth, VR.DS, req.voi().windowWidth());
            ds.newSequence(Tag.SoftcopyVOILUTSequence, 1).add(voi);
        }

        // ── Presentation LUT（白黒反転）──────────────────────────────────
        ds.setString(Tag.PresentationLUTShape, VR.CS, Boolean.TRUE.equals(req.invert()) ? "INVERSE" : "IDENTITY");

        // ── Spatial Transformation（回転・左右反転）────────────────────────
        int rot = normalizeRotation(req.rotation());
        ds.setInt(Tag.ImageRotation, VR.US, rot);
        ds.setString(Tag.ImageHorizontalFlip, VR.CS, Boolean.TRUE.equals(req.flipHorizontal()) ? "Y" : "N");

        // ── Mask（DSA。XA/XRF GSPS を選ぶ理由そのもの）──────────────────────
        AngioPresentationRequest.Mask mask = req.mask();
        boolean subtracted = mask != null && mask.maskFrameNumbers() != null && !mask.maskFrameNumbers().isEmpty();
        if (subtracted) {
            Attributes m = new Attributes();
            m.setString(Tag.MaskOperation, VR.CS,
                    mask.operation() == null || mask.operation().isBlank() ? "AVG_SUB" : mask.operation());
            m.setInt(Tag.MaskFrameNumbers, VR.US, toIntArray(mask.maskFrameNumbers()));
            if (frames.length > 0) {
                // 適用範囲は参照フレームの最小〜最大。
                m.setInt(Tag.ApplicableFrameRange, VR.US, min(frames), max(frames));
            }
            double shiftRow = mask.subPixelShiftRow() == null ? 0 : mask.subPixelShiftRow();
            double shiftCol = mask.subPixelShiftCol() == null ? 0 : mask.subPixelShiftCol();
            // MaskSubPixelShift は [row, column]。frontend の {dx=横, dy=縦} と並びが逆なので注意。
            m.setFloat(Tag.MaskSubPixelShift, VR.FL, (float) shiftRow, (float) shiftCol);
            ds.newSequence(Tag.MaskSubtractionSequence, 1).add(m);
        }
        ds.setString(Tag.RecommendedViewingMode, VR.CS, subtracted ? "SUB" : "NAT");

        // ── Graphic Layer / Graphic Annotation ────────────────────────────
        List<AngioPresentationRequest.Polyline> lines = req.polylines() == null ? List.of() : req.polylines();
        List<AngioPresentationRequest.TextAnnotation> texts = req.texts() == null ? List.of() : req.texts();
        Set<String> layers = new LinkedHashSet<>();
        for (AngioPresentationRequest.Polyline p : lines) {
            layers.add(layerOf(p.layer()));
        }
        for (AngioPresentationRequest.TextAnnotation tx : texts) {
            layers.add(layerOf(tx.layer()));
        }
        if (!layers.isEmpty()) {
            Sequence layerSeq = ds.newSequence(Tag.GraphicLayerSequence, layers.size());
            int order = 1;
            for (String name : layers) {
                Attributes l = new Attributes();
                l.setString(Tag.GraphicLayer, VR.CS, name);
                l.setInt(Tag.GraphicLayerOrder, VR.IS, order++);
                layerSeq.add(l);
            }
            Sequence annSeq = ds.newSequence(Tag.GraphicAnnotationSequence, layers.size());
            for (String name : layers) {
                Attributes ann = new Attributes();
                ann.setString(Tag.GraphicLayer, VR.CS, name);
                List<Attributes> objs = new ArrayList<>();
                for (AngioPresentationRequest.Polyline p : lines) {
                    if (!layerOf(p.layer()).equals(name)) {
                        continue;
                    }
                    Attributes g = graphicObject(p);
                    if (g != null) {
                        objs.add(g);
                    }
                }
                if (!objs.isEmpty()) {
                    Sequence gs = ann.newSequence(Tag.GraphicObjectSequence, objs.size());
                    objs.forEach(gs::add);
                }
                List<Attributes> textObjs = new ArrayList<>();
                for (AngioPresentationRequest.TextAnnotation tx : texts) {
                    if (!layerOf(tx.layer()).equals(name) || tx.text() == null || tx.text().isBlank()) {
                        continue;
                    }
                    Attributes to = new Attributes();
                    to.setString(Tag.UnformattedTextValue, VR.ST, tx.text());
                    to.setFloat(Tag.AnchorPoint, VR.FL, (float) (tx.anchorX() + 0.5), (float) (tx.anchorY() + 0.5));
                    to.setString(Tag.AnchorPointAnnotationUnits, VR.CS, "PIXEL");
                    to.setString(Tag.AnchorPointVisibility, VR.CS, "N");
                    textObjs.add(to);
                }
                if (!textObjs.isEmpty()) {
                    Sequence ts = ann.newSequence(Tag.TextObjectSequence, textObjs.size());
                    textObjs.forEach(ts::add);
                }
                annSeq.add(ann);
            }
        }

        return new Result(ds, seriesUid, sopUid);
    }

    private static Attributes graphicObject(AngioPresentationRequest.Polyline p) {
        List<Double> pts = p.points();
        if (pts == null || pts.size() < 2 || pts.size() % 2 != 0) {
            return null;
        }
        float[] data = new float[pts.size()];
        for (int i = 0; i < pts.size(); i++) {
            // GSPS の PIXEL 単位は「左上画素の中心 = (0.5, 0.5)」。0 origin の画素座標から +0.5 する。
            data[i] = (float) (pts.get(i) + 0.5);
        }
        int n = pts.size() / 2;
        Attributes g = new Attributes();
        g.setString(Tag.GraphicAnnotationUnits, VR.CS, "PIXEL");
        g.setInt(Tag.GraphicDimensions, VR.US, 2);
        g.setInt(Tag.NumberOfGraphicPoints, VR.US, n);
        g.setFloat(Tag.GraphicData, VR.FL, data);
        g.setString(Tag.GraphicType, VR.CS, n == 1 ? "POINT" : "POLYLINE");
        g.setString(Tag.GraphicFilled, VR.CS, Boolean.TRUE.equals(p.filled()) ? "Y" : "N");
        return g;
    }

    /** ContentLabel は CS（大文字・英数と _ のみ・16 文字）。整形して必ず値を入れる（Type 1）。 */
    static String toContentLabel(String raw) {
        String base = raw == null || raw.isBlank() ? "GRAPHY_PR" : raw;
        String up = base.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9_]", "_");
        return up.length() > 16 ? up.substring(0, 16) : up;
    }

    private static String layerOf(String name) {
        if (name == null || name.isBlank()) {
            return DEFAULT_LAYER;
        }
        String up = name.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9_]", "_");
        return up.length() > 16 ? up.substring(0, 16) : up;
    }

    private static int normalizeRotation(Integer rot) {
        if (rot == null) {
            return 0;
        }
        int v = ((rot % 360) + 360) % 360;
        return switch (v) {
            case 90, 180, 270 -> v;
            default -> 0;
        };
    }

    private static int[] toIntArray(List<Integer> list) {
        if (list == null || list.isEmpty()) {
            return new int[0];
        }
        int[] out = new int[list.size()];
        for (int i = 0; i < list.size(); i++) {
            out[i] = list.get(i) == null ? 0 : list.get(i);
        }
        return out;
    }

    private static int min(int[] a) {
        int m = a[0];
        for (int v : a) {
            m = Math.min(m, v);
        }
        return m;
    }

    private static int max(int[] a) {
        int m = a[0];
        for (int v : a) {
            m = Math.max(m, v);
        }
        return m;
    }

    private static void copy(Attributes from, Attributes to, int tag) {
        if (from != null && from.containsValue(tag)) {
            to.setString(tag, from.getVR(tag), from.getString(tag));
        }
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * GSPS を読んで表示状態にする（{@code fw/angio-design.md} §14.1 / A10 の読み込み側）。純関数。
 *
 * <h3>🚨 これは「他人が書いたもの」を読む側である</h3>
 * 書き出し側（{@link XaPresentationStateWriter}）と往復できるだけでは足りない。
 * 他社の GSPS では次が普通に起きるので、**落とすなら落としたと言う**（{@code warnings}）:
 *
 * <ul>
 *   <li><b>VOI が LUT で書かれている</b>（Window Center/Width ではなく LUT Data）。
 *       曲線を W/L に潰すと別の絵になるので、**推測で近似しない**</li>
 *   <li><b>図形の単位が DISPLAY</b>（表示面に対する 0〜1 の割合）。画像画素へ落とすには
 *       表示のジオメトリが要り、こちらの表示と一致する保証がない</li>
 *   <li><b>Display Shutter / Bitmap Shutter</b>。表示範囲を隠す指定で、無視すると
 *       「隠れているはずのものが見える」</li>
 *   <li><b>複数の参照画像</b>。どれに当てるかは呼び出し側が決める</li>
 * </ul>
 *
 * <h3>座標の約束</h3>
 * GSPS の PIXEL 単位は<b>左上画素の中心が (1.0, 1.0)</b>（1 origin・画素中心）。
 * 本アプリの画像座標は 0 origin なので <b>−0.5</b> して返す（writer は +0.5 している）。
 */
final class XaPresentationStateReader {

    /** 解釈できる Presentation State の SOP Class（XA/XRF GSPS と、通常の GSPS）。 */
    private static final String XA_XRF_GSPS = "1.2.840.10008.5.1.4.1.1.11.5";
    private static final String GRAYSCALE_GSPS = "1.2.840.10008.5.1.4.1.1.11.1";

    private XaPresentationStateReader() {
    }

    /** 解釈できる SOP Class か（保管庫の一覧から「適用できるもの」を拾うのに使う）。 */
    static boolean isSupported(String sopClassUid) {
        return XA_XRF_GSPS.equals(sopClassUid) || GRAYSCALE_GSPS.equals(sopClassUid);
    }

    static XaPresentationState read(Attributes ds) {
        List<String> warnings = new ArrayList<>();
        String sopClass = ds.getString(Tag.SOPClassUID, "");
        if (!isSupported(sopClass)) {
            // 読めないものを「読めた」ことにしない。
            throw new IllegalArgumentException("表示状態ではありません: SOPClassUID=" + sopClass);
        }
        if (GRAYSCALE_GSPS.equals(sopClass)) {
            // 11.1 には Mask モジュールが無い＝DSA の設定は入っていない（§14.1 の採用理由）。
            warnings.add("notXaGsps");
        }

        List<XaPresentationState.ReferencedImage> refs = readReferences(ds, warnings);
        XaPresentationState.Voi voi = readVoi(ds, warnings);
        boolean invert = "INVERSE".equalsIgnoreCase(ds.getString(Tag.PresentationLUTShape, ""));
        if (ds.contains(Tag.PresentationLUTSequence)) {
            // LUT そのもので表示を作る指定。反転かどうかに潰せない。
            warnings.add("presentationLutSequence");
        }
        int rotation = normalizeRotation(ds.getInt(Tag.ImageRotation, 0));
        boolean flip = "Y".equalsIgnoreCase(ds.getString(Tag.ImageHorizontalFlip, "N"));
        if (ds.contains(Tag.ShutterShape) || ds.contains(Tag.ShutterOverlayGroup)) {
            warnings.add("displayShutter");
        }
        if (ds.contains(Tag.ModalityLUTSequence)) {
            warnings.add("modalityLut");
        }

        XaPresentationState.Mask mask = readMask(ds);
        XaPresentationState.Calibration cal = readCalibration(ds);

        List<XaPresentationState.Polyline> lines = new ArrayList<>();
        List<XaPresentationState.TextAnnotation> texts = new ArrayList<>();
        readAnnotations(ds, lines, texts, warnings);

        return new XaPresentationState(
                ds.getString(Tag.SOPInstanceUID, ""),
                sopClass,
                ds.getString(Tag.ContentLabel, ""),
                ds.getString(Tag.ContentDescription, ""),
                ds.getString(Tag.ContentCreatorName, ""),
                refs,
                voi,
                invert,
                rotation,
                flip,
                mask,
                cal,
                List.copyOf(lines),
                List.copyOf(texts),
                List.copyOf(new LinkedHashSet<>(warnings)));
    }

    private static List<XaPresentationState.ReferencedImage> readReferences(Attributes ds, List<String> warnings) {
        List<XaPresentationState.ReferencedImage> out = new ArrayList<>();
        Sequence series = ds.getSequence(Tag.ReferencedSeriesSequence);
        if (series == null) {
            return List.of();
        }
        for (Attributes s : series) {
            String seriesUid = s.getString(Tag.SeriesInstanceUID, "");
            Sequence images = s.getSequence(Tag.ReferencedImageSequence);
            if (images == null) {
                continue;
            }
            for (Attributes img : images) {
                int[] frames = img.getInts(Tag.ReferencedFrameNumber);
                List<Integer> frameList = new ArrayList<>();
                if (frames != null) {
                    for (int f : frames) {
                        frameList.add(f);
                    }
                }
                out.add(new XaPresentationState.ReferencedImage(
                        seriesUid, img.getString(Tag.ReferencedSOPInstanceUID, ""), List.copyOf(frameList)));
            }
        }
        if (out.size() > 1) {
            // 「1 枚に当てる」前提で UI を作ると、残りが黙って捨てられる。
            warnings.add("multipleReferencedImages");
        }
        return List.copyOf(out);
    }

    private static XaPresentationState.Voi readVoi(Attributes ds, List<String> warnings) {
        Sequence seq = ds.getSequence(Tag.SoftcopyVOILUTSequence);
        if (seq == null || seq.isEmpty()) {
            return null;
        }
        Attributes item = seq.get(0);
        if (seq.size() > 1) {
            // 参照画像ごとに別の VOI を当てる書き方。先頭だけ使うと他が消える。
            warnings.add("multipleVoiItems");
        }
        double[] wc = item.getDoubles(Tag.WindowCenter);
        double[] ww = item.getDoubles(Tag.WindowWidth);
        if (wc == null || ww == null || wc.length == 0 || ww.length == 0) {
            if (item.contains(Tag.VOILUTSequence)) {
                // 🚨 LUT を W/L に「だいたい直す」ことはしない（別の絵になる）。
                warnings.add("voiLutData");
            }
            return null;
        }
        if (!(ww[0] > 0)) {
            return null;
        }
        return new XaPresentationState.Voi(wc[0], ww[0]);
    }

    private static XaPresentationState.Mask readMask(Attributes ds) {
        Sequence seq = ds.getSequence(Tag.MaskSubtractionSequence);
        if (seq == null || seq.isEmpty()) {
            return null;
        }
        Attributes m = seq.get(0);
        int[] maskFrames = m.getInts(Tag.MaskFrameNumbers);
        List<Integer> frames = new ArrayList<>();
        if (maskFrames != null) {
            for (int f : maskFrames) {
                frames.add(f);
            }
        }
        float[] shift = m.getFloats(Tag.MaskSubPixelShift);
        // MaskSubPixelShift は [row, column]。frontend の {dx=横, dy=縦} と並びが逆。
        double row = shift != null && shift.length > 0 ? shift[0] : 0;
        double col = shift != null && shift.length > 1 ? shift[1] : 0;
        int[] range = m.getInts(Tag.ApplicableFrameRange);
        Integer from = range != null && range.length > 0 ? range[0] : null;
        Integer to = range != null && range.length > 1 ? range[1] : null;
        return new XaPresentationState.Mask(
                List.copyOf(frames), row, col, m.getString(Tag.MaskOperation, "AVG_SUB"), from, to);
    }

    private static XaPresentationState.Calibration readCalibration(Attributes ds) {
        Sequence seq = ds.getSequence(Tag.DisplayedAreaSelectionSequence);
        if (seq == null || seq.isEmpty()) {
            return null;
        }
        double[] sp = seq.get(0).getDoubles(Tag.PresentationPixelSpacing);
        if (sp == null || sp.length < 2 || !(sp[0] > 0) || !(sp[1] > 0)) {
            return null;
        }
        return new XaPresentationState.Calibration(sp[0], sp[1]);
    }

    private static void readAnnotations(
            Attributes ds,
            List<XaPresentationState.Polyline> lines,
            List<XaPresentationState.TextAnnotation> texts,
            List<String> warnings) {
        Sequence anns = ds.getSequence(Tag.GraphicAnnotationSequence);
        if (anns == null) {
            return;
        }
        Set<String> skippedUnits = new LinkedHashSet<>();
        for (Attributes ann : anns) {
            String layer = ann.getString(Tag.GraphicLayer, "");
            Sequence objs = ann.getSequence(Tag.GraphicObjectSequence);
            if (objs != null) {
                for (Attributes g : objs) {
                    String units = g.getString(Tag.GraphicAnnotationUnits, "");
                    if (!"PIXEL".equalsIgnoreCase(units)) {
                        // DISPLAY / MATRIX は表示のジオメトリ依存。画素座標へは落とさない。
                        skippedUnits.add(units.isBlank() ? "UNKNOWN" : units);
                        continue;
                    }
                    float[] data = g.getFloats(Tag.GraphicData);
                    if (data == null || data.length < 2 || data.length % 2 != 0) {
                        continue;
                    }
                    List<Double> pts = new ArrayList<>(data.length);
                    for (float v : data) {
                        // PIXEL 単位（画素中心 1.0）→ 0 origin の画素座標。
                        pts.add(v - 0.5);
                    }
                    lines.add(new XaPresentationState.Polyline(
                            layer,
                            g.getString(Tag.GraphicType, "POLYLINE"),
                            List.copyOf(pts),
                            "Y".equalsIgnoreCase(g.getString(Tag.GraphicFilled, "N"))));
                }
            }
            Sequence tos = ann.getSequence(Tag.TextObjectSequence);
            if (tos != null) {
                for (Attributes t : tos) {
                    String text = t.getString(Tag.UnformattedTextValue, "");
                    if (text.isBlank()) {
                        continue;
                    }
                    float[] anchor = t.getFloats(Tag.AnchorPoint);
                    String units = t.getString(Tag.AnchorPointAnnotationUnits, "");
                    if (anchor == null || anchor.length < 2 || !"PIXEL".equalsIgnoreCase(units)) {
                        // 位置が決まらないテキストは**貼らない**（画像の別の場所に出るより良い）。
                        skippedUnits.add(units.isBlank() ? "UNKNOWN" : units);
                        continue;
                    }
                    texts.add(new XaPresentationState.TextAnnotation(
                            layer, text, anchor[0] - 0.5, anchor[1] - 0.5));
                }
            }
        }
        if (!skippedUnits.isEmpty()) {
            warnings.add("graphicUnits:" + String.join(",", skippedUnits));
        }
    }

    private static int normalizeRotation(int rot) {
        int v = ((rot % 360) + 360) % 360;
        return switch (v) {
            case 90, 180, 270 -> v;
            default -> 0;
        };
    }
}

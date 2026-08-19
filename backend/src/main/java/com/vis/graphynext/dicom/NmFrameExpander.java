/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * NM（核医学）の古典マルチフレーム断層（SPECT）の per-frame 展開ロジック。
 *
 * <p><b>なぜ要るか</b>: 実データの定量 SPECT は <b>NM Image Storage の多フレーム 1 ファイル</b>で
 * 来ることが多い（{@code NumberOfFrames=48} / {@code NumberOfSlices=48} /
 * {@code SliceVector=1..48} / {@code ImageType=…\RECON TOMO\EMISSION}）。本体はシリーズの
 * スタックを<b>インスタンス単位</b>で組むため、これを 1 枚（動画扱い）として開いてしまい、
 * 48 スライスに触れなかった（2026-08-18 に実機で確認・線量評価プラグインの H28）。
 *
 * <p><b>展開の形</b>: SEG（{@link SegFrameExpander}）と同じく <b>フレーム = Z</b> に開く。
 * ゲート収集のように同じスライスが複数回現れる場合は、2 度目以降を T に送る
 * （XA シネの「ラン=Z・フレーム=T」とは別の軸割り当てで、断層は Z が空間軸である）。
 *
 * <p><b>幾何の出所</b>: NM Image IOD は <b>ルートに IPP/IOP を持たない</b>。位置は
 * {@code DetectorInformationSequence} の {@code ImagePositionPatient} /
 * {@code ImageOrientationPatient} にあり、スライス間隔は {@code SpacingBetweenSlices}
 * （無ければ {@code SliceThickness}）。ここから <b>フレームごとの IPP を法線方向に積んで作る</b>。
 *
 * <p><b>Rescale が無い</b>のも PET との違いで、値は原則カウントである（定量は施設の校正係数で行う）。
 * したがってここでは値を触らない。
 */
public final class NmFrameExpander {

    private NmFrameExpander() {
    }

    /** NM の断層マルチフレーム（＝ Z に展開すべきもの）か。 */
    public static boolean isNmTomo(Attributes ds) {
        if (ds == null) {
            return false;
        }
        if (!"NM".equalsIgnoreCase(String.valueOf(ds.getString(Tag.Modality, "")))) {
            return false;
        }
        if (ds.getInt(Tag.NumberOfFrames, 1) <= 1) {
            return false;
        }
        if (ds.getInt(Tag.NumberOfSlices, 0) > 1) {
            return true;
        }
        int[] sv = ds.getInts(Tag.SliceVector);
        if (sv != null && sv.length > 1) {
            return true;
        }
        String[] types = ds.getStrings(Tag.ImageType);
        if (types != null) {
            for (String t : types) {
                if (t != null && t.trim().equalsIgnoreCase("RECON TOMO")) {
                    return true;
                }
            }
        }
        return false;
    }

    /** 検出器情報（無ければルート）の IOP。 */
    public static double[] iop(Attributes ds) {
        Attributes det = firstDetector(ds);
        if (det != null) {
            double[] v = det.getDoubles(Tag.ImageOrientationPatient);
            if (v != null && v.length >= 6) {
                return v;
            }
        }
        return ds.getDoubles(Tag.ImageOrientationPatient);
    }

    /** 検出器情報（無ければルート）の IPP＝先頭フレームの位置。 */
    public static double[] originIpp(Attributes ds) {
        Attributes det = firstDetector(ds);
        if (det != null) {
            double[] v = det.getDoubles(Tag.ImagePositionPatient);
            if (v != null && v.length >= 3) {
                return v;
            }
        }
        return ds.getDoubles(Tag.ImagePositionPatient);
    }

    private static Attributes firstDetector(Attributes ds) {
        Sequence det = ds.getSequence(Tag.DetectorInformationSequence);
        return (det != null && !det.isEmpty()) ? det.get(0) : null;
    }

    /** スライス間隔 [mm]。SpacingBetweenSlices → SliceThickness の順（どちらも無ければ 0）。 */
    public static double sliceSpacing(Attributes ds) {
        double s = ds.getDouble(Tag.SpacingBetweenSlices, 0);
        if (s > 0) {
            return s;
        }
        return ds.getDouble(Tag.SliceThickness, 0);
    }

    /** スライス法線（IOP の行×列）。IOP が無ければ z 軸。 */
    private static double[] normal(double[] iop) {
        if (iop == null || iop.length < 6) {
            return new double[] { 0, 0, 1 };
        }
        double nx = iop[1] * iop[5] - iop[2] * iop[4];
        double ny = iop[2] * iop[3] - iop[0] * iop[5];
        double nz = iop[0] * iop[4] - iop[1] * iop[3];
        double len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len <= 0) {
            return new double[] { 0, 0, 1 };
        }
        return new double[] { nx / len, ny / len, nz / len };
    }

    /** フレーム i のスライス番号（0 始まり）。SliceVector があればそれに従う。 */
    public static int sliceIndexOf(Attributes ds, int frame) {
        int[] sv = ds.getInts(Tag.SliceVector);
        if (sv != null && frame >= 0 && frame < sv.length && sv[frame] > 0) {
            return sv[frame] - 1;
        }
        return frame;
    }

    /**
     * フレーム i の ImagePositionPatient。
     *
     * <p>★ <b>ここが H28 の核心</b>。NM は per-frame の IPP を持たないので、
     * 先頭位置 ＋ 法線 × 間隔 × スライス番号 で作る。作れなければ null を返し、
     * 呼び出し側は「空間シリーズではない」として扱う（<b>座標を捏造しない</b>）。
     */
    public static double[] frameIpp(Attributes ds, int frame) {
        double[] o = originIpp(ds);
        if (o == null || o.length < 3) {
            return null;
        }
        double spacing = sliceSpacing(ds);
        if (spacing <= 0) {
            return null;
        }
        double[] n = normal(iop(ds));
        int k = sliceIndexOf(ds, frame);
        return new double[] { o[0] + n[0] * spacing * k, o[1] + n[1] * spacing * k, o[2] + n[2] * spacing * k };
    }

    /**
     * NM 断層のマルチフレームを Z（＋同一スライスの繰り返しは T）に展開する。
     * 対象が無ければ null（呼び出し側は通常の経路へ落ちる）。
     */
    public static SeriesLayout layout(List<Attributes> instances) {
        if (instances == null || instances.isEmpty()) {
            return null;
        }
        List<Attributes> nm = new ArrayList<>();
        for (Attributes ds : instances) {
            if (isNmTomo(ds)) {
                nm.add(ds);
            }
        }
        if (nm.isEmpty()) {
            return null;
        }
        Attributes first = nm.get(0);
        int rows = first.getInt(Tag.Rows, 0);
        int cols = first.getInt(Tag.Columns, 0);
        if (rows <= 0 || cols <= 0) {
            return null;
        }
        double[] iop = iop(first);
        double[] ps = first.getDoubles(Tag.PixelSpacing);
        double pxRow = (ps != null && ps.length >= 2) ? ps[0] : 0;
        double pxCol = (ps != null && ps.length >= 2) ? ps[1] : 0;

        List<SeriesLayout.Cell> cells = new ArrayList<>();
        Map<Integer, double[]> zToIpp = new TreeMap<>();
        // 同じスライス番号が複数回来たら（ゲート収集など）2 度目以降を T に送る。
        Map<String, Integer> seen = new LinkedHashMap<>();
        int nZ = 0;
        int nT = 1;
        for (Attributes ds : nm) {
            String sop = ds.getString(Tag.SOPInstanceUID);
            if (sop == null || sop.isBlank()) {
                continue;
            }
            int frames = Math.max(1, ds.getInt(Tag.NumberOfFrames, 1));
            for (int i = 0; i < frames; i++) {
                int z = sliceIndexOf(ds, i);
                String key = sop + "#" + z;
                int t = seen.merge(key, 1, Integer::sum) - 1;
                cells.add(new SeriesLayout.Cell(0, z, t, sop, i));
                nZ = Math.max(nZ, z + 1);
                nT = Math.max(nT, t + 1);
                double[] ipp = frameIpp(ds, i);
                if (ipp != null && !zToIpp.containsKey(z)) {
                    zToIpp.put(z, ipp);
                }
            }
        }
        if (cells.isEmpty()) {
            return null;
        }
        List<SeriesLayout.ZSpatial> zSpatials = null;
        if (!zToIpp.isEmpty()) {
            zSpatials = new ArrayList<>();
            for (Map.Entry<Integer, double[]> e : zToIpp.entrySet()) {
                zSpatials.add(new SeriesLayout.ZSpatial(e.getKey(), e.getValue()));
            }
        }
        SeriesLayout.PixelFormat pf = new SeriesLayout.PixelFormat(
                first.getInt(Tag.BitsAllocated, 16),
                first.getInt(Tag.PixelRepresentation, 0),
                first.getInt(Tag.SamplesPerPixel, 1),
                first.getDouble(Tag.RescaleSlope, 1.0),
                first.getDouble(Tag.RescaleIntercept, 0.0));
        return new SeriesLayout(
                nZ, 1, nT, null, nT > 1 ? "Phase" : null, cells,
                iop, pxRow, pxCol, cols, rows, zSpatials,
                first.getString(Tag.FrameOfReferenceUID), pf, null);
    }

    /**
     * NM 断層マルチフレームの 1 フレームを単一フレーム DICOM として返す。
     *
     * <p>画素の切り出しと Part-10 の組み立ては {@link SegFrameExpander} と同じものを使い、
     * <b>幾何（IPP/IOP/スライス厚）だけをこちらで与える</b>（NM は per-frame の幾何を持たないため）。
     */
    public static byte[] extractFrame(Attributes ds, int frame) {
        if (!isNmTomo(ds)) {
            return null;
        }
        double spacing = sliceSpacing(ds);
        return SegFrameExpander.extractFrame(
                ds, frame, frameIpp(ds, frame), iop(ds), spacing > 0 ? spacing : null);
    }
}

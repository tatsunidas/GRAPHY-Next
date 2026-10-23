/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Enhanced CT / MR / PET のマルチフレーム（1 SOP に多数のスライス）を Z/C/T のボリュームへ展開する
 * （{@code fw/series-axes.md}）。これが無いと<b>先頭 1 フレームしか出ない</b>（従来経路は NumberOfFrames を見ない）。
 *
 * <p><b>判定は SOP クラスだけ</b>。Per-Frame Functional Groups の有無では決めない: 古典 MR（Hitachi 等）にも
 * PerFrameFunctionalGroups だけが付いたものがあり、それは従来経路で読めている。
 *
 * <p><b>回帰させない</b>: Enhanced でも 1 スライス = 1 ファイル（MR の VSRAD など。同じ SeriesInstanceUID に
 * 入る）は従来経路で読めている。<b>NumberOfFrames &gt; 1 の対象 SOP が 1 つも無ければ null</b>を返し、
 * 従来経路のままにする。
 *
 * <p><b>展開の形</b>: シリーズ内の全フレームを 1 つのプールにし、
 * <ul>
 *   <li>Z = フレームごとの ImagePositionPatient を ImageOrientationPatient の法線へ投影した位置</li>
 *   <li>T = FrameContent の TemporalPositionIndex</li>
 *   <li>C = DimensionIndexValues のうち、位置・スタック・時間を指さない成分の組（b 値・エコーなど）</li>
 * </ul>
 * 同じ位置のフレームを捨てない。<b>解釈できないときは null</b>（位置・向きが 1 フレームでも読めない、
 * 向きが揃わない、StackID が複数、同じ (c,z,t) に 2 フレーム）。0 や推測で埋めない。
 *
 * <p>画像は {@code &frame=N+1} のローダー切り出しで読む（{@link SeriesLayout.Axes#loaderFrames()}）。
 * 値の変換（PixelValueTransformation）・位置・窓は Functional Groups にあり、サーバー切り出し
 * （{@link SegFrameExpander#extractFrame}）はそれを読まない。
 *
 * <p>🚨 standalone（DicomStorageService）と web（SeriesLayoutAssembler）の<b>両方</b>に、同じ順で繋ぐこと。
 */
public final class EnhancedMultiframeExpander {

    private EnhancedMultiframeExpander() {
    }

    /**
     * Enhanced CT / MR / MR Color / PET と、Legacy Converted Enhanced CT / MR / PET の Image Storage。
     * UID は記憶でなく dcm4che の定数から取る（実サンプルの eCT_Supplemental が 2.1 で、2.2 は Legacy Converted だった）。
     * MR Spectroscopy（4.2）はスライスでないので含めない。
     */
    private static final Set<String> SOP_CLASSES = Set.of(
            UID.EnhancedCTImageStorage,
            UID.LegacyConvertedEnhancedCTImageStorage,
            UID.EnhancedMRImageStorage,
            UID.EnhancedMRColorImageStorage,
            UID.LegacyConvertedEnhancedMRImageStorage,
            UID.EnhancedPETImageStorage,
            UID.LegacyConvertedEnhancedPETImageStorage);

    private static final double IOP_TOLERANCE = 1e-3;

    static boolean isEnhanced(Attributes ds) {
        return ds != null && SOP_CLASSES.contains(ds.getString(Tag.SOPClassUID));
    }

    private static Attributes shared(Attributes ds) {
        Sequence s = ds.getSequence(Tag.SharedFunctionalGroupsSequence);
        return s == null || s.isEmpty() ? null : s.get(0);
    }

    private static Attributes perFrame(Attributes ds, int frame) {
        Sequence s = ds.getSequence(Tag.PerFrameFunctionalGroupsSequence);
        return s == null || frame >= s.size() ? null : s.get(frame);
    }

    /** フレーム → 共有の順で、機能グループの入れ子 1 件目を探す。 */
    private static Attributes group(Attributes ds, int frame, int sequenceTag) {
        Attributes pf = perFrame(ds, frame);
        Attributes g = pf == null ? null : pf.getNestedDataset(sequenceTag);
        if (g == null) {
            Attributes sh = shared(ds);
            g = sh == null ? null : sh.getNestedDataset(sequenceTag);
        }
        return g;
    }

    private static double[] ipp(Attributes ds, int frame) {
        Attributes g = group(ds, frame, Tag.PlanePositionSequence);
        double[] v = g == null ? null : g.getDoubles(Tag.ImagePositionPatient);
        return v != null && v.length >= 3 ? v : null;
    }

    private static double[] iop(Attributes ds, int frame) {
        Attributes g = group(ds, frame, Tag.PlaneOrientationSequence);
        double[] v = g == null ? null : g.getDoubles(Tag.ImageOrientationPatient);
        return v != null && v.length >= 6 ? v : null;
    }

    /** DimensionIndexSequence の各成分が何を指すか（DimensionIndexValues の並びと同じ順）。 */
    private static int[] dimensionPointers(Attributes ds) {
        Sequence seq = ds.getSequence(Tag.DimensionIndexSequence);
        if (seq == null) {
            return new int[0];
        }
        int[] out = new int[seq.size()];
        for (int i = 0; i < out.length; i++) {
            out[i] = seq.get(i).getInt(Tag.DimensionIndexPointer, 0);
        }
        return out;
    }

    /** 位置・スタック・時間を指す成分は C に使わない（それぞれ Z・T で扱う）。 */
    private static boolean isOtherDimension(int pointer) {
        return pointer != Tag.ImagePositionPatient
                && pointer != Tag.StackID
                && pointer != Tag.InStackPositionNumber
                && pointer != Tag.TemporalPositionIndex
                && pointer != Tag.ImageOrientationPatient;
    }

    private static double[] normal(double[] iop) {
        double nx = iop[1] * iop[5] - iop[2] * iop[4];
        double ny = iop[2] * iop[3] - iop[0] * iop[5];
        double nz = iop[0] * iop[4] - iop[1] * iop[3];
        double len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        return len > 0 ? new double[] { nx / len, ny / len, nz / len } : null;
    }

    private record Frame(String sop, int frame, long zKey, double[] ipp, int t, List<Integer> cKey) {
    }

    /**
     * Enhanced 多フレームのレイアウトを組む。展開しないとき（対象が無い・全 SOP が 1 フレーム・混在・
     * 解釈できない）は null（＝従来経路へ）。
     *
     * @param headers シリーズ内各インスタンスのヘッダ（ピクセル無しで可。Functional Groups を含むこと）
     */
    public static SeriesLayout layout(List<Attributes> headers) {
        if (headers == null || headers.isEmpty()) {
            return null;
        }
        List<Attributes> enhanced = new ArrayList<>();
        boolean multiFrame = false;
        for (Attributes ds : headers) {
            if (ds == null) {
                continue;
            }
            if (!isEnhanced(ds)) {
                return null; // 非対象が混ざるシリーズは、軸の意味を壊さないよう従来経路のまま
            }
            enhanced.add(ds);
            multiFrame |= ds.getInt(Tag.NumberOfFrames, 1) > 1;
        }
        if (enhanced.isEmpty() || !multiFrame) {
            return null; // 全 SOP が 1 フレーム（VSRAD 型）は従来経路で読めている
        }
        enhanced.sort(Comparator
                .comparingInt((Attributes a) -> a.getInt(Tag.InstanceNumber, 0))
                .thenComparing(a -> nullToEmpty(a.getString(Tag.SOPInstanceUID))));

        Attributes first = enhanced.get(0);
        int rows = first.getInt(Tag.Rows, 0);
        int cols = first.getInt(Tag.Columns, 0);
        double[] seriesIop = iop(first, 0);
        double[] nrm = seriesIop == null ? null : normal(seriesIop);
        if (rows <= 0 || cols <= 0 || nrm == null) {
            return null;
        }

        List<Frame> frames = new ArrayList<>();
        TreeSet<Integer> stackIds = new TreeSet<>();
        for (Attributes ds : enhanced) {
            String sop = ds.getString(Tag.SOPInstanceUID);
            if (sop == null || sop.isBlank()) {
                return null;
            }
            int nf = Math.max(1, ds.getInt(Tag.NumberOfFrames, 1));
            int[] pointers = dimensionPointers(ds);
            for (int i = 0; i < nf; i++) {
                double[] p = ipp(ds, i);
                double[] o = iop(ds, i);
                if (p == null || o == null) {
                    return null;
                }
                for (int k = 0; k < 6; k++) {
                    if (Math.abs(o[k] - seriesIop[k]) > IOP_TOLERANCE) {
                        return null; // 向きが違うフレームは 1 つのボリュームにならない
                    }
                }
                Attributes fc = group(ds, i, Tag.FrameContentSequence);
                int t = fc == null ? 1 : Math.max(1, fc.getInt(Tag.TemporalPositionIndex, 1));
                if (fc != null && fc.contains(Tag.StackID)) {
                    stackIds.add(fc.getInt(Tag.StackID, 0));
                }
                List<Integer> cKey = new ArrayList<>();
                int[] values = fc == null ? null : fc.getInts(Tag.DimensionIndexValues);
                if (values != null && values.length == pointers.length) {
                    for (int k = 0; k < pointers.length; k++) {
                        if (isOtherDimension(pointers[k])) {
                            cKey.add(values[k]);
                        }
                    }
                }
                double z = p[0] * nrm[0] + p[1] * nrm[1] + p[2] * nrm[2];
                frames.add(new Frame(sop, i, Math.round(z * 1000), p, t, cKey));
            }
        }
        if (stackIds.size() > 1) {
            return null; // 複数スタックは積み方が決まらない
        }

        TreeMap<Long, Integer> zIndex = new TreeMap<>();
        TreeSet<Integer> ts = new TreeSet<>();
        TreeSet<List<Integer>> cs = new TreeSet<>((a, b) -> Arrays.compare(
                a.stream().mapToInt(Integer::intValue).toArray(),
                b.stream().mapToInt(Integer::intValue).toArray()));
        for (Frame f : frames) {
            zIndex.putIfAbsent(f.zKey(), 0);
            ts.add(f.t());
            cs.add(f.cKey());
        }
        int k = 0;
        for (Map.Entry<Long, Integer> e : zIndex.entrySet()) {
            e.setValue(k++);
        }
        List<Integer> tList = new ArrayList<>(ts);
        List<List<Integer>> cList = new ArrayList<>(cs);

        List<SeriesLayout.Cell> cells = new ArrayList<>();
        Map<Integer, double[]> zToIpp = new TreeMap<>();
        Set<String> seen = new HashSet<>();
        for (Frame f : frames) {
            int z = zIndex.get(f.zKey());
            int c = cList.indexOf(f.cKey());
            int t = tList.indexOf(f.t());
            if (!seen.add(c + "/" + z + "/" + t)) {
                return null; // 同じ (c,z,t) に 2 フレーム: 次元の意味を読み切れていない。捨てずに展開をやめる
            }
            cells.add(new SeriesLayout.Cell(c, z, t, f.sop(), f.frame()));
            zToIpp.putIfAbsent(z, f.ipp());
        }
        List<SeriesLayout.ZSpatial> zSpatial = new ArrayList<>();
        for (Map.Entry<Integer, double[]> e : zToIpp.entrySet()) {
            zSpatial.add(new SeriesLayout.ZSpatial(e.getKey(), e.getValue()));
        }
        double[] ps = SegFrameExpander.sharedPixelSpacing(first);
        Attributes pvt = group(first, 0, Tag.PixelValueTransformationSequence);
        SeriesLayout.PixelFormat pf = first.getInt(Tag.BitsAllocated, 0) <= 0 ? null
                : new SeriesLayout.PixelFormat(
                        first.getInt(Tag.BitsAllocated, 0),
                        first.getInt(Tag.PixelRepresentation, 0),
                        Math.max(1, first.getInt(Tag.SamplesPerPixel, 1)),
                        pvt == null ? 1.0 : pvt.getDouble(Tag.RescaleSlope, 1.0),
                        pvt == null ? 0.0 : pvt.getDouble(Tag.RescaleIntercept, 0.0));
        SeriesLayout.Axes axes = new SeriesLayout.Axes(null, null, null, "z", true);
        return new SeriesLayout(
                zIndex.size(), cList.size(), tList.size(),
                cList.size() > 1 ? "Dimension" : null, tList.size() > 1 ? "Temporal" : null, cells,
                seriesIop, ps != null && ps.length >= 2 ? ps[0] : 0, ps != null && ps.length >= 2 ? ps[1] : 0,
                cols, rows, zSpatial, first.getString(Tag.FrameOfReferenceUID), pf, axes);
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}

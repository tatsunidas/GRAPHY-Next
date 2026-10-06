/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.util.UIDUtils;

/**
 * Parametric Map（Float Pixel Data）の展開（fw/nifti-import.md §3.1）。
 *
 * <p><b>なぜ要るか</b>: 整数でない浮動小数の画像（ADC・T1 マップ・SUV など）を誤差なく持てる標準の画像 IOD は
 * Parametric Map だけで、幾何は Functional Groups に、画素は Float Pixel Data (7FE0,0008) に入る。
 * 本体のスタックはトップレベルの IPP と PixelData を前提にしているので、そのままだと
 * <b>幾何なしの 1 枚</b>に見え、フレームも切り出せない。
 *
 * <p><b>展開の形</b>: NIfTI 取り込みは <b>1 インスタンス 1 フレーム</b>で書く（300 MB の 1 ファイルにしない）が、
 * 多フレームの PM も受けられるように、フレーム単位で並べる。Z は PlanePosition の IPP を IOP の法線へ
 * 投影した位置、T は FrameContent の TemporalPositionIndex、C は AcquisitionNumber。
 *
 * <p><b>切り出した単一フレーム</b>は、表示側（cornerstone dicom-image-loader 3.33.5）が float として読める形にする:
 * Float Pixel Data・BitsAllocated 32・<b>PixelRepresentation を書かない</b>（書くと 0 で Uint32、1 で Int32 と
 * 読まれる）。値は RealWorldValueMapping の傾き・切片で実際の量に直したうえで、Rescale は傾き 1・切片 0、
 * 単位は RescaleType に写す（フロントの単位の判定が RescaleType を見る）。
 *
 * <p>🚨 展開器は standalone（DicomStorageService）と web（SeriesLayoutAssembler・StudyController）の
 * <b>両方</b>に繋ぐこと（片方だけだと実機で 1 枚しか出ない）。
 */
public final class ParametricMapFrameExpander {

    private ParametricMapFrameExpander() {
    }

    /** Parametric Map か（SOP Class で判定する。ヘッダだけを読むと Float Pixel Data は除かれているため）。 */
    public static boolean isParametricMap(Attributes ds) {
        return ds != null && UID.ParametricMapStorage.equals(ds.getString(Tag.SOPClassUID));
    }

    private static Attributes sharedItem(Attributes ds) {
        Sequence s = ds.getSequence(Tag.SharedFunctionalGroupsSequence);
        return s == null || s.isEmpty() ? null : s.get(0);
    }

    private static Attributes perFrameItem(Attributes ds, int frame) {
        Sequence s = ds.getSequence(Tag.PerFrameFunctionalGroupsSequence);
        return s == null || frame >= s.size() ? null : s.get(frame);
    }

    /** そのフレームの FrameContent の TemporalPositionIndex（1 始まり）。無ければ 1。 */
    private static int temporalIndex(Attributes ds, int frame) {
        Attributes pf = perFrameItem(ds, frame);
        Attributes fc = pf == null ? null : pf.getNestedDataset(Tag.FrameContentSequence);
        return fc == null ? 1 : Math.max(1, fc.getInt(Tag.TemporalPositionIndex, 1));
    }

    private static double[] normal(double[] iop) {
        return new double[] {
            iop[1] * iop[5] - iop[2] * iop[4],
            iop[2] * iop[3] - iop[0] * iop[5],
            iop[0] * iop[4] - iop[1] * iop[3] };
    }

    /** 共有の PixelMeasures の SliceThickness（無ければ null）。 */
    private static Double sliceThickness(Attributes ds) {
        Attributes sh = sharedItem(ds);
        Attributes pm = sh == null ? null : sh.getNestedDataset(Tag.PixelMeasuresSequence);
        if (pm == null || !pm.contains(Tag.SliceThickness)) {
            return null;
        }
        double v = pm.getDouble(Tag.SliceThickness, 0);
        return v > 0 ? v : null;
    }

    /**
     * Parametric Map のシリーズをフレーム単位に並べる。対象でなければ null（呼び出し側は通常の経路へ）。
     */
    public static SeriesLayout layout(List<Attributes> instances) {
        if (instances == null || instances.isEmpty()) {
            return null;
        }
        List<Attributes> pm = new ArrayList<>();
        for (Attributes ds : instances) {
            if (isParametricMap(ds)) {
                pm.add(ds);
            }
        }
        if (pm.isEmpty()) {
            return null;
        }
        Attributes first = pm.get(0);
        int rows = first.getInt(Tag.Rows, 0);
        int cols = first.getInt(Tag.Columns, 0);
        double[] iop = SegFrameExpander.sharedIop(first);
        if (rows <= 0 || cols <= 0 || iop == null || iop.length < 6) {
            return null;
        }
        double[] nrm = normal(iop);
        double[] ps = SegFrameExpander.sharedPixelSpacing(first);
        record F(String sop, int frame, double z, double[] ipp, int t, int c) {
        }
        List<F> frames = new ArrayList<>();
        TreeSet<Integer> ts = new TreeSet<>();
        TreeSet<Integer> csx = new TreeSet<>();
        for (Attributes ds : pm) {
            String sop = ds.getString(Tag.SOPInstanceUID);
            if (sop == null || sop.isBlank()) {
                continue;
            }
            int nf = Math.max(1, ds.getInt(Tag.NumberOfFrames, 1));
            int c = ds.getInt(Tag.AcquisitionNumber, 1);
            for (int i = 0; i < nf; i++) {
                double[] ipp = SegFrameExpander.perFrameIpp(ds, i);
                if (ipp == null || ipp.length < 3) {
                    return null; // 幾何の無い PM はこの展開器では扱わない（通常の経路で 1 枚として出る）
                }
                double z = ipp[0] * nrm[0] + ipp[1] * nrm[1] + ipp[2] * nrm[2];
                int t = temporalIndex(ds, i);
                frames.add(new F(sop, i, z, ipp, t, c));
                ts.add(t);
                csx.add(c);
            }
        }
        if (frames.isEmpty()) {
            return null;
        }
        // Z: 位置（mm）を 1/1000 mm で丸めて同じ位置をまとめ、昇順に番号を振る
        TreeMap<Long, Integer> zIndex = new TreeMap<>();
        for (F f : frames) {
            zIndex.putIfAbsent(Math.round(f.z() * 1000), 0);
        }
        int k = 0;
        for (Map.Entry<Long, Integer> e : zIndex.entrySet()) {
            e.setValue(k++);
        }
        List<Integer> tList = new ArrayList<>(ts);
        List<Integer> cList = new ArrayList<>(csx);
        List<SeriesLayout.Cell> cells = new ArrayList<>();
        Map<Integer, double[]> zToIpp = new TreeMap<>();
        for (F f : frames) {
            int z = zIndex.get(Math.round(f.z() * 1000));
            cells.add(new SeriesLayout.Cell(cList.indexOf(f.c()), z, tList.indexOf(f.t()), f.sop(), f.frame()));
            zToIpp.putIfAbsent(z, f.ipp());
        }
        List<SeriesLayout.ZSpatial> zSpatial = new ArrayList<>();
        for (Map.Entry<Integer, double[]> e : zToIpp.entrySet()) {
            zSpatial.add(new SeriesLayout.ZSpatial(e.getKey(), e.getValue()));
        }
        // 値は切り出すときに実際の量へ直すので、表示側から見た形式は「32 bit float・傾き 1」
        SeriesLayout.PixelFormat pf = new SeriesLayout.PixelFormat(32, 0, 1, 1.0, 0.0);
        return new SeriesLayout(
                zIndex.size(), cList.size(), tList.size(),
                cList.size() > 1 ? "Acq" : null, tList.size() > 1 ? "Temporal" : null, cells,
                iop, ps != null && ps.length >= 2 ? ps[0] : 0, ps != null && ps.length >= 2 ? ps[1] : 0,
                cols, rows, zSpatial, first.getString(Tag.FrameOfReferenceUID), pf, null);
    }

    /**
     * 抜けたスライスを埋める空白の 1 フレーム（float・値は NaN＝「値が無い」。統計からも除かれる）。
     *
     * @param header シリーズの Parametric Map のヘッダ（画素なしでよい）
     * @param ipp    その位置（null なら先頭フレームの位置）
     */
    public static byte[] blankFrame(Attributes header, double[] ipp) {
        if (!isParametricMap(header)) {
            return null;
        }
        int rows = header.getInt(Tag.Rows, 0);
        int cols = header.getInt(Tag.Columns, 0);
        if (rows <= 0 || cols <= 0) {
            return null;
        }
        Attributes ds = new Attributes(header);
        ds.remove(Tag.PixelData);
        ds.setInt(Tag.NumberOfFrames, VR.IS, 1);
        ds.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        ds.setInt(Tag.InstanceNumber, VR.IS, 0);
        if (ipp != null && ipp.length == 3) {
            Attributes pp = new Attributes();
            pp.setDouble(Tag.ImagePositionPatient, VR.DS, ipp);
            Attributes frame = new Attributes();
            frame.newSequence(Tag.PlanePositionSequence, 1).add(pp);
            ds.newSequence(Tag.PerFrameFunctionalGroupsSequence, 1).add(frame);
        }
        ByteBuffer nan = ByteBuffer.allocate(rows * cols * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < rows * cols; i++) {
            nan.putFloat(Float.NaN);
        }
        ds.setBytes(Tag.FloatPixelData, VR.OF, nan.array());
        return extractFrame(ds, 0);
    }

    /** RealWorldValueMapping（共有 → そのフレーム → ルートの順）。無ければ null。 */
    private static Attributes rwvm(Attributes ds, int frame) {
        for (Attributes holder : new Attributes[] { sharedItem(ds), perFrameItem(ds, frame), ds }) {
            if (holder != null) {
                Attributes m = holder.getNestedDataset(Tag.RealWorldValueMappingSequence);
                if (m != null) {
                    return m;
                }
            }
        }
        return null;
    }

    /** RWVM の単位（UCUM のコード）。単位なし・不明は空文字。 */
    public static String unitOf(Attributes mapping) {
        if (mapping == null) {
            return "";
        }
        Attributes u = mapping.getNestedDataset(Tag.MeasurementUnitsCodeSequence);
        if (u == null) {
            return "";
        }
        String code = u.getString(Tag.CodeValue, "");
        // UCUM の「1」は無次元（単位なし）。表示では空にする
        return "1".equals(code) ? "" : code;
    }

    /**
     * 1 フレームを、トップレベルに幾何を持つ単一フレーム（Float Pixel Data）として返す。
     * 値は RWVM で実際の量に直す（傾き 1・切片 0 なら値はそのまま）。NaN はそのまま残す。
     *
     * @param ds 画素（Float Pixel Data）まで読んだデータセット
     */
    public static byte[] extractFrame(Attributes ds, int frame) {
        if (!isParametricMap(ds)) {
            return null;
        }
        int rows = ds.getInt(Tag.Rows, 0);
        int cols = ds.getInt(Tag.Columns, 0);
        int nf = Math.max(1, ds.getInt(Tag.NumberOfFrames, 1));
        if (rows <= 0 || cols <= 0 || frame < 0 || frame >= nf) {
            return null;
        }
        int n = rows * cols;
        float[] v = new float[n];
        try {
            byte[] fp = ds.getBytes(Tag.FloatPixelData);
            if (fp != null) {
                ByteBuffer b = ByteBuffer.wrap(fp).order(ds.bigEndian() ? ByteOrder.BIG_ENDIAN : ByteOrder.LITTLE_ENDIAN);
                long off = (long) frame * n * 4;
                if (off + (long) n * 4 > fp.length) {
                    return null;
                }
                for (int i = 0; i < n; i++) {
                    v[i] = b.getFloat((int) (off + (long) i * 4));
                }
            } else {
                byte[] dp = ds.getBytes(Tag.DoubleFloatPixelData);
                if (dp == null) {
                    return null;
                }
                // 表示側は 64 bit float を読めないので 32 bit にする（精度は相対 6e-8 程度落ちる）
                ByteBuffer b = ByteBuffer.wrap(dp).order(ds.bigEndian() ? ByteOrder.BIG_ENDIAN : ByteOrder.LITTLE_ENDIAN);
                long off = (long) frame * n * 8;
                if (off + (long) n * 8 > dp.length) {
                    return null;
                }
                for (int i = 0; i < n; i++) {
                    v[i] = (float) b.getDouble((int) (off + (long) i * 8));
                }
            }
        } catch (IOException e) {
            return null;
        }
        Attributes mapping = rwvm(ds, frame);
        double slope = mapping == null ? 1.0 : mapping.getDouble(Tag.RealWorldValueSlope, 1.0);
        double intercept = mapping == null ? 0.0 : mapping.getDouble(Tag.RealWorldValueIntercept, 0.0);
        float min = Float.POSITIVE_INFINITY;
        float max = Float.NEGATIVE_INFINITY;
        for (int i = 0; i < n; i++) {
            if (slope != 1.0 || intercept != 0.0) {
                v[i] = (float) (v[i] * slope + intercept);
            }
            if (Float.isFinite(v[i])) {
                min = Math.min(min, v[i]);
                max = Math.max(max, v[i]);
            }
        }
        ByteBuffer outPx = ByteBuffer.allocate(n * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (float f : v) {
            outPx.putFloat(f);
        }

        Attributes out = new Attributes();
        out.setString(Tag.SpecificCharacterSet, VR.CS, ds.getString(Tag.SpecificCharacterSet, "ISO_IR 192"));
        out.setString(Tag.SOPClassUID, VR.UI, UID.SecondaryCaptureImageStorage);
        // フレームごとに決まった UID（親 SOP ＋ フレーム番号）。SegFrameExpander と同じ約束
        String parentSop = ds.getString(Tag.SOPInstanceUID);
        String derived = (parentSop == null || parentSop.isBlank()) ? null : parentSop + "." + (frame + 1);
        out.setString(Tag.SOPInstanceUID, VR.UI, derived != null && derived.length() <= 64 ? derived : UIDUtils.createUID());
        for (int tag : new int[] { Tag.StudyInstanceUID, Tag.SeriesInstanceUID, Tag.FrameOfReferenceUID,
                Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex, Tag.StudyDate, Tag.StudyTime,
                Tag.StudyDescription, Tag.SeriesDescription, Tag.SeriesNumber, Tag.AccessionNumber }) {
            if (ds.contains(tag)) {
                out.setString(tag, ds.getVR(tag), ds.getStrings(tag));
            }
        }
        out.setString(Tag.Modality, VR.CS, ds.getString(Tag.Modality, "OT"));
        out.setInt(Tag.InstanceNumber, VR.IS, ds.getInt(Tag.InstanceNumber, frame + 1));
        out.setInt(Tag.Rows, VR.US, rows);
        out.setInt(Tag.Columns, VR.US, cols);
        out.setInt(Tag.SamplesPerPixel, VR.US, 1);
        out.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        out.setInt(Tag.BitsAllocated, VR.US, 32);
        // ★ PixelRepresentation・BitsStored・HighBit は書かない（Float Pixel Data には無い属性。
        //   書くと表示側が整数として読む）
        double[] ipp = SegFrameExpander.perFrameIpp(ds, frame);
        double[] iop = SegFrameExpander.sharedIop(ds);
        double[] psp = SegFrameExpander.sharedPixelSpacing(ds);
        if (ipp != null) out.setDouble(Tag.ImagePositionPatient, VR.DS, ipp);
        if (iop != null && iop.length == 6) out.setDouble(Tag.ImageOrientationPatient, VR.DS, iop);
        if (psp != null && psp.length >= 2) out.setDouble(Tag.PixelSpacing, VR.DS, psp);
        Double st = sliceThickness(ds);
        if (st != null) {
            out.setDouble(Tag.SliceThickness, VR.DS, st);
        }
        // 値はもう実際の量なので傾き 1・切片 0。単位は RescaleType（フロントの単位の判定が見る）
        out.setDouble(Tag.RescaleSlope, VR.DS, 1.0);
        out.setDouble(Tag.RescaleIntercept, VR.DS, 0.0);
        out.setString(Tag.RescaleType, VR.LO, unitOf(mapping));
        if (min <= max) {
            double width = Math.max(max - min, Math.ulp(Math.max(Math.abs(min), Math.abs(max))) * 2);
            out.setDouble(Tag.WindowCenter, VR.DS, min + (max - min) / 2.0);
            out.setDouble(Tag.WindowWidth, VR.DS, width);
        }
        out.setBytes(Tag.FloatPixelData, VR.OF, outPx.array());
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream(n * 4 + 4096);
            Attributes fmi = out.createFileMetaInformation(UID.ExplicitVRLittleEndian);
            try (org.dcm4che3.io.DicomOutputStream dos = new org.dcm4che3.io.DicomOutputStream(bos, UID.ExplicitVRLittleEndian)) {
                dos.writeDataset(fmi, out);
            }
            return bos.toByteArray();
        } catch (IOException e) {
            return null;
        }
    }
}

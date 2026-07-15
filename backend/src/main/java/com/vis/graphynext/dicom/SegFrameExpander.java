/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.util.UIDUtils;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * DICOM SEG（マルチフレーム Segmentation Storage）の per-frame 展開ロジック。standalone
 * ({@code DicomStorageService}) と web ({@code SeriesLayoutAssembler}/{@code StudyController}) の
 * 両モードから共有し、モード間でスライス数の解釈が食い違わないようにする（各セグメント=C・各スライス=Z）。
 * GRAPHY Praparat 準拠（ReferencedSegmentNumber→C、PlanePositionSequence の IPP→Z）。
 */
public final class SegFrameExpander {

    private SegFrameExpander() {
    }

    /** DICOM Segmentation Storage の SOP Class。 */
    public static final String SOP_CLASS_SEG = "1.2.840.10008.5.1.4.1.1.66.4";

    /** SEG（per-frame に SegmentIdentificationSequence を持つマルチフレーム）か。 */
    public static boolean isSegDataset(Attributes ds) {
        if (ds == null) {
            return false;
        }
        if (SOP_CLASS_SEG.equals(ds.getString(Tag.SOPClassUID))) {
            return true;
        }
        Sequence pf = ds.getSequence(Tag.PerFrameFunctionalGroupsSequence);
        return pf != null && !pf.isEmpty() && pf.get(0).getNestedDataset(Tag.SegmentIdentificationSequence) != null;
    }

    /** 共有(なければ先頭フレーム/ルート) の ImageOrientationPatient。 */
    public static double[] sharedIop(Attributes ds) {
        Sequence sh = ds.getSequence(Tag.SharedFunctionalGroupsSequence);
        if (sh != null && !sh.isEmpty()) {
            Attributes po = sh.get(0).getNestedDataset(Tag.PlaneOrientationSequence);
            if (po != null) {
                double[] v = po.getDoubles(Tag.ImageOrientationPatient);
                if (v != null && v.length >= 6) return v;
            }
        }
        Sequence pf = ds.getSequence(Tag.PerFrameFunctionalGroupsSequence);
        if (pf != null && !pf.isEmpty()) {
            Attributes po = pf.get(0).getNestedDataset(Tag.PlaneOrientationSequence);
            if (po != null) {
                double[] v = po.getDoubles(Tag.ImageOrientationPatient);
                if (v != null && v.length >= 6) return v;
            }
        }
        return ds.getDoubles(Tag.ImageOrientationPatient);
    }

    /** 共有(なければルート) の PixelSpacing。 */
    public static double[] sharedPixelSpacing(Attributes ds) {
        Sequence sh = ds.getSequence(Tag.SharedFunctionalGroupsSequence);
        if (sh != null && !sh.isEmpty()) {
            Attributes pm = sh.get(0).getNestedDataset(Tag.PixelMeasuresSequence);
            if (pm != null) {
                double[] v = pm.getDoubles(Tag.PixelSpacing);
                if (v != null && v.length >= 2) return v;
            }
        }
        return ds.getDoubles(Tag.PixelSpacing);
    }

    /** 指定フレームの PlanePositionSequence > ImagePositionPatient。無ければ null。 */
    public static double[] perFrameIpp(Attributes ds, int frame) {
        Sequence pf = ds.getSequence(Tag.PerFrameFunctionalGroupsSequence);
        if (pf != null && frame >= 0 && frame < pf.size()) {
            Attributes pp = pf.get(frame).getNestedDataset(Tag.PlanePositionSequence);
            if (pp != null) {
                double[] v = pp.getDoubles(Tag.ImagePositionPatient);
                if (v != null && v.length >= 3) return v;
            }
        }
        return null;
    }

    /**
     * SEG ヘッダ群（{@link #isSegDataset} が true の Attributes。各々 NumberOfFrames/
     * PerFrameFunctionalGroupsSequence を保持していること）を per-frame 解析し、各セグメント=C・
     * 各スライス=Z の {@link SeriesLayout} に展開する。SEG でなければ（空/Rows・Columns 欠落なら）null。
     */
    public static SeriesLayout layout(List<Attributes> segHeaders) {
        if (segHeaders == null || segHeaders.isEmpty()) {
            return null;
        }
        Attributes first = segHeaders.get(0);
        int rows = first.getInt(Tag.Rows, 0);
        int cols = first.getInt(Tag.Columns, 0);
        if (rows <= 0 || cols <= 0) {
            return null;
        }
        double[] iop = sharedIop(first);
        double[] ps = sharedPixelSpacing(first);
        double pxRow = (ps != null && ps.length >= 2) ? ps[0] : 0;
        double pxCol = (ps != null && ps.length >= 2) ? ps[1] : 0;
        double nx = 0, ny = 0, nz = 1;
        if (iop != null && iop.length == 6) {
            double tnx = iop[1] * iop[5] - iop[2] * iop[4];
            double tny = iop[2] * iop[3] - iop[0] * iop[5];
            double tnz = iop[0] * iop[4] - iop[1] * iop[3];
            double len = Math.sqrt(tnx * tnx + tny * tny + tnz * tnz);
            if (len > 0) { nx = tnx / len; ny = tny / len; nz = tnz / len; }
        }

        record SF(String sop, int frame, double zpos, int segNum, double[] ipp) {
        }
        List<SF> sfs = new ArrayList<>();
        for (Attributes ds : segHeaders) {
            String sop = ds.getString(Tag.SOPInstanceUID);
            if (sop == null || sop.isBlank()) {
                continue;
            }
            int nf = ds.getInt(Tag.NumberOfFrames, 1);
            Sequence pf = ds.getSequence(Tag.PerFrameFunctionalGroupsSequence);
            for (int i = 0; i < nf; i++) {
                int segNum = 0;
                double[] ipp = null;
                if (pf != null && i < pf.size()) {
                    Attributes fr = pf.get(i);
                    Attributes segId = fr.getNestedDataset(Tag.SegmentIdentificationSequence);
                    if (segId != null) segNum = segId.getInt(Tag.ReferencedSegmentNumber, 0);
                    Attributes pp = fr.getNestedDataset(Tag.PlanePositionSequence);
                    if (pp != null) {
                        double[] v = pp.getDoubles(Tag.ImagePositionPatient);
                        if (v != null && v.length >= 3) ipp = v;
                    }
                }
                double zpos = (ipp != null) ? (ipp[0] * nx + ipp[1] * ny + ipp[2] * nz) : i;
                sfs.add(new SF(sop, i, zpos, segNum, ipp));
            }
        }
        if (sfs.isEmpty()) {
            return null;
        }
        // Z=スライス位置（量子化）、C=セグメント番号（昇順 rank）。
        TreeSet<Long> zKeys = new TreeSet<>();
        TreeSet<Integer> segSet = new TreeSet<>();
        for (SF s : sfs) { zKeys.add(Math.round(s.zpos() * 1000.0)); segSet.add(s.segNum()); }
        Map<Long, Integer> zIdx = new LinkedHashMap<>();
        int zi = 0;
        for (Long k : zKeys) zIdx.put(k, zi++);
        Map<Integer, Integer> cIdx = new LinkedHashMap<>();
        int ci = 0;
        for (Integer s : segSet) cIdx.put(s, ci++);
        int nZ = zKeys.size();
        int nC = segSet.size();

        List<SeriesLayout.Cell> cells = new ArrayList<>();
        Map<Integer, double[]> zToIpp = new TreeMap<>();
        for (SF s : sfs) {
            int z = zIdx.get(Math.round(s.zpos() * 1000.0));
            int c = cIdx.get(s.segNum());
            cells.add(new SeriesLayout.Cell(c, z, 0, s.sop(), s.frame()));
            if (s.ipp() != null && !zToIpp.containsKey(z)) zToIpp.put(z, s.ipp());
        }
        List<SeriesLayout.ZSpatial> zSpatials = null;
        if (!zToIpp.isEmpty()) {
            zSpatials = new ArrayList<>();
            for (var e : zToIpp.entrySet()) {
                zSpatials.add(new SeriesLayout.ZSpatial(e.getKey(), e.getValue()));
            }
        }
        return new SeriesLayout(
                nZ, nC, 1, nC > 1 ? "Seg" : null, null, cells,
                iop, pxRow, pxCol, cols, rows, zSpatials, first.getString(Tag.FrameOfReferenceUID));
    }

    /**
     * マルチフレーム DICOM（SEG/Enhanced、ピクセルデータ込みで読み込み済みの {@code ds}）の指定フレームを
     * 単一フレーム画像として返す。SEG BINARY(BitsAllocated=1) は連続 LSB-first ビット列を 8bit
     * マスク(0/255)へ展開、8/16bit はフレームブロックをそのままコピー。per-frame IPP・共有 IOP/PixelSpacing
     * を付与する。呼び出し側で転送構文が非圧縮であることを確認しておくこと。
     */
    public static byte[] extractFrame(Attributes ds, int frame) {
        int rows = ds.getInt(Tag.Rows, 0);
        int cols = ds.getInt(Tag.Columns, 0);
        int nf = ds.getInt(Tag.NumberOfFrames, 1);
        if (rows <= 0 || cols <= 0 || frame < 0 || frame >= nf) {
            return null;
        }
        int bits = ds.getInt(Tag.BitsAllocated, 8);
        byte[] px;
        try {
            px = ds.getBytes(Tag.PixelData);
        } catch (java.io.IOException e) {
            return null;
        }
        if (px == null) {
            return null;
        }
        int frameSize = rows * cols;
        boolean binary = (bits == 1);
        int outBits = binary ? 8 : bits;
        byte[] outPx;
        if (binary) {
            // BINARY SEG: 連続 LSB-first ビット。bit = frame*frameSize + p。
            outPx = new byte[frameSize];
            long base = (long) frame * frameSize;
            for (int p = 0; p < frameSize; p++) {
                long bit = base + p;
                int by = (int) (bit >> 3);
                int sh = (int) (bit & 7);
                if (by < px.length && ((px[by] >> sh) & 1) != 0) {
                    outPx[p] = (byte) 255;
                }
            }
        } else {
            int bps = Math.max(1, bits / 8);
            int off = frame * frameSize * bps;
            int len = frameSize * bps;
            outPx = new byte[len];
            int copy = Math.max(0, Math.min(len, px.length - off));
            if (off >= 0 && copy > 0) {
                System.arraycopy(px, off, outPx, 0, copy);
            }
        }

        double[] ipp = perFrameIpp(ds, frame);
        double[] iop = sharedIop(ds);
        double[] psp = sharedPixelSpacing(ds);

        Attributes out = new Attributes();
        out.setString(Tag.SOPClassUID, VR.UI, UID.SecondaryCaptureImageStorage);
        out.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        out.setString(Tag.StudyInstanceUID, VR.UI, ds.getString(Tag.StudyInstanceUID));
        out.setString(Tag.SeriesInstanceUID, VR.UI, ds.getString(Tag.SeriesInstanceUID));
        out.setString(Tag.Modality, VR.CS, ds.getString(Tag.Modality, "OT"));
        out.setInt(Tag.Rows, VR.US, rows);
        out.setInt(Tag.Columns, VR.US, cols);
        out.setInt(Tag.SamplesPerPixel, VR.US, 1);
        out.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        out.setInt(Tag.BitsAllocated, VR.US, outBits);
        out.setInt(Tag.BitsStored, VR.US, outBits);
        out.setInt(Tag.HighBit, VR.US, outBits - 1);
        out.setInt(Tag.PixelRepresentation, VR.US, binary ? 0 : ds.getInt(Tag.PixelRepresentation, 0));
        out.setInt(Tag.InstanceNumber, VR.IS, frame + 1);
        if (ipp != null) out.setDouble(Tag.ImagePositionPatient, VR.DS, ipp);
        if (iop != null && iop.length == 6) out.setDouble(Tag.ImageOrientationPatient, VR.DS, iop);
        if (psp != null && psp.length >= 2) out.setDouble(Tag.PixelSpacing, VR.DS, psp);
        if (binary) {
            out.setDouble(Tag.WindowCenter, VR.DS, 127.0);
            out.setDouble(Tag.WindowWidth, VR.DS, 255.0);
        } else {
            Double rs = readNumeric(ds, Tag.RescaleSlope);
            Double ri = readNumeric(ds, Tag.RescaleIntercept);
            if (rs != null) out.setDouble(Tag.RescaleSlope, VR.DS, rs);
            if (ri != null) out.setDouble(Tag.RescaleIntercept, VR.DS, ri);
        }
        out.setBytes(Tag.PixelData, outBits > 8 ? VR.OW : VR.OB, outPx);

        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream(outPx.length + 4096);
            Attributes fmi = out.createFileMetaInformation(UID.ExplicitVRLittleEndian);
            try (org.dcm4che3.io.DicomOutputStream dos =
                         new org.dcm4che3.io.DicomOutputStream(bos, UID.ExplicitVRLittleEndian)) {
                dos.writeDataset(fmi, out);
            }
            return bos.toByteArray();
        } catch (java.io.IOException e) {
            return null;
        }
    }

    private static Double readNumeric(Attributes ds, int tag) {
        if (!ds.contains(tag)) {
            return null;
        }
        String s = ds.getString(tag);
        if (s == null) {
            return null;
        }
        s = s.trim();
        if (s.isEmpty()) {
            return null;
        }
        try {
            return Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}

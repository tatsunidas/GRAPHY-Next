/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * {@code List<Attributes>}（DICOM ヘッダ集合）から classic 単一フレームの ZCT レイアウトを組む純関数。
 *
 * <p>web モードで {@link com.vis.graphynext.dicom.web.WebDicomDataService#seriesMetadata}（WADO-RS
 * {@code /metadata}）が返す全属性から、standalone と同じ {@link SeriesLayoutBuilder} を使って 5D(ZCT) を
 * 導出する。zpos/dims/spatial 抽出ロジックは standalone の {@code DicomStorageService.seriesLayout}
 * （classic 経路）と<b>同一</b>にしてある（並び・Z 投影・C/T 判定を一致させ、モード差で表示が変わらないように）。
 *
 * <p><b>非対応</b>: Siemens モザイクのデモザイク展開・DICOM SEG の per-frame 展開は含まない
 * （ピクセル/フレーム操作が要るため。standalone は {@code DicomStorageService} 側で先に処理する。
 * web は当面 classic 単一フレームのみ）。
 */
public final class SeriesLayoutAssembler {

    private SeriesLayoutAssembler() {
    }

    /** Attributes 列（各インスタンスの全属性）から ZCT レイアウトを組む。空なら noSpatial(0,0,0)。 */
    public static SeriesLayout fromAttributes(List<Attributes> instances) {
        List<SeriesLayoutBuilder.FrameMeta> frames = new ArrayList<>();
        double[] seriesIop = null;
        double seriesPxRow = 0, seriesPxCol = 0;
        int seriesWidth = 0, seriesHeight = 0;
        String seriesFor = null;
        Map<String, double[]> sopToIpp = new HashMap<>();
        // 複数オリエンテーション（3-plane localizer 等）は空間ボリュームでないため純スタックにする。
        Set<String> iopKeys = new LinkedHashSet<>();

        for (Attributes ds : instances) {
            if (ds == null) {
                continue;
            }
            String sop = ds.getString(Tag.SOPInstanceUID);
            if (sop == null || sop.isBlank()) {
                continue;
            }
            int instNo = ds.getInt(Tag.InstanceNumber, 0);
            double zpos = zPosition(ds, instNo);
            Map<String, Double> dims = new HashMap<>();
            putFirstPresent(dims, "Temporal", ds, Tag.TemporalPositionIdentifier, Tag.TemporalPositionIndex);
            putIfPresent(dims, "Trigger", ds, Tag.TriggerTime);
            putIfPresent(dims, "Echo", ds, Tag.EchoNumbers);
            putIfPresent(dims, "Bvalue", ds, Tag.DiffusionBValue);
            putIfPresent(dims, "EchoTime", ds, Tag.EchoTime);
            putComplexComponent(dims, ds);
            putIfPresent(dims, "Acq", ds, Tag.AcquisitionNumber);
            frames.add(new SeriesLayoutBuilder.FrameMeta(sop, instNo, zpos, dims));

            double[] ipp = ds.getDoubles(Tag.ImagePositionPatient);
            if (ipp != null && ipp.length >= 3) {
                sopToIpp.put(sop, ipp);
            }
            double[] iop = ds.getDoubles(Tag.ImageOrientationPatient);
            if (iop != null && iop.length >= 6) {
                iopKeys.add(iopKey(iop));
                if (seriesIop == null) {
                    seriesIop = iop;
                }
            }
            if (seriesPxRow == 0) {
                double[] ps = ds.getDoubles(Tag.PixelSpacing);
                if (ps != null && ps.length >= 2) {
                    seriesPxRow = ps[0];
                    seriesPxCol = ps[1];
                }
            }
            if (seriesWidth == 0) {
                int w = ds.getInt(Tag.Columns, 0);
                int h = ds.getInt(Tag.Rows, 0);
                if (w > 0 && h > 0) {
                    seriesWidth = w;
                    seriesHeight = h;
                }
            }
            if (seriesFor == null) {
                String fr = ds.getString(Tag.FrameOfReferenceUID);
                if (fr != null && !fr.isBlank()) {
                    seriesFor = fr;
                }
            }
        }

        if (frames.isEmpty()) {
            return SeriesLayout.noSpatial(0, 0, 0, null, null, List.of());
        }

        boolean mixedOrientation = iopKeys.size() > 1;
        if (mixedOrientation) {
            List<SeriesLayoutBuilder.FrameMeta> seq = new ArrayList<>(frames.size());
            for (SeriesLayoutBuilder.FrameMeta f : frames) {
                seq.add(new SeriesLayoutBuilder.FrameMeta(
                        f.sopInstanceUid(), f.instanceNumber(), f.instanceNumber(), Map.of()));
            }
            frames = seq;
        }

        SeriesLayout basic = SeriesLayoutBuilder.build(frames);

        // Z インデックス → IPP（z 昇順）。混在オリエンテーションでは Z 軸が無意味なため付与しない。
        List<SeriesLayout.ZSpatial> zSpatials = null;
        if (!mixedOrientation && !sopToIpp.isEmpty() && basic.nZ() > 0) {
            Map<Integer, double[]> zToIpp = new TreeMap<>();
            for (SeriesLayout.Cell cell : basic.cells()) {
                if (!zToIpp.containsKey(cell.z())) {
                    double[] ipp = sopToIpp.get(cell.sopInstanceUid());
                    if (ipp != null) {
                        zToIpp.put(cell.z(), ipp);
                    }
                }
            }
            if (!zToIpp.isEmpty()) {
                zSpatials = new ArrayList<>();
                for (Map.Entry<Integer, double[]> e : zToIpp.entrySet()) {
                    zSpatials.add(new SeriesLayout.ZSpatial(e.getKey(), e.getValue()));
                }
            }
        }

        return new SeriesLayout(
                basic.nZ(), basic.nC(), basic.nT(),
                basic.cDimension(), basic.tDimension(), basic.cells(),
                seriesIop, seriesPxRow, seriesPxCol, seriesWidth, seriesHeight,
                zSpatials, seriesFor);
    }

    // ── standalone(DicomStorageService) の classic 経路と同一ロジックのヘルパ ─────────────

    /** IPP を IOP 法線へ投影した距離（無ければ SliceLocation → InstanceNumber）。 */
    private static double zPosition(Attributes ds, int instanceNumber) {
        double[] ipp = ds.getDoubles(Tag.ImagePositionPatient);
        double[] iop = ds.getDoubles(Tag.ImageOrientationPatient);
        if (ipp != null && ipp.length >= 3 && iop != null && iop.length >= 6) {
            double nx = iop[1] * iop[5] - iop[2] * iop[4];
            double ny = iop[2] * iop[3] - iop[0] * iop[5];
            double nz = iop[0] * iop[4] - iop[1] * iop[3];
            return ipp[0] * nx + ipp[1] * ny + ipp[2] * nz;
        }
        double sl = ds.getDouble(Tag.SliceLocation, Double.NaN);
        return Double.isNaN(sl) ? instanceNumber : sl;
    }

    private static void putFirstPresent(Map<String, Double> dims, String key, Attributes ds, int... tags) {
        for (int tag : tags) {
            Double v = readNumeric(ds, tag);
            if (v != null) {
                dims.put(key, v);
                return;
            }
        }
    }

    private static void putIfPresent(Map<String, Double> dims, String key, Attributes ds, int tag) {
        Double v = readNumeric(ds, tag);
        if (v != null) {
            dims.put(key, v);
        }
    }

    private static void putComplexComponent(Map<String, Double> dims, Attributes ds) {
        String v = ds.getString(Tag.ComplexImageComponent);
        if (v == null) {
            return;
        }
        switch (v.trim().toUpperCase()) {
            case "MAGNITUDE" -> dims.put("Complex", 0.0);
            case "PHASE" -> dims.put("Complex", 1.0);
            case "REAL" -> dims.put("Complex", 2.0);
            case "IMAGINARY" -> dims.put("Complex", 3.0);
            case "MIXED" -> { /* 混在は単一チャンネル扱い */ }
            default -> { /* 未知値は無視 */ }
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

    /** IOP を 0.001 量子化した比較キー（浮動小数ノイズ吸収）。 */
    private static String iopKey(double[] iop) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 6; i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append(Math.round(iop[i] * 1000.0));
        }
        return sb.toString();
    }
}

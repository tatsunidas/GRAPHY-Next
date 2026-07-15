/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import com.vis.graphynext.dicom.SegFrameExpander;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * DICOM SEG（BINARY/8bit FRACTIONAL）読込。PerFrameFunctionalGroupsSequence を解析して
 * セグメント毎のフレーム（0/1 マスク平面）を DTO 化する（書込 {@link SegExportService} と対称。
 * `fw/mask-driven-pipelines-gap-analysis.md` 対応課題#2）。
 */
@Service
public class SegReadService {

    /** 未圧縮のネイティブ転送構文のみ対応（BINARY SEG の PixelData はビットパックのため規格上も非圧縮）。 */
    private static final Set<String> NATIVE_TS = Set.of(
            UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian, UID.DeflatedExplicitVRLittleEndian);

    private final DicomStorageService storage;

    public SegReadService(DicomStorageService storage) {
        this.storage = storage;
    }

    /** 指定 SEG シリーズのセグメント/フレーム群を読む。SEG でなければ null。 */
    public SegImportResult read(String studyUid, String seriesUid) throws IOException {
        List<Path> files = storage.resolveFiles(studyUid, List.of(seriesUid));
        for (Path f : files) {
            Attributes ds;
            String ts;
            try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                ds = in.readDataset();
                ts = in.getTransferSyntax();
            }
            if (!SegFrameExpander.isSegDataset(ds)) {
                continue;
            }
            if (ts != null && !NATIVE_TS.contains(ts)) {
                throw new IllegalArgumentException("圧縮転送構文の SEG は未対応です (ts=" + ts + ")");
            }
            return parse(ds);
        }
        return null;
    }

    private SegImportResult parse(Attributes ds) throws IOException {
        int rows = ds.getInt(Tag.Rows, 0);
        int cols = ds.getInt(Tag.Columns, 0);
        int nf = ds.getInt(Tag.NumberOfFrames, 1);
        int bits = ds.getInt(Tag.BitsAllocated, 1);
        if (rows <= 0 || cols <= 0) {
            throw new IllegalArgumentException("SEG に Rows/Columns がありません");
        }
        if (bits != 1 && bits != 8) {
            throw new IllegalArgumentException("BitsAllocated=" + bits + " の SEG は未対応です（1 or 8 のみ）");
        }
        byte[] px = ds.getBytes(Tag.PixelData);
        if (px == null) {
            throw new IllegalArgumentException("SEG に PixelData がありません");
        }
        int frameSize = rows * cols;

        // SegmentSequence → 番号ごとのラベル/色/説明。
        Map<Integer, String> labels = new HashMap<>();
        Map<Integer, int[]> colors = new HashMap<>();
        Map<Integer, String> descriptions = new HashMap<>();
        Sequence segSeq = ds.getSequence(Tag.SegmentSequence);
        if (segSeq != null) {
            for (Attributes it : segSeq) {
                int num = it.getInt(Tag.SegmentNumber, -1);
                labels.put(num, it.getString(Tag.SegmentLabel));
                descriptions.put(num, it.getString(Tag.SegmentDescription));
                int[] cielab = it.getInts(Tag.RecommendedDisplayCIELabValue);
                if (cielab != null && cielab.length >= 3) {
                    colors.put(num, cieLabToRgb(cielab[0], cielab[1], cielab[2]));
                }
            }
        }

        Sequence pf = ds.getSequence(Tag.PerFrameFunctionalGroupsSequence);
        Map<Integer, List<SegImportResult.Frame>> framesBySeg = new LinkedHashMap<>();
        for (int i = 0; i < nf; i++) {
            Attributes fr = (pf != null && i < pf.size()) ? pf.get(i) : null;
            int segNum = 0;
            String refSop = null;
            if (fr != null) {
                Attributes segId = fr.getNestedDataset(Tag.SegmentIdentificationSequence);
                if (segId != null) segNum = segId.getInt(Tag.ReferencedSegmentNumber, 0);
                Attributes deriv = fr.getNestedDataset(Tag.DerivationImageSequence);
                if (deriv != null) {
                    Attributes src = deriv.getNestedDataset(Tag.SourceImageSequence);
                    if (src != null) refSop = src.getString(Tag.ReferencedSOPInstanceUID);
                }
            }
            double[] ipp = SegFrameExpander.perFrameIpp(ds, i);
            byte[] plane = extractPlane01(px, i, frameSize, bits);
            boolean any = false;
            for (byte b : plane) {
                if (b != 0) { any = true; break; }
            }
            if (!any) continue; // 前景ゼロのフレームは出さない（export と対称）
            String mask = Base64.getEncoder().encodeToString(plane);
            framesBySeg.computeIfAbsent(segNum, k -> new ArrayList<>())
                    .add(new SegImportResult.Frame(refSop, ipp, mask));
        }

        List<SegImportResult.Segment> segments = new ArrayList<>();
        for (var e : framesBySeg.entrySet()) {
            int num = e.getKey();
            segments.add(new SegImportResult.Segment(
                    num, labels.getOrDefault(num, "Segment " + num), colors.get(num),
                    descriptions.get(num), e.getValue()));
        }
        return new SegImportResult(rows, cols, segments);
    }

    /** 指定フレームを 0/1 バイト平面へ展開。bits=1: LSB-first ビットパック。bits=8: 非ゼロ=1。 */
    private static byte[] extractPlane01(byte[] px, int frame, int frameSize, int bits) {
        byte[] out = new byte[frameSize];
        if (bits == 1) {
            long base = (long) frame * frameSize;
            for (int p = 0; p < frameSize; p++) {
                long bit = base + p;
                int by = (int) (bit >> 3);
                int sh = (int) (bit & 7);
                if (by < px.length && ((px[by] >> sh) & 1) != 0) {
                    out[p] = 1;
                }
            }
        } else {
            int off = frame * frameSize;
            for (int p = 0; p < frameSize; p++) {
                int idx = off + p;
                if (idx < px.length && px[idx] != 0) {
                    out[p] = 1;
                }
            }
        }
        return out;
    }

    /** DICOM RecommendedDisplayCIELabValue（各 0..65535, [L*,a*,b*]）→ sRGB(0..255)。
     * {@link SegExportService#rgbToCieLab} の逆変換。 */
    static int[] cieLabToRgb(int li, int ai, int bi) {
        double lStar = li * 100.0 / 65535.0;
        double aStar = ai * 255.0 / 65535.0 - 128.0;
        double bStar = bi * 255.0 / 65535.0 - 128.0;
        double fy = (lStar + 16.0) / 116.0;
        double fx = fy + aStar / 500.0;
        double fz = fy - bStar / 200.0;
        double x = 0.95047 * finv(fx);
        double y = 1.0 * finv(fy);
        double z = 1.08883 * finv(fz);
        double r = x * 3.2406 + y * -1.5372 + z * -0.4986;
        double g = x * -0.9689 + y * 1.8758 + z * 0.0415;
        double b = x * 0.0557 + y * -0.2040 + z * 1.0570;
        return new int[] { clamp255(linearToSrgb(r)), clamp255(linearToSrgb(g)), clamp255(linearToSrgb(b)) };
    }

    private static double finv(double t) {
        double t3 = t * t * t;
        return t3 > 0.008856 ? t3 : (t - 16.0 / 116.0) / 7.787;
    }

    private static int linearToSrgb(double c) {
        double v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1.0 / 2.4) - 0.055;
        return (int) Math.round(v * 255.0);
    }

    private static int clamp255(int v) {
        return v < 0 ? 0 : (v > 255 ? 255 : v);
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.imagej;

import ij.gui.OvalRoi;
import ij.gui.PointRoi;
import ij.gui.PolygonRoi;
import ij.gui.Roi;
import ij.io.RoiDecoder;
import ij.io.RoiEncoder;
import ij.process.FloatPolygon;
import org.springframework.stereotype.Service;

import java.awt.Color;
import java.awt.Rectangle;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * ImageJ ROI（{@code .roi} / {@code RoiSet.zip}）のエンコード/デコード。
 *
 * <p>{@link ImageJRoiDto}（画像ピクセル座標）↔ {@code ij.gui.Roi} を相互変換し、ImageJ 標準の
 * {@link RoiEncoder}/{@link RoiDecoder} でバイト列にする。保存優先=ImageJ の中核（{@code fw/roi-manager-design.md} 第6章）。
 */
@Service
public class ImageJRoiService {

    /** DTO → ij.gui.Roi。 */
    private Roi toIjRoi(ImageJRoiDto d) {
        Roi roi;
        String type = d.type() == null ? "polygon" : d.type().toLowerCase();
        switch (type) {
            case "rect" -> roi = new Roi(nz(d.bx()), nz(d.by()), nz(d.bw()), nz(d.bh()));
            case "oval" -> roi = new OvalRoi(nz(d.bx()), nz(d.by()), nz(d.bw()), nz(d.bh()));
            case "polyline" -> roi = new PolygonRoi(d.xs(), d.ys(), len(d), Roi.POLYLINE);
            case "freehand" -> roi = new PolygonRoi(d.xs(), d.ys(), len(d), Roi.FREEROI);
            case "angle" -> roi = new PolygonRoi(d.xs(), d.ys(), len(d), Roi.ANGLE);
            case "point" -> roi = new PointRoi(d.xs(), d.ys(), len(d));
            default -> roi = new PolygonRoi(d.xs(), d.ys(), len(d), Roi.POLYGON);
        }
        if (d.name() != null && !d.name().isBlank()) roi.setName(d.name());
        if (d.position() > 0) roi.setPosition(d.position());
        if (d.strokeColor() != null) roi.setStrokeColor(new Color(d.strokeColor(), true));
        return roi;
    }

    /** ij.gui.Roi → DTO。 */
    private ImageJRoiDto toDto(Roi roi) {
        int t = roi.getType();
        String type;
        float[] xs = null, ys = null;
        Double bx = null, by = null, bw = null, bh = null;
        switch (t) {
            case Roi.RECTANGLE -> {
                type = "rect";
                Rectangle b = roi.getBounds();
                bx = (double) b.x; by = (double) b.y; bw = (double) b.width; bh = (double) b.height;
            }
            case Roi.OVAL -> {
                type = "oval";
                Rectangle b = roi.getBounds();
                bx = (double) b.x; by = (double) b.y; bw = (double) b.width; bh = (double) b.height;
            }
            case Roi.POLYGON, Roi.TRACED_ROI, Roi.COMPOSITE -> { type = "polygon"; float[][] p = poly(roi); xs = p[0]; ys = p[1]; }
            case Roi.FREEROI -> { type = "freehand"; float[][] p = poly(roi); xs = p[0]; ys = p[1]; }
            case Roi.POLYLINE, Roi.FREELINE, Roi.LINE -> { type = "polyline"; float[][] p = poly(roi); xs = p[0]; ys = p[1]; }
            case Roi.ANGLE -> { type = "angle"; float[][] p = poly(roi); xs = p[0]; ys = p[1]; }
            case Roi.POINT -> { type = "point"; float[][] p = poly(roi); xs = p[0]; ys = p[1]; }
            default -> { type = "polygon"; float[][] p = poly(roi); xs = p[0]; ys = p[1]; }
        }
        Integer color = roi.getStrokeColor() != null ? roi.getStrokeColor().getRGB() : null;
        return new ImageJRoiDto(roi.getName(), type, roi.getPosition(), xs, ys, bx, by, bw, bh, color);
    }

    private static float[][] poly(Roi roi) {
        FloatPolygon fp = roi.getFloatPolygon();
        return new float[][]{fp.xpoints, fp.ypoints};
    }

    private static int len(ImageJRoiDto d) {
        return d.xs() == null ? 0 : d.xs().length;
    }

    private static int nz(Double v) {
        return v == null ? 0 : (int) Math.round(v);
    }

    /** 単一 ROI を {@code .roi} バイト列に。 */
    public byte[] encodeSingle(ImageJRoiDto dto) {
        return RoiEncoder.saveAsByteArray(toIjRoi(dto));
    }

    /** 複数 ROI を {@code RoiSet.zip} バイト列に（各エントリ {@code <name>.roi}、名前重複は連番付与）。 */
    public byte[] encodeRoiSet(List<ImageJRoiDto> dtos) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        Set<String> used = new HashSet<>();
        try (ZipOutputStream zos = new ZipOutputStream(baos)) {
            int i = 0;
            for (ImageJRoiDto d : dtos) {
                byte[] bytes = RoiEncoder.saveAsByteArray(toIjRoi(d));
                if (bytes == null) continue;
                String base = (d.name() != null && !d.name().isBlank()) ? d.name() : String.format("roi-%04d", i);
                String entry = uniqueEntry(used, base);
                zos.putNextEntry(new ZipEntry(entry));
                zos.write(bytes);
                zos.closeEntry();
                i++;
            }
        }
        return baos.toByteArray();
    }

    private static String uniqueEntry(Set<String> used, String base) {
        String name = base.toLowerCase().endsWith(".roi") ? base : base + ".roi";
        String candidate = name;
        int n = 1;
        while (!used.add(candidate)) {
            String stem = name.substring(0, name.length() - 4);
            candidate = stem + "-" + (n++) + ".roi";
        }
        return candidate;
    }

    /** {@code .roi} 単体または {@code .zip}（RoiSet）バイト列を DTO 群にデコード。 */
    public List<ImageJRoiDto> decode(byte[] data, String filename) throws IOException {
        List<ImageJRoiDto> out = new ArrayList<>();
        boolean isZip = filename != null && filename.toLowerCase().endsWith(".zip");
        if (isZip) {
            try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(data))) {
                ZipEntry e;
                while ((e = zis.getNextEntry()) != null) {
                    if (e.isDirectory()) continue;
                    byte[] bytes = zis.readAllBytes();
                    Roi roi = new RoiDecoder(bytes, e.getName()).getRoi();
                    if (roi != null) out.add(toDto(roi));
                }
            }
        } else {
            Roi roi = new RoiDecoder(data, filename).getRoi();
            if (roi != null) out.add(toDto(roi));
        }
        return out;
    }
}

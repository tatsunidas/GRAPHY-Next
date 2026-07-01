/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.imagej;

import com.vis.graphynext.dicom.SeriesLayout;
import com.vis.graphynext.dicom.store.DicomStorageService;
import ij.IJ;
import ij.ImageJ;
import ij.ImagePlus;
import ij.ImageStack;
import ij.io.Opener;
import ij.measure.Calibration;
import ij.process.ImageProcessor;
import ij.process.ShortProcessor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.awt.GraphicsEnvironment;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 表示中シリーズを ImageJ の HyperStack（{@code ij.ImagePlus}）としてブリッジ表示する。
 *
 * <p>backend が保持する DICOM を {@link SeriesLayout}（Z×C×T）の順で ImageJ ハイパースタック
 * （スライス番号 = c + nC*(z + nZ*t) + 1）に積み、pixelSpacing をキャリブレーションして
 * ローカルの ImageJ ウィンドウに表示する。{@code fw/roi-manager-design.md} の「ImageJ ブリッジ」。
 * GUI 表示のため headless では不可（その場合は例外）。
 */
@Service
public class ImageJBridgeService {

    private static final Logger log = LoggerFactory.getLogger(ImageJBridgeService.class);

    private final DicomStorageService storage;

    public ImageJBridgeService(DicomStorageService storage) {
        this.storage = storage;
    }

    /** ブリッジ結果（次元）。 */
    public record BridgeResult(int nZ, int nC, int nT, int width, int height) {}

    public BridgeResult bridge(String studyUid, String seriesUid, String title) throws IOException {
        if (GraphicsEnvironment.isHeadless()) {
            throw new IllegalStateException("ImageJ bridge requires a display (headless environment).");
        }
        SeriesLayout layout = storage.seriesLayout(studyUid, seriesUid);
        if (layout == null || layout.cells().isEmpty()) {
            throw new IllegalArgumentException("No frames for series " + seriesUid);
        }
        int nZ = Math.max(1, layout.nZ());
        int nC = Math.max(1, layout.nC());
        int nT = Math.max(1, layout.nT());
        int total = nZ * nC * nT;

        ImageProcessor[] procs = new ImageProcessor[total];
        int width = layout.imageWidth();
        int height = layout.imageHeight();

        for (SeriesLayout.Cell cell : layout.cells()) {
            ImageProcessor ip = loadProcessor(cell);
            if (ip == null) continue;
            width = ip.getWidth();
            height = ip.getHeight();
            int idx = cell.c() + nC * (cell.z() + nZ * cell.t());
            if (idx >= 0 && idx < total) procs[idx] = ip;
        }
        if (width <= 0 || height <= 0) {
            throw new IllegalStateException("Could not determine image dimensions for series " + seriesUid);
        }

        // ImageJ の HyperStack 順（c 最速 → z → t）でスライスを積む。欠損は空スライスで埋める。
        ImageStack stack = new ImageStack(width, height);
        for (int i = 0; i < total; i++) {
            ImageProcessor ip = procs[i];
            stack.addSlice(ip != null ? ip : new ShortProcessor(width, height));
        }

        String label = (title == null || title.isBlank()) ? ("GRAPHY " + seriesUid) : title;
        ImagePlus imp = new ImagePlus(label, stack);
        imp.setDimensions(nC, nZ, nT);
        imp.setOpenAsHyperStack(nZ * nC * nT > 1);
        if (layout.pixelSpacingCol() > 0 && layout.pixelSpacingRow() > 0) {
            Calibration cal = imp.getCalibration();
            cal.pixelWidth = layout.pixelSpacingCol();
            cal.pixelHeight = layout.pixelSpacingRow();
            cal.setUnit("mm");
            imp.setCalibration(cal);
        }

        // ローカル ImageJ を起動（未起動時のみ）して HyperStack を表示。
        if (IJ.getInstance() == null) {
            new ImageJ(ImageJ.STANDALONE);
        }
        imp.show();
        log.info("[imagej] bridged series {} as HyperStack {}x{} Z{} C{} T{}", seriesUid, width, height, nZ, nC, nT);
        return new BridgeResult(nZ, nC, nT, width, height);
    }

    /** セル（(c,z,t)→SOP, frame）から ImageJ の ImageProcessor を得る。 */
    private ImageProcessor loadProcessor(SeriesLayout.Cell cell) throws IOException {
        if (cell.frame() >= 0) {
            // マルチフレーム/モザイク: 単一フレーム DICOM を一時ファイルに書き出して開く。
            byte[] dicom = storage.frameDicom(cell.sopInstanceUid(), cell.frame());
            if (dicom == null) return null;
            Path tmp = Files.createTempFile("graphy-ij-", ".dcm");
            try {
                Files.write(tmp, dicom);
                return openProcessor(tmp, 0);
            } finally {
                Files.deleteIfExists(tmp);
            }
        }
        Path path = storage.resolveInstanceFile(cell.sopInstanceUid());
        if (path == null) return null;
        return openProcessor(path, 0);
    }

    /** ImageJ Opener で DICOM を開き、指定フレームの ImageProcessor を返す。 */
    private ImageProcessor openProcessor(Path path, int frameIndex) {
        ImagePlus imp = new Opener().openImage(path.toString());
        if (imp == null) return null;
        if (imp.getStackSize() > 1) {
            return imp.getStack().getProcessor(Math.min(frameIndex + 1, imp.getStackSize()));
        }
        return imp.getProcessor();
    }
}

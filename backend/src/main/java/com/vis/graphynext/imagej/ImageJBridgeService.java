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
        // 値(輝度)キャリブレーション: ImageJ の DICOM Opener が RescaleSlope/Intercept を読み、
        // source ImagePlus に HU 等の直線キャリブレーションを設定する。合成 HyperStack はこれを
        // 引き継がないため、最初に見つかった校正済み source の Calibration を控えて後で適用する。
        Calibration valueCal = null;

        for (SeriesLayout.Cell cell : layout.cells()) {
            Loaded loaded = loadProcessor(cell);
            if (loaded == null || loaded.ip() == null) continue;
            ImageProcessor ip = loaded.ip();
            width = ip.getWidth();
            height = ip.getHeight();
            if (valueCal == null && loaded.cal() != null && loaded.cal().calibrated()) {
                valueCal = loaded.cal();
            }
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

        // ★ 重要: ImagePlus を生成する「前」に ImageJ を起動する（順序が肝）。
        // ij.ImagePlus は `private ImageJ ij = IJ.getInstance();` というフィールド初期化子を持ち、
        // これは new ImagePlus(...) した瞬間に一度だけ評価される。そのため ImagePlus 生成より後に
        // ImageJ を起動すると、生成済み ImagePlus の内部 ij 参照が null 固定になり、カーソル移動時の
        // IJ.showStatus() による輝度値ステータス表示が永久に動かなくなる（GRAPHY Viewer2DToolBar
        // 「imagej」ボタンの知見）。openProcessor 内の一時 ImagePlus は表示しないので影響なし。
        if (IJ.getInstance() == null) {
            // EMBEDDED = ImageJ ウィンドウを閉じても System.exit() で backend(JVM) を落とさない。
            // STANDALONE は quit 時に JVM を終了させ、Spring Boot backend を巻き込むため使わない。
            ImageJ ij = new ImageJ(ImageJ.EMBEDDED);
            ij.exitWhenQuitting(false);
        }

        String label = (title == null || title.isBlank()) ? ("GRAPHY " + seriesUid) : title;
        ImagePlus imp = new ImagePlus(label, stack);
        imp.setDimensions(nC, nZ, nT);
        imp.setOpenAsHyperStack(nZ * nC * nT > 1);
        // 値(HU 等)キャリブレーションを source から引き継ぎ（copy で函数/係数/単位を保持）、
        // 空間キャリブレーション(pixelWidth/Height, mm)は layout の pixelSpacing で上書きする。
        // これにより ImageJ ステータスバーに座標＋HU 値が表示される（GRAPHY と同方針）。
        Calibration cal = (valueCal != null) ? valueCal.copy() : imp.getCalibration();
        if (layout.pixelSpacingCol() > 0 && layout.pixelSpacingRow() > 0) {
            cal.pixelWidth = layout.pixelSpacingCol();
            cal.pixelHeight = layout.pixelSpacingRow();
            cal.setUnit("mm");
        }
        imp.setCalibration(cal);

        // show() で ImageJ の WindowManager に自動登録され、ステータスバーに座標＋輝度値が出る。
        imp.show();
        log.info("[imagej] bridged series {} as HyperStack {}x{} Z{} C{} T{}", seriesUid, width, height, nZ, nC, nT);
        return new BridgeResult(nZ, nC, nT, width, height);
    }

    /** 読み込んだ 1 枚: ImageProcessor（画素）＋ source ImagePlus の Calibration（HU 等の値校正）。 */
    private record Loaded(ImageProcessor ip, Calibration cal) {}

    /** セル（(c,z,t)→SOP, frame）から ImageProcessor と Calibration を得る。 */
    private Loaded loadProcessor(SeriesLayout.Cell cell) throws IOException {
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

    /** ImageJ Opener で DICOM を開き、指定フレームの ImageProcessor と Calibration を返す。 */
    private Loaded openProcessor(Path path, int frameIndex) {
        ImagePlus imp = new Opener().openImage(path.toString());
        if (imp == null) return null;
        // Calibration は ImagePlus 単位（全フレーム共通）。RescaleSlope/Intercept 由来の値校正を含む。
        Calibration cal = imp.getCalibration();
        ImageProcessor ip = (imp.getStackSize() > 1)
                ? imp.getStack().getProcessor(Math.min(frameIndex + 1, imp.getStackSize()))
                : imp.getProcessor();
        return new Loaded(ip, cal);
    }
}

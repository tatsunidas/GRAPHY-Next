package com.vis.uvs.radiomics;

import com.vis.uvs.video.Frame;
import ij.ImagePlus;
import ij.gui.Roi;
import ij.process.ByteProcessor;

import java.awt.Rectangle;

/**
 * ROI の切り出しと、RadiomicsJ へ渡すマスクの生成。
 *
 * <p>Swing 版 {@code ml/VideoPredictor.predictFrame} の前処理と同じ:
 * <pre>
 * ip   = frame を 8bit グレースケール化（ImageJ convertToByte(true) 相当）
 * crop = ip.crop(roi.getBounds())
 * mask = crop と同じ大きさの矩形を 255 で塗りつぶしたもの（label = 255）
 * </pre>
 *
 * <p>つまり <b>ROI 全体が関心領域</b>で、形状マスクは使わない。
 */
public final class RoiCropper {

    /** Swing と同じマスクラベル。 */
    public static final int MASK_LABEL = 255;

    private RoiCropper() {
    }

    /** 切り出した画像とマスクの組。 */
    public record Cropped(ImagePlus image, ImagePlus mask, Rectangle bounds) {
    }

    /**
     * @param frame 元フレーム
     * @param roi   切り出す ROI
     * @return 画像とマスク。ROI が画像外へ完全に出ている場合は {@code null}
     */
    public static Cropped crop(Frame frame, Roi roi) {
        Rectangle b = roi.getBounds().intersection(
                new Rectangle(0, 0, frame.width(), frame.height()));
        if (b.isEmpty()) {
            return null;
        }

        byte[] pixels = new byte[b.width * b.height];
        for (int y = 0; y < b.height; y++) {
            int srcRow = (b.y + y) * frame.width();
            int dstRow = y * b.width;
            for (int x = 0; x < b.width; x++) {
                // ImageJ convertToByte(true) 相当（非加重平均・四捨五入）
                pixels[dstRow + x] = (byte) frame.gray(srcRow + b.x + x);
            }
        }
        ByteProcessor image = new ByteProcessor(b.width, b.height, pixels);

        byte[] maskPixels = new byte[b.width * b.height];
        java.util.Arrays.fill(maskPixels, (byte) MASK_LABEL);
        ByteProcessor mask = new ByteProcessor(b.width, b.height, maskPixels);

        return new Cropped(new ImagePlus("crop", image), new ImagePlus("mask", mask), b);
    }
}

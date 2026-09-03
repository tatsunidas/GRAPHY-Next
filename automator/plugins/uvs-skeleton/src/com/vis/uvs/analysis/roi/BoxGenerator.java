package com.vis.uvs.analysis.roi;

import ij.gui.Roi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * ROI 候補ボックスの生成。Swing 版 {@code methods/BoxGenerator} の移植。
 *
 * <p><b>乱数の消費順序を変えてはいけない。</b>1 ボックスにつき
 * {@code nextDouble()} を <b>幅 → 高さ → X → Y</b> の順に 4 回引く。
 * 順序を変えると同じシードでも別の ROI 群になり、Swing との一致が崩れる
 * （{@code fw/analysis-pipeline.md} §3.4）。
 *
 * <p>ImageJ {@code Roi(double,double,double,double)} の丸め規則:
 * {@code x=(int)x, y=(int)y, width=max(1,(int)ceil(w)), height=max(1,(int)ceil(h))}。
 * スコアも特徴量もこの整数 bounds を使うため、丸めが合っていないと値が変わる。
 */
public final class BoxGenerator {

    private static final Logger log = LoggerFactory.getLogger(BoxGenerator.class);

    private BoxGenerator() {
    }

    /**
     * コンテナ内に完全に収まるランダムなボックスを生成する。互いに重なってよい。
     *
     * @param containerWidth  画像幅
     * @param containerHeight 画像高さ
     * @param numBoxes        生成数
     * @param minBoxWidth     最小幅
     * @param maxBoxWidth     最大幅
     * @param minBoxHeight    最小高さ
     * @param maxBoxHeight    最大高さ
     * @param random          乱数（シードは呼び出し側が固定する）
     */
    public static List<Roi> randomBoxes(double containerWidth, double containerHeight,
                                        int numBoxes,
                                        double minBoxWidth, double maxBoxWidth,
                                        double minBoxHeight, double maxBoxHeight,
                                        Random random) {
        List<Roi> boxes = new ArrayList<>();

        if (containerWidth <= 0 || containerHeight <= 0 || numBoxes <= 0
                || minBoxWidth <= 0 || maxBoxWidth < minBoxWidth
                || minBoxHeight <= 0 || maxBoxHeight < minBoxHeight) {
            log.error("無効なパラメータ: container={}x{}, numBoxes={}, w=[{},{}], h=[{},{}]",
                    containerWidth, containerHeight, numBoxes,
                    minBoxWidth, maxBoxWidth, minBoxHeight, maxBoxHeight);
            return boxes;
        }
        if (maxBoxWidth > containerWidth) {
            log.error("ボックスの最大幅 {} がコンテナ幅 {} を超えています", maxBoxWidth, containerWidth);
            return boxes;
        }
        if (maxBoxHeight > containerHeight) {
            log.error("ボックスの最大高さ {} がコンテナ高さ {} を超えています", maxBoxHeight, containerHeight);
            return boxes;
        }

        for (int i = 0; i < numBoxes; i++) {
            // ⚠ この 4 回の順序が Swing との一致の要
            double boxWidth = minBoxWidth + random.nextDouble() * (maxBoxWidth - minBoxWidth);
            double boxHeight = minBoxHeight + random.nextDouble() * (maxBoxHeight - minBoxHeight);
            double boxX = random.nextDouble() * (containerWidth - boxWidth);
            double boxY = random.nextDouble() * (containerHeight - boxHeight);
            boxes.add(new Roi(boxX, boxY, boxWidth, boxHeight));
        }
        return boxes;
    }

    /**
     * スライディングウィンドウ。
     *
     * <p>Swing にも実装があるが現行のパスからは呼ばれていない。移管はするが既定では使わない
     * （{@code fw/analysis-pipeline.md} §3.4）。
     */
    public static List<Roi> slidingWindows(int imageWidth, int imageHeight,
                                           int windowWidth, int windowHeight,
                                           int stepX, int stepY) {
        List<Roi> windows = new ArrayList<>();
        if (imageWidth <= 0 || imageHeight <= 0 || windowWidth <= 0 || windowHeight <= 0
                || stepX <= 0 || stepY <= 0) {
            log.error("無効なパラメータ（すべて正の整数である必要があります）");
            return windows;
        }
        if (windowWidth > imageWidth || windowHeight > imageHeight) {
            log.warn("ウィンドウ {}x{} が画像 {}x{} を超えています",
                    windowWidth, windowHeight, imageWidth, imageHeight);
            return windows;
        }
        for (int y = 0; y <= imageHeight - windowHeight; y += stepY) {
            for (int x = 0; x <= imageWidth - windowWidth; x += stepX) {
                windows.add(new Roi(x, y, windowWidth, windowHeight));
            }
        }
        return windows;
    }
}

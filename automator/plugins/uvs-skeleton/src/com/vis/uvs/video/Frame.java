package com.vis.uvs.video;

/**
 * 1 フレームの画素。RGB888 のパック配列（{@code rgb24}）。
 *
 * @param index  1-based の原本フレーム位置
 * @param width  幅
 * @param height 高さ
 * @param rgb    長さ {@code width * height * 3}。{@code [r,g,b, r,g,b, ...]}
 */
public record Frame(int index, int width, int height, byte[] rgb) {

    public int pixelCount() {
        return width * height;
    }

    /** 画素 i の R 成分（0–255）。 */
    public int r(int i) {
        return rgb[i * 3] & 0xFF;
    }

    /** 画素 i の G 成分（0–255）。 */
    public int g(int i) {
        return rgb[i * 3 + 1] & 0xFF;
    }

    /** 画素 i の B 成分（0–255）。 */
    public int b(int i) {
        return rgb[i * 3 + 2] & 0xFF;
    }

    /**
     * 画素 i のグレースケール値（0–255）。
     *
     * <p><b>ImageJ の既定と同じ非加重平均</b> {@code (r+g+b)/3} を使う。
     * Swing 版は {@code ImageProcessor.convertToByteProcessor()} を通しており、
     * ImageJ の既定は「Weighted RGB conversions」オフ＝非加重。
     * 加重（0.299/0.587/0.114）にすると静止フレーム判定の MAD が Swing と一致しなくなる。
     */
    public int gray(int i) {
        return (int) ((r(i) + g(i) + b(i)) / 3.0 + 0.5);
    }

    /**
     * 画素 i のグレースケール値（float、丸めなし）。
     *
     * <p>ImageJ の {@code ColorProcessor.convertToFloat()} と<b>同じ式・同じ順序</b>。
     * 重みは既定の 1/3 ずつで、{@link #gray(int)} と違い <b>四捨五入しない</b>。
     * フレーム差分はこちらを使う（Swing 版が {@code convertToFloat()} を通していたため）。
     */
    public float grayFloat(int i) {
        final double w = 1d / 3d;
        return (float) (r(i) * w + g(i) * w + b(i) * w);
    }

    /** 座標 (x, y) の画素インデックス。 */
    public int indexOf(int x, int y) {
        return y * width + x;
    }

    /** 画素 i の RGB 幅（max - min）。カラーフレーム判定に使う。 */
    public int colorRange(int i) {
        int r = r(i);
        int g = g(i);
        int b = b(i);
        int max = Math.max(r, Math.max(g, b));
        int min = Math.min(r, Math.min(g, b));
        return max - min;
    }
}

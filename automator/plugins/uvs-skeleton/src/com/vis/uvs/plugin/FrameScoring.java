package com.vis.uvs.plugin;

/**
 * 色フレーム判定（CPR）と静止フレーム判定（MAD）— {@code fw/uvs-plugin-design.md} §5 の [A] [B]。
 *
 * <h3>🔴 定数と手順を 1 つでも変えると、学習済みモデルと不整合になる</h3>
 * 元アプリ（UVS-Web）の {@code analysis/FrameScorer} / {@code analysis/SamplingPoints} と
 * <b>同じ結果</b>を出さなければならない。移植で狂いやすいのは次の 4 点:
 *
 * <ol>
 *   <li><b>サンプル点は 2 系統ある。</b> 色は {@code nextInt(totalPixels)} を 300 回、
 *       静止は {@code nextInt(width)} と {@code nextInt(height)} を交互に 300 回。
 *       <b>同じシード 76 でも別の点列になる</b>（乱数の消費の仕方が違うため）。</li>
 *   <li><b>点はフレームごとに作り直さない</b>（元は毎フレーム再シードしていて、結果として
 *       全フレーム同一の 300 点だった。再現性が高いので<b>仕様として維持</b>）。</li>
 *   <li><b>グレースケールは非加重平均</b> {@code (r+g+b)/3}。
 *       加重（0.299/0.587/0.114）にすると一致しない。</li>
 *   <li>🔴 <b>MAD は四捨五入した整数のグレー値で引く</b>（{@code gray()}）。
 *       丸めない {@code grayFloat()} は<b>差分画像を作る側</b>で使うもので、ここではない。</li>
 * </ol>
 *
 * <p>⚠️ 判定は「しきい値を跨いだか」で、しきい値そのものは呼び出し側が持つ
 * （静止のしきい値は<b>動画の由来</b>に依存する・設計 §7）。
 */
public final class FrameScoring {

    private FrameScoring() {
    }

    /** 既定のサンプル点数。 */
    public static final int SAMPLING_POINTS = 300;
    /** 既定の乱数シード。 */
    public static final long RANDOM_SEED = 76L;
    /** RGB の幅がこれを超えたら「色が付いている画素」。 */
    public static final double COLOR_THRESHOLD = 30.0;
    /** 色画素の割合がこれを超えたらカラーフレーム。 */
    public static final double COLOR_PIXEL_RATIO_THRESHOLD = 0.0035;

    /**
     * 固定パターンのサンプル点。
     *
     * <p>🔴 <b>2 系統を別々に生成する</b>（上記 1）。1 つの乱数列から使い回してはいけない。
     */
    public static final class Points {
        public final int[] pixelIndex; // 色判定用
        public final int[] x;          // 静止判定用
        public final int[] y;
        public final int count;

        public Points(int width, int height, int requested, long seed) {
            int total = width * height;
            if (total <= 0) throw new IllegalArgumentException("解像度が不正: " + width + "x" + height);
            this.count = Math.min(total, requested);

            java.util.Random r1 = new java.util.Random();
            r1.setSeed(seed);
            this.pixelIndex = new int[count];
            for (int i = 0; i < count; i++) pixelIndex[i] = r1.nextInt(total);

            java.util.Random r2 = new java.util.Random();
            r2.setSeed(seed);
            this.x = new int[count];
            this.y = new int[count];
            for (int i = 0; i < count; i++) {
                x[i] = r2.nextInt(width);
                y[i] = r2.nextInt(height);
            }
        }
    }

    /** 画素 i の RGB 幅（max − min）。rgb24 パック配列を前提。 */
    public static int colorRange(byte[] rgb, int i) {
        int r = rgb[i * 3] & 0xFF;
        int g = rgb[i * 3 + 1] & 0xFF;
        int b = rgb[i * 3 + 2] & 0xFF;
        int max = Math.max(r, Math.max(g, b));
        int min = Math.min(r, Math.min(g, b));
        return max - min;
    }

    /** 画素 i のグレー値（**四捨五入した整数**・非加重平均）。 */
    public static int gray(byte[] rgb, int i) {
        int r = rgb[i * 3] & 0xFF;
        int g = rgb[i * 3 + 1] & 0xFF;
        int b = rgb[i * 3 + 2] & 0xFF;
        return (int) ((r + g + b) / 3.0 + 0.5);
    }

    /** 色画素比（CPR）。しきい値を超えた点の割合。 */
    public static double colorPixelRatio(byte[] rgb, Points p, double colorThreshold) {
        int hit = 0;
        for (int i = 0; i < p.count; i++) {
            if (colorRange(rgb, p.pixelIndex[i]) > colorThreshold) hit++;
        }
        return (double) hit / (double) p.count;
    }

    /**
     * 隣接 2 フレームの平均絶対差（MAD）。
     *
     * <p>🔴 丸めた {@link #gray} で引く（上記 4）。
     */
    public static double meanAbsDiff(byte[] cur, byte[] next, Points p, int width) {
        double sum = 0;
        for (int i = 0; i < p.count; i++) {
            int idx = p.y[i] * width + p.x[i];
            sum += Math.abs(gray(cur, idx) - gray(next, idx));
        }
        return sum / p.count;
    }
}

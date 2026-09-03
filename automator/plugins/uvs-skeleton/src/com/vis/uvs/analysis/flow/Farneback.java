package com.vis.uvs.analysis.flow;

import org.apache.commons.math3.linear.LUDecomposition;
import org.apache.commons.math3.linear.MatrixUtils;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Farnebäck (2003) の密オプティカルフロー。Swing 版 {@code optical/Farneback} の移植。
 *
 * <p>論文 Section 3.3（係数ワープ法）＋ Eq.14〜16 に沿った実装。
 * 手順は 4 段:
 * <ol>
 *   <li><b>ピラミッド構築</b>: 粗い解像度から順に解析して大きな動きを捉える</li>
 *   <li><b>多項式展開</b>: 各層の輝度分布を 2 次曲面へ近似（係数テンソル化）。
 *       反復の前に 1 度だけ行い、再サンプリングによる劣化を防ぐ</li>
 *   <li><b>係数ワープと反復</b>: 予測フローに従って画像 2 の<b>係数自体</b>をワープし、
 *       画像 1 の係数との残差を現在のフローへ加算する</li>
 *   <li><b>事後処理</b>: メディアンフィルタで外れ値を除去</li>
 * </ol>
 *
 * <h2>なぜ OpenCV に置き換えないのか</h2>
 * <p>配布中のモデル（{@code logostic_2025-06-11….model}）は Smile 形式＝Swing の
 * {@code ModelTrainer}（Java）が学習したもので、<b>学習時の ROI はこの実装で抽出されている</b>。
 * OpenCV に替えると ROI → 特徴 → モデルの前提が崩れ、再学習が必須になる。
 * bytedeco opencv はプラットフォーム限定でも +100〜150MB でもある。
 * よってこの実装を維持し、置換は Yosemite ベンチで劣位が示された場合にのみ検討する
 * （{@code fw/analysis-pipeline.md} §7）。
 *
 * <p><b>スレッド安全ではない</b>（{@code gWeights} / {@code gInv} を保持するため）。
 * フレームごとにインスタンスを作るか、スレッドごとに 1 つ持つこと。
 */
public final class Farneback {

    private double[] gWeights;
    private double[][] gInv;

    /**
     * 密オプティカルフローを計算する。
     *
     * @param prev       前フレーム（グレースケール float、行優先）
     * @param next       次フレーム
     * @param width      幅
     * @param height     高さ
     * @param pyrScale   ピラミッドの縮小率。<b>{@code levels == 1} のときは使われない</b>
     * @param levels     ピラミッド段数（1 = ピラミッド無し）
     * @param winSize    近傍統合のウィンドウ幅
     * @param iterations 各層の反復回数
     * @param polyN      多項式展開の近傍サイズ（奇数）
     * @param polySigma  多項式展開のガウス重みσ
     * @return {@code [height][width][2]} の {@code (du, dv)}
     */
    public double[][][] calcOpticalFlowFarneback(float[] prev, float[] next, int width, int height,
                                                 double pyrScale, int levels, int winSize,
                                                 int iterations, int polyN, double polySigma) {
        List<Layer> prevPyr = buildPyramid(prev, width, height, pyrScale, levels);
        List<Layer> nextPyr = buildPyramid(next, width, height, pyrScale, levels);

        double[][][] flow = null;
        int radius = polyN / 2;
        prepareWeights(radius, polySigma);

        for (int l = levels - 1; l >= 0; l--) {
            Layer prevLayer = prevPyr.get(l);
            Layer nextLayer = nextPyr.get(l);
            int w = prevLayer.width;
            int h = prevLayer.height;

            if (flow == null) {
                flow = new double[h][w][2];
            } else {
                flow = scaleFlow(flow, flow[0].length, flow.length, w, h);
            }

            // 係数の計算は反復の外で 1 度だけ（画像の再サンプリング劣化を防ぐ）
            double[][][] r0 = estimatePolynomial(prevLayer.pixels, w, h, radius);
            double[][][] r1Original = estimatePolynomial(nextLayer.pixels, w, h, radius);

            for (int iter = 0; iter < iterations; iter++) {
                double[][][] r1Warped;
                if (iter == 0 && l == levels - 1) {
                    r1Warped = r1Original; // 初回はワープなし
                } else {
                    r1Warped = warpCoefficients(r1Original, flow, w, h);
                }
                updateFlow(flow, r0, r1Warped, winSize, w, h);
            }
        }

        return applyMedianFilter(flow, 5);
    }

    /** 論文 Eq.14〜16。残差フロー Δd を求めて現在のフローへ加算する。 */
    private void updateFlow(double[][][] flow, double[][][] r0, double[][][] r1,
                            int winSize, int width, int height) {
        double[][][] matrices = new double[5][height][width];

        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                // A(x) = (A1(x) + A2(x)) / 2
                double a11 = (r0[3][y][x] + r1[3][y][x]) * 0.5;
                double a22 = (r0[4][y][x] + r1[4][y][x]) * 0.5;
                double a12 = (r0[5][y][x] + r1[5][y][x]) * 0.25;

                // Δb(x) = -1/2 (b2(x) - b1(x))
                double db1 = (r0[1][y][x] - r1[1][y][x]) * 0.5;
                double db2 = (r0[2][y][x] - r1[2][y][x]) * 0.5;

                // G = AᵀA, h = AᵀΔb
                matrices[0][y][x] = a11 * a11 + a12 * a12; // G11
                matrices[1][y][x] = a11 * a12 + a12 * a22; // G12
                matrices[2][y][x] = a12 * a12 + a22 * a22; // G22
                matrices[3][y][x] = a11 * db1 + a12 * db2; // h1
                matrices[4][y][x] = a12 * db1 + a22 * db2; // h2
            }
        }

        // 近傍の統合。σ は OpenCV と同じ式
        double blurSigma = 0.3 * ((winSize - 1) * 0.5 - 1.0) + 0.8;
        matrices = blurMatrices(matrices, winSize, blurSigma);

        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                double g11 = matrices[0][y][x];
                double g12 = matrices[1][y][x];
                double g22 = matrices[2][y][x];
                double h1 = matrices[3][y][x];
                double h2 = matrices[4][y][x];

                double det = g11 * g22 - g12 * g12;
                if (Math.abs(det) > 1e-10) {
                    double idet = 1.0 / det;
                    flow[y][x][0] += (g22 * h1 - g12 * h2) * idet;
                    flow[y][x][1] += (g11 * h2 - g12 * h1) * idet;
                }
            }
        }
    }

    /** 多項式係数テンソルを現在のフローに従ってワープする。 */
    private double[][][] warpCoefficients(double[][][] r, double[][][] flow, int width, int height) {
        double[][][] warped = new double[6][height][width];
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                double sx = x + flow[y][x][0];
                double sy = y + flow[y][x][1];

                int x0 = (int) Math.floor(sx);
                int y0 = (int) Math.floor(sy);
                int ix0 = clamp(x0, width);
                int ix1 = clamp(x0 + 1, width);
                int iy0 = clamp(y0, height);
                int iy1 = clamp(y0 + 1, height);

                double dx = sx - x0;
                double dy = sy - y0;

                for (int c = 0; c < 6; c++) {
                    warped[c][y][x] = (1 - dx) * (1 - dy) * r[c][iy0][ix0]
                            + dx * (1 - dy) * r[c][iy0][ix1]
                            + (1 - dx) * dy * r[c][iy1][ix0]
                            + dx * dy * r[c][iy1][ix1];
                }
            }
        }
        return warped;
    }

    /** 事後処理のメディアンフィルタ。 */
    public double[][][] applyMedianFilter(double[][][] flow, int winSize) {
        int h = flow.length;
        int w = flow[0].length;
        double[][][] result = new double[h][w][2];
        int radius = winSize / 2;
        double[] uWin = new double[winSize * winSize];
        double[] vWin = new double[winSize * winSize];

        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int count = 0;
                for (int dy = -radius; dy <= radius; dy++) {
                    int ny = clamp(y + dy, h);
                    for (int dx = -radius; dx <= radius; dx++) {
                        int nx = clamp(x + dx, w);
                        uWin[count] = flow[ny][nx][0];
                        vWin[count] = flow[ny][nx][1];
                        count++;
                    }
                }
                Arrays.sort(uWin);
                Arrays.sort(vWin);
                result[y][x][0] = uWin[uWin.length / 2];
                result[y][x][1] = vWin[vWin.length / 2];
            }
        }
        return result;
    }

    /** 各画素の近傍を 2 次多項式へ最小二乗近似し、6 個の係数を得る。 */
    private double[][][] estimatePolynomial(float[] src, int w, int h, int radius) {
        int size = 2 * radius + 1;
        double[][][] coeffs = new double[6][h][w];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                double[] b = new double[6];
                for (int dy = -radius; dy <= radius; dy++) {
                    int py = clamp(y + dy, h);
                    for (int dx = -radius; dx <= radius; dx++) {
                        int px = clamp(x + dx, w);
                        double weight = gWeights[(dy + radius) * size + (dx + radius)];
                        double val = src[py * w + px] * weight;
                        b[0] += val;
                        b[1] += val * dx;
                        b[2] += val * dy;
                        b[3] += val * dx * dx;
                        b[4] += val * dy * dy;
                        b[5] += val * dx * dy;
                    }
                }
                for (int i = 0; i < 6; i++) {
                    double acc = 0;
                    for (int j = 0; j < 6; j++) {
                        acc += gInv[i][j] * b[j];
                    }
                    coeffs[i][y][x] = acc;
                }
            }
        }
        return coeffs;
    }

    /** ガウス重みと (AᵀA)⁻¹ を用意する。 */
    private void prepareWeights(int radius, double sigma) {
        int size = 2 * radius + 1;
        gWeights = new double[size * size];
        double sum = 0;
        for (int dy = -radius; dy <= radius; dy++) {
            for (int dx = -radius; dx <= radius; dx++) {
                double v = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
                gWeights[(dy + radius) * size + (dx + radius)] = v;
                sum += v;
            }
        }
        for (int i = 0; i < gWeights.length; i++) {
            gWeights[i] /= sum;
        }

        double[][] ata = new double[6][6];
        for (int dy = -radius; dy <= radius; dy++) {
            for (int dx = -radius; dx <= radius; dx++) {
                double w = gWeights[(dy + radius) * size + (dx + radius)];
                double[] a = {1, dx, dy, dx * dx, dy * dy, dx * dy};
                for (int i = 0; i < 6; i++) {
                    for (int j = 0; j < 6; j++) {
                        ata[i][j] += a[i] * a[j] * w;
                    }
                }
            }
        }
        gInv = new LUDecomposition(MatrixUtils.createRealMatrix(ata)).getSolver().getInverse().getData();
    }

    /**
     * ガウシアンピラミッドを作る。
     *
     * <p>⚠ ループは {@code l = 1; l < levels} なので、<b>{@code levels == 1} なら
     * 縮小は一度も起きず {@code scale} は使われない</b>。
     * Swing 版の既定 {@code pyrScale=3, levels=1} は、pyrScale が無効な組み合わせ。
     */
    private List<Layer> buildPyramid(float[] src, int w, int h, double scale, int levels) {
        List<Layer> pyramid = new ArrayList<>();
        pyramid.add(new Layer(src, w, h));
        double sigma = (1.0 / scale - 1.0) * 0.5;
        for (int l = 1; l < levels; l++) {
            Layer prev = pyramid.get(l - 1);
            float[] blurred = gaussianBlur(prev.pixels, prev.width, prev.height, sigma);
            int nw = (int) Math.round(prev.width * scale);
            int nh = (int) Math.round(prev.height * scale);
            float[] scaled = new float[nw * nh];
            for (int y = 0; y < nh; y++) {
                for (int x = 0; x < nw; x++) {
                    double sx = x / scale;
                    double sy = y / scale;
                    int x0 = (int) sx;
                    int y0 = (int) sy;
                    int x1 = Math.min(x0 + 1, prev.width - 1);
                    int y1 = Math.min(y0 + 1, prev.height - 1);
                    double dx = sx - x0;
                    double dy = sy - y0;
                    scaled[y * nw + x] = (float) ((1 - dx) * (1 - dy) * blurred[y0 * prev.width + x0]
                            + dx * (1 - dy) * blurred[y0 * prev.width + x1]
                            + (1 - dx) * dy * blurred[y1 * prev.width + x0]
                            + dx * dy * blurred[y1 * prev.width + x1]);
                }
            }
            pyramid.add(new Layer(scaled, nw, nh));
        }
        return pyramid;
    }

    private static float[] gaussianBlur(float[] src, int w, int h, double sigma) {
        int r = (int) Math.ceil(sigma * 3);
        int size = 2 * r + 1;
        double[] kernel = gaussianKernel(size, r, sigma);

        float[] temp = new float[w * h];
        float[] result = new float[w * h];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                double v = 0;
                for (int k = -r; k <= r; k++) {
                    v += src[y * w + clamp(x + k, w)] * kernel[k + r];
                }
                temp[y * w + x] = (float) v;
            }
        }
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                double v = 0;
                for (int k = -r; k <= r; k++) {
                    v += temp[clamp(y + k, h) * w + x] * kernel[k + r];
                }
                result[y * w + x] = (float) v;
            }
        }
        return result;
    }

    /** 粗い層のフローを細かい層へ引き伸ばす（大きさもスケールする）。 */
    private static double[][][] scaleFlow(double[][][] old, int ow, int oh, int nw, int nh) {
        double[][][] result = new double[nh][nw][2];
        double sx = (double) nw / ow;
        double sy = (double) nh / oh;
        for (int y = 0; y < nh; y++) {
            for (int x = 0; x < nw; x++) {
                double fx = x / sx;
                double fy = y / sy;
                int x0 = (int) fx;
                int y0 = (int) fy;
                int x1 = Math.min(x0 + 1, ow - 1);
                int y1 = Math.min(y0 + 1, oh - 1);
                double dx = fx - x0;
                double dy = fy - y0;
                for (int c = 0; c < 2; c++) {
                    double v = (1 - dx) * (1 - dy) * old[y0][x0][c] + dx * (1 - dy) * old[y0][x1][c]
                            + (1 - dx) * dy * old[y1][x0][c] + dx * dy * old[y1][x1][c];
                    result[y][x][c] = v * (c == 0 ? sx : sy);
                }
            }
        }
        return result;
    }

    /** G と h の 5 成分を分離ガウスで平滑化する。 */
    private static double[][][] blurMatrices(double[][][] m, int winSize, double sigma) {
        int h = m[0].length;
        int w = m[0][0].length;
        double[][][] result = new double[5][h][w];
        int r = winSize / 2;
        double[] kernel = gaussianKernel(winSize, r, sigma);

        for (int c = 0; c < 5; c++) {
            double[][] temp = new double[h][w];
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    double v = 0;
                    for (int k = -r; k <= r; k++) {
                        v += m[c][y][clamp(x + k, w)] * kernel[k + r];
                    }
                    temp[y][x] = v;
                }
            }
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    double v = 0;
                    for (int k = -r; k <= r; k++) {
                        v += temp[clamp(y + k, h)][x] * kernel[k + r];
                    }
                    result[c][y][x] = v;
                }
            }
        }
        return result;
    }

    private static double[] gaussianKernel(int size, int radius, double sigma) {
        double[] kernel = new double[size];
        double sum = 0;
        for (int i = 0; i < size; i++) {
            double x = i - radius;
            kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
            sum += kernel[i];
        }
        for (int i = 0; i < size; i++) {
            kernel[i] /= sum;
        }
        return kernel;
    }

    private static int clamp(int v, int max) {
        return Math.max(0, Math.min(max - 1, v));
    }

    private record Layer(float[] pixels, int width, int height) {
    }
}

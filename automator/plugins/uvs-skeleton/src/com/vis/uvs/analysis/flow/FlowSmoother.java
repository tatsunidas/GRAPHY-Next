package com.vis.uvs.analysis.flow;

/**
 * フロー場の分離ガウス平滑化。Swing 版 {@code optical/OpticalFlow.smoothFlowGaussian} の移植。
 */
public final class FlowSmoother {

    private FlowSmoother() {
    }

    /**
     * @param flow  {@code [h][w][2]} の (du, dv)
     * @param sigma ガウスσ
     */
    public static double[][][] gaussian(double[][][] flow, double sigma) {
        int h = flow.length;
        int w = flow[0].length;
        int radius = (int) Math.ceil(3 * sigma);
        int size = 2 * radius + 1;

        double[] kernel = new double[size];
        double sum = 0;
        for (int i = -radius; i <= radius; i++) {
            kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
            sum += kernel[i + radius];
        }
        for (int i = 0; i < size; i++) {
            kernel[i] /= sum;
        }

        double[][][] temp = new double[h][w][2];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                double u = 0;
                double v = 0;
                for (int k = -radius; k <= radius; k++) {
                    int px = Math.max(0, Math.min(w - 1, x + k));
                    u += flow[y][px][0] * kernel[k + radius];
                    v += flow[y][px][1] * kernel[k + radius];
                }
                temp[y][x][0] = u;
                temp[y][x][1] = v;
            }
        }

        double[][][] smoothed = new double[h][w][2];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                double u = 0;
                double v = 0;
                for (int k = -radius; k <= radius; k++) {
                    int py = Math.max(0, Math.min(h - 1, y + k));
                    u += temp[py][x][0] * kernel[k + radius];
                    v += temp[py][x][1] * kernel[k + radius];
                }
                smoothed[y][x][0] = u;
                smoothed[y][x][1] = v;
            }
        }
        return smoothed;
    }

    /** 各画素のマグニチュード |(du,dv)|。 */
    public static double[][] magnitude(double[][][] flow) {
        int h = flow.length;
        int w = flow[0].length;
        double[][] mag = new double[h][w];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                double du = flow[y][x][0];
                double dv = flow[y][x][1];
                mag[y][x] = Math.sqrt(du * du + dv * dv);
            }
        }
        return mag;
    }
}

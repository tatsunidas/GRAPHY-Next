package com.vis.uvs.analysis.roi;

import com.vis.uvs.common.Indices;
import ij.gui.Roi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.Rectangle;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.TreeMap;

/**
 * ROI 候補を採点 → 足切り → 特徴抽出 → 正規化 → k-means → クラスタ平均 ROI。
 *
 * <p>Swing 版 {@code methods/RoiClusterPipeline} の移植
 * （{@code fw/analysis-pipeline.md} §4 が正本）。
 *
 * <pre>
 * 1. 全ボックスをスコアリング
 * 2. threshold = percentile(scores, 80.0) 以上を残す
 * 3. 残りの特徴ベクトルを抽出（null は捨てる）
 * 4. 特徴ごとに min-max 正規化（range==0 は 0 に固定）
 * 5. k-means（初期 = distinct をシャッフルして先頭 k、最大 100 反復）
 * 6. クラスタごとに (x,y,w,h) を単純平均 → 代表 ROI
 * </pre>
 */
public final class RoiClusterPipeline {

    private static final Logger log = LoggerFactory.getLogger(RoiClusterPipeline.class);

    private final long seed;

    public RoiClusterPipeline(long seed) {
        this.seed = seed;
    }

    /** クラスタ番号 → 代表 ROI（昇順）。 */
    public Map<Integer, Roi> run(List<Roi> boxes,
                                 RoiScorer scorer,
                                 RoiFeatureExtractor extractor,
                                 double percentileThreshold,
                                 int k,
                                 int maxIterations,
                                 boolean normalize) {
        if (boxes == null || boxes.isEmpty()) {
            return Map.of();
        }

        // --- 1・2: スコアリングと足切り ---
        double[] scores = new double[boxes.size()];
        for (int i = 0; i < boxes.size(); i++) {
            scores[i] = scorer.score(boxes.get(i));
        }
        double threshold = Indices.percentile(scores, percentileThreshold);

        List<Roi> survivors = new ArrayList<>();
        for (int i = 0; i < boxes.size(); i++) {
            if (scores[i] >= threshold) {
                survivors.add(boxes.get(i));
            }
        }
        log.debug("足切りを通過した ROI: {} / {}", survivors.size(), boxes.size());

        // --- 3: 足切り後だけ特徴抽出 ---
        List<RoiFeatureVector> vectors = new ArrayList<>();
        List<Roi> validRois = new ArrayList<>();
        for (Roi roi : survivors) {
            RoiFeatureVector v = extractor.extract(roi);
            if (v != null) {
                vectors.add(v);
                validRois.add(roi);
            }
        }
        if (vectors.isEmpty()) {
            log.warn("有効な特徴ベクトルが 1 つも抽出できませんでした");
            return Map.of();
        }

        // --- 4・5: 正規化と k-means ---
        int[] assignments = cluster(vectors, k, maxIterations, normalize);

        // --- 6: クラスタごとに平均 ROI ---
        Map<Integer, List<Roi>> grouped = new LinkedHashMap<>();
        for (int i = 0; i < assignments.length; i++) {
            if (assignments[i] != -1) {
                grouped.computeIfAbsent(assignments[i], id -> new ArrayList<>()).add(validRois.get(i));
            }
        }

        Map<Integer, Roi> result = new TreeMap<>();
        for (Map.Entry<Integer, List<Roi>> e : grouped.entrySet()) {
            Roi avg = averageRoi(e.getValue());
            if (avg != null) {
                result.put(e.getKey(), avg);
            }
        }
        return result;
    }

    // ------------------------------------------------------------------

    private int[] cluster(List<RoiFeatureVector> vectors, int k, int maxIterations, boolean normalize) {
        int n = vectors.size();
        int[] assignments = new int[n];
        java.util.Arrays.fill(assignments, -1);
        if (k <= 0) {
            return assignments;
        }

        List<RoiFeatureVector> data = normalize ? normalize(vectors) : vectors;

        Random random = new Random(seed);
        List<RoiFeatureVector> centroids = initialCentroids(data, k, random);
        int actualK = centroids.size();
        if (actualK == 0) {
            return assignments;
        }

        int dims = data.get(0).dimensions();
        for (int iter = 0; iter < maxIterations; iter++) {
            boolean changed = false;

            // 割当
            for (int i = 0; i < n; i++) {
                double[] v = data.get(i).values();
                int nearest = -1;
                double best = Double.MAX_VALUE;
                for (int c = 0; c < actualK; c++) {
                    double d = distanceSq(v, centroids.get(c).values());
                    if (d < best) {
                        best = d;
                        nearest = c;
                    }
                }
                if (nearest != -1 && assignments[i] != nearest) {
                    assignments[i] = nearest;
                    changed = true;
                }
            }
            // Swing と同じく iter > 0 の条件つきで打ち切る
            if (!changed && iter > 0) {
                break;
            }

            // 更新
            double[][] sums = new double[actualK][dims];
            int[] counts = new int[actualK];
            for (int i = 0; i < n; i++) {
                int c = assignments[i];
                if (c == -1) {
                    continue;
                }
                double[] v = data.get(i).values();
                for (int d = 0; d < dims; d++) {
                    sums[c][d] += v[d];
                }
                counts[c]++;
            }

            List<RoiFeatureVector> next = new ArrayList<>(actualK);
            String[] names = data.get(0).names();
            for (int c = 0; c < actualK; c++) {
                if (counts[c] > 0) {
                    double[] mean = new double[dims];
                    for (int d = 0; d < dims; d++) {
                        mean[d] = sums[c][d] / counts[c];
                    }
                    next.add(new RoiFeatureVector(names, mean));
                } else {
                    // 空クラスタは再初期化（Swing と同じ）
                    next.add(data.get(random.nextInt(n)));
                }
            }
            centroids = next;
        }
        return assignments;
    }

    private List<RoiFeatureVector> initialCentroids(List<RoiFeatureVector> vectors, int k, Random random) {
        List<RoiFeatureVector> unique = vectors.stream().distinct().collect(java.util.stream.Collectors.toList());
        Collections.shuffle(unique, random);
        int actualK = Math.min(k, unique.size());
        return new ArrayList<>(unique.subList(0, actualK));
    }

    /** 特徴ごとの min-max 正規化。range が 0 の特徴は 0 に固定（Swing と同じ）。 */
    private List<RoiFeatureVector> normalize(List<RoiFeatureVector> vectors) {
        int dims = vectors.get(0).dimensions();
        double[] min = new double[dims];
        double[] max = new double[dims];
        java.util.Arrays.fill(min, Double.MAX_VALUE);
        java.util.Arrays.fill(max, -Double.MAX_VALUE);

        for (RoiFeatureVector v : vectors) {
            double[] values = v.values();
            for (int d = 0; d < dims; d++) {
                min[d] = Math.min(min[d], values[d]);
                max[d] = Math.max(max[d], values[d]);
            }
        }

        List<RoiFeatureVector> result = new ArrayList<>(vectors.size());
        for (RoiFeatureVector v : vectors) {
            double[] values = v.values();
            double[] scaled = new double[dims];
            for (int d = 0; d < dims; d++) {
                double range = max[d] - min[d];
                scaled[d] = (range == 0) ? 0 : (values[d] - min[d]) / range;
            }
            result.add(v.withValues(scaled));
        }
        return result;
    }

    private static double distanceSq(double[] a, double[] b) {
        double sum = 0;
        for (int i = 0; i < a.length; i++) {
            double diff = a[i] - b[i];
            sum += diff * diff;
        }
        return sum;
    }

    /**
     * クラスタ内 ROI の (x, y, w, h) を単純平均する。
     *
     * <p>⚠ 平均矩形なので、クラスタ内のばらつきが大きいと実体のない矩形になりうる。
     * Swing 版からの既知の弱点として記録してあるが、v1 では挙動を変えない
     * （{@code fw/analysis-pipeline.md} §4）。
     */
    private static Roi averageRoi(List<Roi> cluster) {
        if (cluster == null || cluster.isEmpty()) {
            return null;
        }
        double sumX = 0;
        double sumY = 0;
        double sumW = 0;
        double sumH = 0;
        for (Roi roi : cluster) {
            Rectangle b = roi.getBounds();
            sumX += b.x;
            sumY += b.y;
            sumW += b.width;
            sumH += b.height;
        }
        int count = cluster.size();
        return new Roi(sumX / count, sumY / count, sumW / count, sumH / count);
    }
}

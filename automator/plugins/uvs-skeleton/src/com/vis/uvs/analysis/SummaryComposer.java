package com.vis.uvs.analysis;

import com.vis.uvs.common.Indices;

import java.util.Collection;
import java.util.List;
import java.util.SortedMap;

/**
 * 要約インデックスの合成。<b>仕様の核心</b>。
 *
 * <p>Swing 版 {@code MainScreen.summarizeAndUpdate()} の規則をそのまま移植する
 * （{@code fw/swing-feature-inventory.md} §4）:
 *
 * <pre>
 * removeSet = colorRemove ∪ staticRemove
 * heartSet  = { i | interpolate(predScores)[i] &gt; PREDICTION_THRESHOLD }   // 予測未実行なら全フレーム
 * final     = heartSet − removeSet
 * final     = (final − userRemove) ∪ userAdd                              // userAdd が最優先
 * </pre>
 *
 * <p>純関数。フロント（TypeScript）にも同じ実装を持たせ、
 * 共有テストベクタ {@code fw/testdata/summary-composer-cases.json} で一致を検証する。
 */
public final class SummaryComposer {

    private SummaryComposer() {
    }

    /**
     * @param frameCount        原本の総フレーム数
     * @param colorRemove       カラー判定で落ちたフレーム
     * @param staticRemove      静止判定で落ちたフレーム
     * @param heart             確率閾値を超えたフレーム（予測未実行なら {@code null}）
     * @param userAdd           ユーザが明示追加したフレーム（最優先で残す）
     * @param userRemove        ユーザが明示除外したフレーム
     */
    public static Derived compose(int frameCount,
                                  Collection<Integer> colorRemove,
                                  Collection<Integer> staticRemove,
                                  Collection<Integer> heart,
                                  Collection<Integer> userAdd,
                                  Collection<Integer> userRemove) {

        List<Integer> colorAndStatic = Indices.merge(colorRemove, staticRemove);

        // 予測が 1 度も走っていなければ全フレームを「心臓」とみなす。
        // 色 / 静止判定だけでも要約できるようにするための仕様（Swing と同じ）。
        List<Integer> heartSet = heart != null ? Indices.merge(heart, List.of()) : Indices.all(frameCount);

        List<Integer> result = Indices.subtract(heartSet, colorAndStatic);
        result = Indices.subtract(result, userRemove);
        result = Indices.merge(result, userAdd);

        List<Integer> removedByPrediction = Indices.oppose(heartSet, frameCount);

        return new Derived(
                Indices.merge(colorRemove, List.of()),
                Indices.merge(staticRemove, List.of()),
                heartSet,
                removedByPrediction,
                result);
    }

    /**
     * 予測スコアを補間し、閾値を当てて「心臓フレーム」を求める。
     *
     * @param predScores 疎な予測スコア（キー = 1-based 原本位置）。空なら {@code null} を返す
     * @param frameCount 原本の総フレーム数
     * @param interval   サンプリング間隔
     * @param threshold  確率閾値
     */
    public static HeartResult applyPredictionThreshold(SortedMap<Integer, Double> predScores,
                                                       int frameCount, int interval, float threshold) {
        if (predScores == null || predScores.isEmpty()) {
            return null;
        }
        // Swing と同じクランプ
        float clamped = threshold;
        if (clamped > 1) {
            clamped = 0.9999999f;
        } else if (clamped < 0.0000001f) {
            clamped = 0.0000001f;
        }

        double[] known = predScores.values().stream().mapToDouble(Double::doubleValue).toArray();
        double[] interpolated = Indices.interpolate(known, frameCount, Math.max(1, interval));

        List<Integer> heart = new java.util.ArrayList<>();
        for (int i = 0; i < frameCount; i++) {
            if (interpolated[i] > clamped) {
                heart.add(i + 1);
            }
        }
        return new HeartResult(heart, interpolated);
    }

    /**
     * 除外率（Swing の {@code SummaryResults}）。
     *
     * <p>色 / 静止 / 確率の各件数は<b>ユーザ追加分を差し引いて</b>数える（Swing と同じ）。
     */
    public static Results results(int frameCount, Derived derived,
                                  Collection<Integer> userAdd, Collection<Integer> userRemove) {
        int total = frameCount - derived.finalIndices().size();
        int color = Indices.subtract(derived.colorRemove(), userAdd).size();
        int staticCount = Indices.subtract(derived.staticRemove(), userAdd).size();
        int proba = frameCount - Indices.subtract(derived.heart(), userAdd).size();
        return new Results(frameCount, total, color, staticCount, proba,
                userAdd == null ? 0 : userAdd.size(),
                userRemove == null ? 0 : userRemove.size());
    }

    public record Derived(
            List<Integer> colorRemove,
            List<Integer> staticRemove,
            List<Integer> heart,
            List<Integer> removedByPrediction,
            List<Integer> finalIndices) {
    }

    public record HeartResult(List<Integer> heart, double[] interpolated) {
    }

    public record Results(
            int numberOfFrames,
            int totalRemoved,
            int colorRemoved,
            int staticRemoved,
            int probaRemoved,
            int userAdded,
            int userRemoved) {

        public double totalRate() {
            return rate(totalRemoved);
        }

        public double colorRate() {
            return rate(colorRemoved);
        }

        public double staticRate() {
            return rate(staticRemoved);
        }

        public double probaRate() {
            return rate(probaRemoved);
        }

        private double rate(int n) {
            return numberOfFrames > 0 ? (double) n / numberOfFrames : 0.0;
        }
    }
}

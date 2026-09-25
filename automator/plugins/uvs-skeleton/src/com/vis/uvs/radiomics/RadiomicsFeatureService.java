package com.vis.uvs.radiomics;

import ij.ImagePlus;
import io.github.tatsunidas.radiomics.features.FractalFeatureType;
import io.github.tatsunidas.radiomics.features.FractalFeatures;
import io.github.tatsunidas.radiomics.features.GLCMFeatureType;
import io.github.tatsunidas.radiomics.features.GLCMFeatures;
import io.github.tatsunidas.radiomics.features.GLDZMFeatureType;
import io.github.tatsunidas.radiomics.features.GLDZMFeatures;
import io.github.tatsunidas.radiomics.features.GLRLMFeatureType;
import io.github.tatsunidas.radiomics.features.GLRLMFeatures;
import io.github.tatsunidas.radiomics.features.GLSZMFeatureType;
import io.github.tatsunidas.radiomics.features.GLSZMFeatures;
import io.github.tatsunidas.radiomics.features.IntensityBasedStatisticalFeatureType;
import io.github.tatsunidas.radiomics.features.IntensityBasedStatisticalFeatures;
import io.github.tatsunidas.radiomics.features.IntensityHistogramFeatureType;
import io.github.tatsunidas.radiomics.features.IntensityHistogramFeatures;
import io.github.tatsunidas.radiomics.features.IntensityVolumeHistogramFeatureType;
import io.github.tatsunidas.radiomics.features.IntensityVolumeHistogramFeatures;
import io.github.tatsunidas.radiomics.features.LocalIntensityFeatureType;
import io.github.tatsunidas.radiomics.features.LocalIntensityFeatures;
import io.github.tatsunidas.radiomics.features.NGLDMFeatureType;
import io.github.tatsunidas.radiomics.features.NGLDMFeatures;
import io.github.tatsunidas.radiomics.features.NGTDMFeatureType;
import io.github.tatsunidas.radiomics.features.NGTDMFeatures;
import io.github.tatsunidas.radiomics.features.Shape2DFeatureType;
import io.github.tatsunidas.radiomics.features.Shape2DFeatures;
import io.github.tatsunidas.radiomics.main.RadiomicsJ;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.function.Supplier;

/**
 * RadiomicsJ による特徴抽出。Swing 版 {@code methods/FeatureExtractor} の移植。
 *
 * <p>特徴名は <b>{@code Family_FeatureName}</b> 形式（例 {@code GLCM_JointEntropy}）。
 * 学習時に選ばれた名前のリストに従って、必要な特徴だけを計算する
 * （{@code fw/analysis-pipeline.md} §5.1）。
 *
 * <h2>⚠ スレッド安全性</h2>
 * <p>RadiomicsJ は <b>static な可変状態</b>（{@code RadiomicsJ.force2D} /
 * {@code RadiomicsJ.nBins} / {@code RadiomicsJ.discretiseImp}）を持つ。
 * {@code discretiseImp} は離散化した画像を保持する static フィールドで、
 * 並列に呼ぶと確実に競合する。よって<b>抽出全体をロックで直列化</b>する。
 *
 * <p>これは実効的にフレーム単位の並列化を封じるが、正しさを優先する。
 * 将来スループットが問題になったら、①RadiomicsJ 側のスレッド安全化
 * ②別プロセスへの切り出し ③Python ラッパーをワーカーとして複数起動、のいずれかを検討する。
 */
public class RadiomicsFeatureService {

    private static final Logger log = LoggerFactory.getLogger(RadiomicsFeatureService.class);

    /** RadiomicsJ の static 可変状態を守るロック。 */
    private static final Object RADIOMICS_LOCK = new Object();

    /**
     * 抽出条件。モデル manifest（{@code featureExtraction}）から作る。
     *
     * @param names       特徴名（{@code Family_FeatureName}）。<b>この順序が推論入力の順序</b>
     * @param paddings    NaN / Inf のときに使う補完値。{@code names} と同じ長さ。{@code null} 可
     * @param useBinCount ビン数指定（true）かビン幅指定（false）か
     * @param nBins       ビン数
     * @param binWidth    ビン幅（{@code useBinCount == false} のとき）
     * @param label       マスクのラベル値
     */
    public record Spec(
            String[] names,
            double[] paddings,
            boolean useBinCount,
            Integer nBins,
            Double binWidth,
            int label) {

        public static Spec swingDefaults(String[] names, double[] paddings) {
            // Swing は useBinCount=true, nBins=RadiomicsJ.nBins（既定）, label=255
            return new Spec(names, paddings, true, RadiomicsJ.nBins, null, RoiCropper.MASK_LABEL);
        }
    }

    public RadiomicsFeatureService() {
        // force2D は起動時に 1 度だけ設定する。抽出のたびに書き換えると競合するため。
        synchronized (RADIOMICS_LOCK) {
            RadiomicsJ.force2D = true;
        }
        log.info("RadiomicsJ: force2D=true, 既定 nBins={}", RadiomicsJ.nBins);
    }

    /**
     * 特徴ベクトルを 1 本抽出する。
     *
     * @param image 切り出した画像
     * @param mask  同じ大きさのマスク
     * @param spec  抽出条件
     * @return {@code spec.names()} と同じ長さ・同じ順序の値
     */
    public double[] extract(ImagePlus image, ImagePlus mask, Spec spec) {
        return extractDetailed(image, mask, spec).values();
    }

    /**
     * 抽出結果と、<b>どの特徴が padding で埋まったか</b>。
     *
     * @param values  {@code spec.names()} と同じ長さ・同じ順序の値
     * @param padded  同じ長さ。NaN / Inf だったため padding 値に置き換えた位置が true
     */
    public record Extracted(double[] values, boolean[] padded) {
        /** 1 つでも埋めたか。 */
        public boolean any() {
            for (boolean b : padded) if (b) return true;
            return false;
        }
    }

    /**
     * {@link #extract} と<b>同じ計算</b>をしたうえで、padding の有無も返す。
     *
     * <p>⚠️ <b>padding の経路は一度も通っていない</b>（設計 §8.10）。4 フレームでは NaN が
     * 出なかったので、埋めた実績が無い＝正しさが確かめられていない。数字を変えずに
     * <b>通ったかどうかを観測できる</b>ようにするためだけの口である
     * （`extract` はこれに委譲するので、2 つの実装に分かれる余地は無い）。
     */
    public Extracted extractDetailed(ImagePlus image, ImagePlus mask, Spec spec) {
        double[] values = new double[spec.names().length];
        boolean[] padded = new boolean[spec.names().length];
        synchronized (RADIOMICS_LOCK) {
            for (int i = 0; i < spec.names().length; i++) {
                Double raw = calculate(spec.names()[i], image, mask, spec);
                padded[i] = raw == null || !Double.isFinite(raw);
                values[i] = pad(raw, spec, i);
            }
        }
        return new Extracted(values, padded);
    }

    /** 特徴名を {@code Family} と {@code FeatureName} に割って RadiomicsJ を呼ぶ。 */
    private Double calculate(String featureName, ImagePlus image, ImagePlus mask, Spec spec) {
        int split = featureName.indexOf('_');
        if (split <= 0 || split == featureName.length() - 1) {
            log.warn("特徴名の形式が Family_FeatureName ではありません: {}", featureName);
            return Double.NaN;
        }
        String family = featureName.substring(0, split);
        String name = featureName.substring(split + 1);
        int label = spec.label();

        try {
            return switch (family) {
                case "LocalIntensity" -> byName(LocalIntensityFeatureType.values(), name,
                        t -> new LocalIntensityFeatures(image, mask, label).calculate(t.id()));

                case "IntensityBasedStatistical" -> byName(IntensityBasedStatisticalFeatureType.values(), name,
                        t -> new IntensityBasedStatisticalFeatures(image, mask, label).calculate(t.id()));

                case "IntensityHistogram" -> byName(IntensityHistogramFeatureType.values(), name,
                        t -> unchecked(() -> new IntensityHistogramFeatures(
                                image, mask, label, spec.useBinCount(), spec.nBins(), spec.binWidth())
                                .calculate(t.id())));

                case "IntensityVolumeHistogram" -> byName(IntensityVolumeHistogramFeatureType.values(), name,
                        // Swing は離散化なし（0）で呼んでいる
                        t -> unchecked(() -> new IntensityVolumeHistogramFeatures(image, mask, label, 0)
                                .calculate(t.id())));

                case "Shape2D" -> byName(Shape2DFeatureType.values(), name,
                        // Swing は slice=1 固定
                        t -> new Shape2DFeatures(image, mask, 1, label).calculate(t.id()));

                case "GLCM" -> byName(GLCMFeatureType.values(), name,
                        t -> unchecked(() -> new GLCMFeatures(image, mask, label, null,
                                spec.useBinCount(), spec.nBins(), spec.binWidth(), null).calculate(t.id())));

                case "GLRLM" -> byName(GLRLMFeatureType.values(), name,
                        t -> unchecked(() -> new GLRLMFeatures(image, mask, label,
                                spec.useBinCount(), spec.nBins(), spec.binWidth(), null).calculate(t.id())));

                case "GLSZM" -> byName(GLSZMFeatureType.values(), name,
                        t -> unchecked(() -> new GLSZMFeatures(image, mask, label,
                                spec.useBinCount(), spec.nBins(), spec.binWidth()).calculate(t.id())));

                case "GLDZM" -> byName(GLDZMFeatureType.values(), name,
                        t -> new GLDZMFeatures(image, mask, label,
                                spec.useBinCount(), spec.nBins(), spec.binWidth()).calculate(t.id()));

                case "NGTDM" -> byName(NGTDMFeatureType.values(), name,
                        t -> unchecked(() -> new NGTDMFeatures(image, mask, label, null,
                                spec.useBinCount(), spec.nBins(), spec.binWidth()).calculate(t.id())));

                case "NGLDM" -> byName(NGLDMFeatureType.values(), name,
                        t -> unchecked(() -> new NGLDMFeatures(image, mask, label, null, null,
                                spec.useBinCount(), spec.nBins(), spec.binWidth()).calculate(t.id())));

                case "Fractal" -> byName(FractalFeatureType.values(), name,
                        // Swing は box sizes = null（既定）
                        t -> new FractalFeatures(image, mask, label, null).calculate(t.id()));

                default -> {
                    log.warn("未知の特徴ファミリ: {}（特徴名 {}）", family, featureName);
                    yield Double.NaN;
                }
            };
        } catch (RuntimeException e) {
            // 個々の特徴の失敗で全体を落とさない。padding で埋める（Swing と同じ）
            log.debug("特徴 {} の計算に失敗しました: {}", featureName, e.toString());
            return Double.NaN;
        }
    }

    /** enum 定数を名前で引いて計算する。見つからなければ NaN。 */
    private <T extends Enum<T>> Double byName(T[] values, String name, java.util.function.Function<T, Double> f) {
        for (T t : values) {
            if (t.name().equals(name)) {
                return f.apply(t);
            }
        }
        log.warn("未知の特徴名: {}", name);
        return Double.NaN;
    }

    /** NaN / Inf を padding 値で置換する（Swing の {@code padding()} と同じ）。 */
    private static double pad(Double v, Spec spec, int index) {
        if (v != null && Double.isFinite(v)) {
            return v;
        }
        double[] paddings = spec.paddings();
        if (paddings != null && index < paddings.length) {
            return paddings[index];
        }
        return 0.0;
    }

    /** checked 例外を投げる RadiomicsJ のコンストラクタを包む。 */
    private static Double unchecked(ThrowingSupplier supplier) {
        try {
            return supplier.get();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @FunctionalInterface
    private interface ThrowingSupplier {
        Double get() throws Exception;
    }

    /** 参照用。モデル manifest の {@code featureExtraction.version} と突き合わせる。 */
    public static String radiomicsJVersion() {
        return RadiomicsJ.version;
    }

    /** 起動時に一度だけ呼ばれることを保証するためのヘルパ（テスト用）。 */
    static Supplier<Boolean> force2D() {
        return () -> RadiomicsJ.force2D;
    }
}

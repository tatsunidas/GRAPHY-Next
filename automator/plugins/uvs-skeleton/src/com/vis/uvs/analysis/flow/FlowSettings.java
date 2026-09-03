package com.vis.uvs.analysis.flow;

/**
 * Farnebäck オプティカルフローのパラメータ。
 *
 * <p>既定は <b>Swing 版の実測値そのまま</b>。配布中のモデルはこの設定で抽出した ROI から
 * 学習されているため、勝手に変えるとモデルの前提が崩れる
 * （{@code fw/analysis-pipeline.md} §3.2・§7）。
 *
 * @param pyrScale   ピラミッド縮小率。⚠ {@code levels == 1} のときは<b>使われない</b>
 * @param levels     ピラミッド段数。1 = ピラミッド無し（大きな変位を捉えられない）
 * @param winSize    近傍統合のウィンドウ幅
 * @param iterations 反復回数
 * @param polyN      多項式展開の近傍サイズ（奇数）
 * @param polySigma  多項式展開のガウス重みσ
 * @param smoothSigma フロー後段の平滑化σ
 */
public record FlowSettings(
        double pyrScale,
        int levels,
        int winSize,
        int iterations,
        int polyN,
        double polySigma,
        double smoothSigma) {

    /**
     * Swing 版の既定。**変更しないこと**（モデルとの整合のため）。
     *
     * <p>{@code pyrScale=3} は OpenCV の意味論では不正な値だが、{@code levels=1} のため
     * 実際には参照されない。値の意味を誤解しないよう記録として残している。
     */
    public static FlowSettings swingDefaults() {
        return new FlowSettings(3.0, 1, 15, 3, 5, 1.1, 5.0);
    }

    /**
     * Python 研究側（OpenCV）と同じパラメータ。
     *
     * <p>ピラミッドが 3 段あるので大きな変位に強い。
     * <b>採用するには再学習が必要</b>（ROI が変わるため）。
     * Yosemite ベンチで優位が確認できてから切り替える。
     */
    public static FlowSettings pythonEquivalent() {
        return new FlowSettings(0.5, 3, 15, 3, 5, 1.2, 5.0);
    }
}

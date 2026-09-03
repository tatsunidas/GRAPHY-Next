package com.vis.uvs.ml;

/**
 * ロジスティック回帰の推論 — {@code fw/uvs-plugin-design.md} §1.1。
 *
 * <h3>🔑 ONNX を持ち込まない</h3>
 * UVS-Web は Smile の Java 直列化をやめて ONNX（onnxruntime）へ移したが、
 * <b>移植先では要らない</b>。`reference-params.json` に全パラメータがあり、推論は算術だけ:
 *
 * <pre>
 *   z = intercept + Σ coefᵢ · (xᵢ − muᵢ) / scaleᵢ
 *   p = 1 / (1 + exp(−z))
 * </pre>
 *
 * 🔴 <b>そもそも `model.onnx` はリポジトリに存在しない</b>（`.gitignore` 済み）。
 * ONNX 経路は「再生成してから使う」もので、依存を 1 つ増やす価値が無い。
 *
 * <h3>⚠️ 確率の向きに注意</h3>
 * manifest の <b>{@code positiveClassIndex = 0}</b> で 1 列出力。
 * シグモイドの向きを取り違えると確率が<b>反転する</b>（それでも「もっともらしい数」が出るので
 * 気づきにくい）。§8.8 で移植元と同じ値が出ることを数値で確かめている。
 */
public final class LrModel {

    private final String[] featureNames;
    private final double[] mu;
    private final double[] scale;
    private final double[] coef;
    private final double intercept;

    public LrModel(String[] featureNames, double[] mu, double[] scale, double[] coef, double intercept) {
        int n = featureNames.length;
        if (mu.length != n || scale.length != n || coef.length != n) {
            throw new IllegalArgumentException(
                    "パラメータの長さが揃っていません: names=" + n + " mu=" + mu.length
                            + " scale=" + scale.length + " coef=" + coef.length);
        }
        this.featureNames = featureNames;
        this.mu = mu;
        this.scale = scale;
        this.coef = coef;
        this.intercept = intercept;
    }

    /** `reference-params.json` から読む。⚠️ 読めなかったら**既定値へ落ちずに例外**（設計 §2.3）。 */
    public static LrModel fromJson(String json) {
        String[] names = jsonStrings(json, "featureNames");
        double[] mu = jsonDoubles(json, "mu");
        double[] scale = jsonDoubles(json, "scale");
        double[] coef = jsonDoubles(json, "coef");
        Double intercept = jsonScalar(json, "intercept");
        if (names == null || mu == null || scale == null || coef == null || intercept == null) {
            throw new IllegalStateException("reference-params.json を読めませんでした（欠けている鍵があります）");
        }
        return new LrModel(names, mu, scale, coef, intercept);
    }

    public String[] featureNames() {
        return featureNames.clone();
    }

    /** 標準化してから線形結合し、シグモイドを掛ける。 */
    public double score(double[] x) {
        if (x.length != coef.length) {
            throw new IllegalArgumentException("特徴の数が合いません: " + x.length + " != " + coef.length);
        }
        double z = intercept;
        for (int i = 0; i < x.length; i++) {
            double s = scale[i] == 0 ? 1.0 : scale[i];
            z += coef[i] * (x[i] - mu[i]) / s;
        }
        return 1.0 / (1.0 + Math.exp(-z));
    }

    // --- 最小限の JSON 読み取り（配列は数値/文字列のフラットなものだけ） -------------------
    // 依存を足さないための割り切り。`reference-params.json` は tools が生成する固定の形。

    private static String slice(String json, String key) {
        int k = json.indexOf('"' + key + '"');
        if (k < 0) return null;
        int c = json.indexOf(':', k);
        if (c < 0) return null;
        int i = c + 1;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        if (i >= json.length()) return null;
        if (json.charAt(i) != '[') {                       // スカラー
            int e = i;
            while (e < json.length() && ",}\n\r".indexOf(json.charAt(e)) < 0) e++;
            return json.substring(i, e).trim();
        }
        int depth = 0;                                      // 配列（入れ子も跨ぐ）
        int e = i;
        for (; e < json.length(); e++) {
            char ch = json.charAt(e);
            if (ch == '[') depth++;
            else if (ch == ']' && --depth == 0) break;
        }
        return json.substring(i, Math.min(e + 1, json.length()));
    }

    private static double[] jsonDoubles(String json, String key) {
        String s = slice(json, key);
        if (s == null) return null;
        // 🔑 `coef` は [[...]] の形もありうる（1 行の係数行列）。角括弧を落として平らに読む。
        String body = s.replace("[", "").replace("]", "").trim();
        if (body.isEmpty()) return new double[0];
        String[] parts = body.split(",");
        double[] out = new double[parts.length];
        for (int i = 0; i < parts.length; i++) out[i] = Double.parseDouble(parts[i].trim());
        return out;
    }

    private static String[] jsonStrings(String json, String key) {
        String s = slice(json, key);
        if (s == null) return null;
        java.util.List<String> out = new java.util.ArrayList<>();
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"([^\"]*)\"").matcher(s);
        while (m.find()) out.add(m.group(1));
        return out.toArray(new String[0]);
    }

    private static Double jsonScalar(String json, String key) {
        String s = slice(json, key);
        if (s == null) return null;
        try {
            return Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}

package com.vis.uvs.common;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/**
 * フレームインデックス（1-based）の集合演算と、Swing 版 {@code utils/Utils} の移植。
 *
 * <p>すべて純関数。ここが要約規則の土台なので、テストを厚く張ること。
 *
 * @see com.vis.uvs.analysis.SummaryComposer
 */
public final class Indices {

    private Indices() {
    }

    /** 和集合（昇順・重複なし）。null は空として扱う。 */
    public static List<Integer> merge(Collection<Integer> a, Collection<Integer> b) {
        Set<Integer> set = new TreeSet<>();
        if (a != null) {
            set.addAll(a);
        }
        if (b != null) {
            set.addAll(b);
        }
        return new ArrayList<>(set);
    }

    /** 差集合 {@code all - remove}（昇順・重複なし）。null は空として扱う。 */
    public static List<Integer> subtract(Collection<Integer> all, Collection<Integer> remove) {
        Set<Integer> set = new TreeSet<>();
        if (all != null) {
            set.addAll(all);
        }
        if (remove != null) {
            set.removeAll(remove);
        }
        return new ArrayList<>(set);
    }

    /**
     * 補集合。{@code 1..frameCount} のうち {@code list} に含まれないもの。
     *
     * <p>「残すインデックス」から「除外されたインデックス」を求めるのに使う。
     */
    public static List<Integer> oppose(Collection<Integer> list, int frameCount) {
        if (list == null) {
            return null;
        }
        Set<Integer> contained = list instanceof Set<Integer> s ? s : new java.util.HashSet<>(list);
        List<Integer> result = new ArrayList<>();
        for (int i = 1; i <= frameCount; i++) {
            if (!contained.contains(i)) {
                result.add(i);
            }
        }
        return result;
    }

    /**
     * {@code "1,5-8,12"} 形式をインデックス列へ展開する。
     *
     * <p>Swing 版 {@code Utils.str2indices} と同じ解釈。
     * 数字・カンマ・ハイフン以外は事前に除去される前提だが、ここでも寛容に読み飛ばす。
     */
    public static List<Integer> parse(String spec) {
        List<Integer> result = new ArrayList<>();
        if (spec == null || spec.isBlank()) {
            return result;
        }
        String sanitized = spec.replaceAll("[^0-9,\\-]", "");
        Set<Integer> set = new LinkedHashSet<>();
        for (String part : sanitized.split(",")) {
            String trimmed = part.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            int dash = trimmed.indexOf('-');
            if (dash > 0) {
                String[] range = trimmed.split("-");
                if (range.length == 2) {
                    try {
                        int start = Integer.parseInt(range[0].trim());
                        int end = Integer.parseInt(range[1].trim());
                        if (start <= end) {
                            for (int i = start; i <= end; i++) {
                                set.add(i);
                            }
                        }
                    } catch (NumberFormatException ignored) {
                        // 壊れた区間は捨てる（Swing 版と同じ）
                    }
                }
            } else {
                try {
                    set.add(Integer.parseInt(trimmed));
                } catch (NumberFormatException ignored) {
                    // 同上
                }
            }
        }
        result.addAll(set);
        java.util.Collections.sort(result);
        return result;
    }

    /**
     * インデックス列を {@code "1-3,5,8-10"} 形式へ畳む。
     *
     * <p>Swing 版 {@code Utils.listToIndicesString} と同じ出力。
     */
    public static String format(Collection<Integer> indices) {
        if (indices == null || indices.isEmpty()) {
            return "";
        }
        List<Integer> sorted = new ArrayList<>(new TreeSet<>(indices));
        StringBuilder sb = new StringBuilder();
        int i = 0;
        while (i < sorted.size()) {
            int start = sorted.get(i);
            int j = i;
            while (j + 1 < sorted.size() && sorted.get(j + 1) == sorted.get(j) + 1) {
                j++;
            }
            int end = sorted.get(j);
            if (sb.length() > 0) {
                sb.append(',');
            }
            if (start == end) {
                sb.append(start);
            } else {
                sb.append(start).append('-').append(end);
            }
            i = j + 1;
        }
        return sb.toString();
    }

    /**
     * 間引かれたスコアを全フレーム長へ<b>区分線形補間</b>する。
     *
     * <p>Swing 版 {@code Utils.interpolate} と同一。推論は {@code interval} フレームおき
     * （原本位置 {@code 1, 1+interval, 1+2*interval, ...}）にしか走らないため、
     * 間を線形で埋めてから閾値を当てる（{@code fw/analysis-pipeline.md} §6）。
     *
     * @param known    間引きフレームのスコア（原本位置の昇順）
     * @param size     原本の総フレーム数
     * @param interval サンプリング間隔
     */
    public static double[] interpolate(double[] known, int size, int interval) {
        if (known == null || known.length == 0) {
            throw new IllegalArgumentException("補間元のスコアが空です");
        }
        if (size <= 0) {
            return new double[0];
        }
        if (interval < 1) {
            throw new IllegalArgumentException("interval は 1 以上である必要があります: " + interval);
        }

        double[] result = new double[size];
        for (int i = 0; i < size; i++) {
            if (i == 0) {
                result[0] = known[0];
                continue;
            }
            if (i == size - 1) {
                result[size - 1] = known[known.length - 1];
                break;
            }
            if (i % interval == 0) {
                int k = i / interval;
                result[i] = k < known.length ? known[k] : known[known.length - 1];
            } else {
                int k = i / interval;
                if (k >= known.length - 1) {
                    result[i] = known[known.length - 1];
                    continue;
                }
                double start = known[k];
                double end = known[k + 1];
                int x1 = k * interval;
                double ratio = (double) (i - x1) / interval;
                result[i] = start + (end - start) * ratio;
            }
        }
        return result;
    }

    /**
     * パーセンタイル（最近接ランク間の線形補間）。
     *
     * <p>Swing 版 {@code Utils.percentile} と同一。ROI の足切りに使う。
     */
    public static double percentile(double[] data, double percentile) {
        if (data == null || data.length == 0) {
            return Double.NaN;
        }
        if (percentile < 0.0 || percentile > 100.0) {
            throw new IllegalArgumentException("パーセンタイルは 0.0〜100.0 で指定してください: " + percentile);
        }
        double[] sorted = Arrays.copyOf(data, data.length);
        Arrays.sort(sorted);
        int n = sorted.length;
        if (percentile == 0.0) {
            return sorted[0];
        }
        if (percentile == 100.0) {
            return sorted[n - 1];
        }
        double rank = (percentile / 100.0) * (n - 1);
        int lower = (int) Math.floor(rank);
        double fraction = rank - lower;
        if (lower < 0) {
            lower = 0;
        }
        if (lower >= n - 1) {
            return sorted[n - 1];
        }
        return sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower]);
    }

    /**
     * 秒 → フレーム数。
     *
     * <p>Swing 版 {@code Utils.frameStride} と同一。fps が 0 以下なら 30.0 とみなす。
     */
    public static int frameStride(double fps, double seconds) {
        double effective = fps > 0 ? fps : 30.0;
        return (int) Math.round(effective * seconds);
    }

    /** {@code 1..frameCount} の全インデックス。 */
    public static List<Integer> all(int frameCount) {
        List<Integer> list = new ArrayList<>(Math.max(0, frameCount));
        for (int i = 1; i <= frameCount; i++) {
            list.add(i);
        }
        return list;
    }
}

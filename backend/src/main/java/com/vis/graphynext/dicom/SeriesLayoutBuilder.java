package com.vis.graphynext.dicom;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * ファイル非依存の ZCT 導出アルゴリズム（単体テスト可能）。{@link SeriesLayoutBuilder.FrameMeta}
 * の一覧から {@link SeriesLayout} を組み立てる。
 *
 * <p>Cornerstone の {@code splitImageIdsBy4DTags}（IPP でグループ化 → 単一タグで分割）を、
 * T と C の 2 次元に拡張したもの。整合しなければ安全側（純 Z スタック／総当たり C 次元）へ。
 */
public final class SeriesLayoutBuilder {

    /** フレーム 1 枚分のメタ。dims のキーは下記候補名。 */
    public record FrameMeta(String sopInstanceUid, int instanceNumber, double zpos, Map<String, Double> dims) {
    }

    /** T 次元の候補（優先順）。 */
    private static final List<String> T_TAGS = List.of("Temporal", "Trigger");
    /** C 次元の候補（優先順）。 */
    private static final List<String> C_TAGS = List.of("Echo", "Bvalue", "EchoTime");

    private SeriesLayoutBuilder() {
    }

    public static SeriesLayout build(List<FrameMeta> frames) {
        int n = frames.size();
        if (n == 0) {
            return new SeriesLayout(0, 0, 0, null, null, List.of());
        }

        // Z: zpos を 0.001 単位で量子化してグループ化、昇順インデックス化。
        Map<Long, Integer> zIndex = new LinkedHashMap<>();
        TreeSet<Long> zKeys = new TreeSet<>();
        for (FrameMeta f : frames) {
            zKeys.add(zKey(f.zpos()));
        }
        int zi = 0;
        for (Long k : zKeys) {
            zIndex.put(k, zi++);
        }
        int nZ = zKeys.size();

        // 各 Z 位置のフレーム数が均一でなければ純スタックへフォールバック。
        Map<Long, List<FrameMeta>> byPos = new LinkedHashMap<>();
        for (FrameMeta f : frames) {
            byPos.computeIfAbsent(zKey(f.zpos()), x -> new ArrayList<>()).add(f);
        }
        int framesPerPos = n / nZ;
        boolean uniform = (nZ * framesPerPos == n) && byPos.values().stream().allMatch(l -> l.size() == framesPerPos);
        if (!uniform) {
            return pureStack(frames);
        }

        if (framesPerPos == 1) {
            List<SeriesLayout.Cell> cells = new ArrayList<>();
            for (FrameMeta f : frames) {
                cells.add(new SeriesLayout.Cell(0, zIndex.get(zKey(f.zpos())), 0, f.sopInstanceUid()));
            }
            return new SeriesLayout(nZ, 1, 1, null, null, cells);
        }

        // framesPerPos > 1: T/C の分割タグを探す。
        Split tFull = firstFullSplitter(byPos, framesPerPos, T_TAGS);
        if (tFull != null) {
            return assign(frames, zIndex, 1, framesPerPos, null, null, tFull, framesPerPos); // 4D 時間(nT)
        }
        Split cFull = firstFullSplitter(byPos, framesPerPos, C_TAGS);
        if (cFull != null) {
            return assign(frames, zIndex, framesPerPos, 1, null, null, cFull, framesPerPos); // 4D チャンネル(nC)
        }
        // 5D: T(部分) × C(部分) で framesPerPos を割り切れるか。
        for (String tTag : T_TAGS) {
            Split t = splitter(byPos, tTag);
            if (t == null || framesPerPos % t.k != 0) {
                continue;
            }
            int needC = framesPerPos / t.k;
            for (String cTag : C_TAGS) {
                Split c = splitter(byPos, cTag);
                if (c != null && c.k == needC) {
                    SeriesLayout out = assign(frames, zIndex, c.k, t.k, c, t, null, framesPerPos);
                    if (out != null) {
                        return out;
                    }
                }
            }
        }
        // どれも当てはまらなければ、各位置を InstanceNumber 順に並べた総当たり C 次元。
        return genericC(frames, zIndex, byPos, framesPerPos);
    }

    // --- 割り当て ---

    /** tFull/cFull は「位置内で完全分割」する単一タグ。c/t いずれか一方。 */
    private static SeriesLayout assign(List<FrameMeta> frames, Map<Long, Integer> zIndex, int nC, int nT,
                                       Split cSplit, Split tSplit, Split single, int framesPerPos) {
        // 値→index の昇順マップ
        Map<Double, Integer> cRank = cSplit != null ? rank(cSplit.values) : null;
        Map<Double, Integer> tRank = tSplit != null ? rank(tSplit.values) : null;
        Map<Double, Integer> singleRank = single != null ? rank(single.values) : null;

        List<SeriesLayout.Cell> cells = new ArrayList<>();
        boolean[][][] used = new boolean[Math.max(1, nC)][zIndex.size()][Math.max(1, nT)];
        for (FrameMeta f : frames) {
            int z = zIndex.get(zKey(f.zpos()));
            int c = 0;
            int t = 0;
            if (cSplit != null && tSplit != null) {
                c = cRank.get(f.dims().get(cSplit.tag));
                t = tRank.get(f.dims().get(tSplit.tag));
            } else if (single != null) {
                int r = singleRank.get(f.dims().get(single.tag));
                if (nT > 1) {
                    t = r;
                } else {
                    c = r;
                }
            }
            if (c >= nC || t >= nT || used[c][z][t]) {
                return null; // 重複＝整合しない
            }
            used[c][z][t] = true;
            cells.add(new SeriesLayout.Cell(c, z, t, f.sopInstanceUid()));
        }
        String cDim = cSplit != null ? cSplit.tag : (single != null && nC > 1 ? single.tag : null);
        String tDim = tSplit != null ? tSplit.tag : (single != null && nT > 1 ? single.tag : null);
        return new SeriesLayout(zIndex.size(), nC, nT, cDim, tDim, cells);
    }

    /** 各位置を InstanceNumber 順に並べ、その順位を C にする（総当たり）。 */
    private static SeriesLayout genericC(List<FrameMeta> frames, Map<Long, Integer> zIndex,
                                         Map<Long, List<FrameMeta>> byPos, int framesPerPos) {
        List<SeriesLayout.Cell> cells = new ArrayList<>();
        for (Map.Entry<Long, List<FrameMeta>> e : byPos.entrySet()) {
            List<FrameMeta> list = new ArrayList<>(e.getValue());
            list.sort(Comparator.comparingInt(FrameMeta::instanceNumber));
            int z = zIndex.get(e.getKey());
            for (int c = 0; c < list.size(); c++) {
                cells.add(new SeriesLayout.Cell(c, z, 0, list.get(c).sopInstanceUid()));
            }
        }
        return new SeriesLayout(zIndex.size(), framesPerPos, 1, null, null, cells);
    }

    /** 純 Z スタック（多次元を諦めて InstanceNumber/zpos 順に 1 列）。 */
    private static SeriesLayout pureStack(List<FrameMeta> frames) {
        List<FrameMeta> sorted = new ArrayList<>(frames);
        sorted.sort(Comparator.comparingDouble(FrameMeta::zpos).thenComparingInt(FrameMeta::instanceNumber));
        List<SeriesLayout.Cell> cells = new ArrayList<>();
        for (int z = 0; z < sorted.size(); z++) {
            cells.add(new SeriesLayout.Cell(0, z, 0, sorted.get(z).sopInstanceUid()));
        }
        return new SeriesLayout(sorted.size(), 1, 1, null, null, cells);
    }

    // --- 分割タグの判定 ---

    private record Split(String tag, List<Double> values, int k) {
    }

    /** 候補の中で、各位置を「ちょうど framesPerPos 通りの値」で完全分割する最初のタグ。 */
    private static Split firstFullSplitter(Map<Long, List<FrameMeta>> byPos, int framesPerPos, List<String> tags) {
        for (String tag : tags) {
            Split s = splitter(byPos, tag);
            if (s != null && s.k == framesPerPos) {
                return s;
            }
        }
        return null;
    }

    /**
     * tag が分割タグなら Split を返す。条件:
     * 全フレームに値があり、各位置グループ内の distinct 値集合がすべての位置で一致（同一集合）。
     */
    private static Split splitter(Map<Long, List<FrameMeta>> byPos, String tag) {
        TreeSet<Double> global = null;
        for (List<FrameMeta> group : byPos.values()) {
            TreeSet<Double> vals = new TreeSet<>();
            for (FrameMeta f : group) {
                Double v = f.dims().get(tag);
                if (v == null) {
                    return null;
                }
                vals.add(v);
            }
            if (global == null) {
                global = vals;
            } else if (!global.equals(vals)) {
                return null;
            }
        }
        if (global == null || global.size() < 2) {
            return null;
        }
        return new Split(tag, new ArrayList<>(global), global.size());
    }

    private static Map<Double, Integer> rank(List<Double> sortedValues) {
        Map<Double, Integer> m = new LinkedHashMap<>();
        for (int i = 0; i < sortedValues.size(); i++) {
            m.put(sortedValues.get(i), i);
        }
        return m;
    }

    private static long zKey(double zpos) {
        return Math.round(zpos * 1000.0);
    }
}

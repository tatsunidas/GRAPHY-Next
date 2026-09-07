/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 焼き込みマスク（Clean Pixel Data 用）の一時ストア（seriesUid 単位、in-memory）。
 *
 * <p>ROI は 2D viewer ウィンドウのメモリにあるため、viewer 側が ROI を画像ピクセル座標へ変換して
 * ここへ登録し、Anonymizer（MainScreen）が参照する（クロスウィンドウの橋渡し）。
 */
@Component
public class AnonymizeMaskStore {

    /** 画像ピクセル座標の矩形。 */
    public record Rect(int x, int y, int w, int h) {
    }

    /**
     * 画像ピクセル座標の<b>閉多角形</b>。矩形・楕円・円・ポリゴン・クローズドフリーハンドが
     * すべてこの形へ潰れる。
     *
     * <p>frontend の正本 {@code roiStats.ts} の {@code RoiMesh} と規約を揃える ——
     * <b>サブピクセル可</b>（丸めると 1px ずれる）、<b>始点を末尾で繰り返さない</b>
     * （辺 {@code n-1 → 0} は暗黙）。
     *
     * <p>🔴 <b>楕円は bbox で送らない。</b> ImageJ の交換型（{@code ImageJRoiDto}）は
     * 頂点の min/max から軸平行 bbox を作って楕円をそこに潰すため、<b>回転した楕円で
     * 塗り足りなくなる</b>（焼き込み文字が残るのに出力を見ても気づけない）。frontend の
     * {@code polygonizeEllipse} は半軸ベクトルで持つので回転しても正しく、頂点列で送れば
     * その正しさがそのまま届く。
     *
     * @param sopInstanceUids 適用先の SOP Instance UID。<b>空ならシリーズの全インスタンス</b>。
     *                        🔴 index ではなく UID で指定する —— index は並び順が変われば
     *                        別スライスを塗る。
     * @param frames          multi-frame 内のフレーム index（0 origin）。空なら全フレーム。
     */
    public record MaskPolygon(double[] xs, double[] ys, List<String> sopInstanceUids, List<Integer> frames) {

        /** この多角形がそのインスタンスに適用されるか。 */
        public boolean appliesTo(String sopInstanceUid) {
            return sopInstanceUids == null || sopInstanceUids.isEmpty()
                    || sopInstanceUids.contains(sopInstanceUid);
        }

        /** このフレームに適用されるか（{@code seriesFrames} はシリーズ既定）。 */
        public boolean appliesToFrame(int frame, List<Integer> seriesFrames) {
            List<Integer> f = (frames == null || frames.isEmpty()) ? seriesFrames : frames;
            return f == null || f.isEmpty() || f.contains(frame);
        }
    }

    /**
     * シリーズの焼き込み指定。frames が空なら全フレーム/全インスタンス。
     *
     * @param rects    旧形式（矩形のみ）。後方互換のため残す。読み出し時に多角形へ正規化する。
     * @param polygons 閉多角形。矩形も含めてこちらへ揃えるのが本筋。
     */
    public record SeriesMask(String seriesUid, List<Integer> frames, List<Rect> rects,
            List<MaskPolygon> polygons) {

        /** 旧形式（矩形のみ）のペイロードを受けるためのコンストラクタ。 */
        public SeriesMask(String seriesUid, List<Integer> frames, List<Rect> rects) {
            this(seriesUid, frames, rects, List.of());
        }

        /**
         * {@code rects} を多角形へ正規化して {@code polygons} と合わせた一覧。
         *
         * <p>これを通したあとは<b>多角形の 1 経路だけ</b>を見ればよい。矩形は 4 頂点の
         * 多角形と等価で、画素中心判定でも従来の {@code [x, x+w) × [y, y+h)} と一致する。
         */
        public List<MaskPolygon> allPolygons() {
            List<MaskPolygon> out = new ArrayList<>();
            if (rects != null) {
                for (Rect r : rects) {
                    out.add(new MaskPolygon(
                            new double[] { r.x(), r.x() + r.w(), r.x() + r.w(), r.x() },
                            new double[] { r.y(), r.y(), r.y() + r.h(), r.y() + r.h() },
                            List.of(), List.of()));
                }
            }
            if (polygons != null) {
                out.addAll(polygons);
            }
            return out;
        }
    }

    private final Map<String, SeriesMask> bySeries = new ConcurrentHashMap<>();

    public void put(SeriesMask mask) {
        if (mask != null && mask.seriesUid() != null) {
            bySeries.put(mask.seriesUid(), mask);
        }
    }

    public SeriesMask get(String seriesUid) {
        return bySeries.get(seriesUid);
    }

    public List<SeriesMask> get(List<String> seriesUids) {
        List<SeriesMask> out = new ArrayList<>();
        for (String s : seriesUids) {
            SeriesMask m = bySeries.get(s);
            if (m != null) {
                out.add(m);
            }
        }
        return out;
    }

    public void remove(String seriesUid) {
        bySeries.remove(seriesUid);
    }

    /** 登録されているマスクの件数（0 なら焼き込みは 1 画素も起きない）。 */
    public int size() {
        return bySeries.size();
    }

    public void clear() {
        bySeries.clear();
    }
}

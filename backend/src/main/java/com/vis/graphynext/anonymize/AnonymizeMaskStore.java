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
 * <p>ROI は 2D viewer ウィンドウのメモリにあるため、viewer 側が矩形ROIを画像ピクセル座標へ変換して
 * ここへ登録し、Anonymizer（MainScreen）が参照する（クロスウィンドウの橋渡し）。
 */
@Component
public class AnonymizeMaskStore {

    /** 画像ピクセル座標の矩形。 */
    public record Rect(int x, int y, int w, int h) {
    }

    /** シリーズの焼き込み指定。frames が空なら全フレーム/全インスタンス。 */
    public record SeriesMask(String seriesUid, List<Integer> frames, List<Rect> rects) {
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

    public void clear() {
        bySeries.clear();
    }
}

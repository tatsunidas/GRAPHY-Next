/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.activity;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/** 終了前の確認に出す「いま走っている処理」の集約と、全部の中止。 */
@Service
public class ActivityService {

    private static final Logger log = LoggerFactory.getLogger(ActivityService.class);

    /** kind: 種類キー、count: 件数、cancellable: 中止できるか（要求の処理中は false）。 */
    public record Item(String kind, int count, boolean cancellable) {}

    private final List<ActiveWork> works;
    private final InFlightRequests inFlight;

    public ActivityService(List<ActiveWork> works, InFlightRequests inFlight) {
        this.works = works;
        this.inFlight = inFlight;
    }

    public List<Item> snapshot() {
        List<Item> out = new ArrayList<>();
        for (ActiveWork w : works) {
            int n;
            try {
                n = w.activeCount();
            } catch (RuntimeException e) {
                // 数えられないものを「0 件」と見せない。1 件あるものとして出す（終了前の確認で見落とさない）
                log.warn("activity: {} の件数を取得できません", w.kind(), e);
                n = 1;
            }
            if (n > 0) out.add(new Item(w.kind(), n, w.cancellable()));
        }
        for (Map.Entry<String, Integer> e : inFlight.snapshot().entrySet()) {
            out.add(new Item(e.getKey(), e.getValue(), false));
        }
        out.sort(Comparator.comparing(Item::kind));
        return out;
    }

    /** 中止できるものを全部中止する。1 つが失敗しても残りは続ける。失敗した種類を返す。 */
    public List<String> cancelAll() {
        List<String> failed = new ArrayList<>();
        for (ActiveWork w : works) {
            try {
                if (w.activeCount() > 0 && w.cancellable()) w.cancelAll();
            } catch (RuntimeException e) {
                log.warn("activity: {} の中止に失敗しました", w.kind(), e);
                failed.add(w.kind());
            }
        }
        return failed;
    }
}

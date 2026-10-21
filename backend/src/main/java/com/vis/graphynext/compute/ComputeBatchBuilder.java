/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import org.springframework.http.HttpStatus;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 組ごとの入力から、匿名化済みのデータセットを作る（一括の作成と再実行で共通）。
 * 送れない組（焼き込み・格子など）はその組だけ外して理由を返し（黙って減らさない）、残りが一時フォルダに入るかを
 * 作れた分の平均から見積もる（数字は実測。件数の上限は置かない）。失敗したら作ったデータは全部捨てる。
 */
final class ComputeBatchBuilder {

    /** 作れた組（組名 → ハンドル。順序を保つ）・外した組・作ったハンドル全部。 */
    record Prepared(LinkedHashMap<String, List<String>> kept, List<Map<String, Object>> refused, List<String> all) {
    }

    /** 作れなかった。{@code status}・{@code body} はそのまま応答にできる。 */
    static final class Failure extends RuntimeException {
        final HttpStatus status;
        final Map<String, Object> body;

        Failure(HttpStatus status, Map<String, Object> body) {
            super(String.valueOf(body.get("error")));
            this.status = status;
            this.body = body;
        }
    }

    private final ComputeDatasetService datasets;

    ComputeBatchBuilder(ComputeDatasetService datasets) {
        this.datasets = datasets;
    }

    Prepared prepare(List<ComputeBatchController.BatchItem> items) {
        LinkedHashMap<String, List<String>> kept = new LinkedHashMap<>();
        List<Map<String, Object>> refused = new ArrayList<>();
        List<String> all = new ArrayList<>();
        try {
            int total = items.size();
            int processed = 0;
            long createdBytes = 0;
            for (ComputeBatchController.BatchItem it : items) {
                List<String> hs = new ArrayList<>();
                try {
                    for (ComputeEgressController.Input in : it.inputs()) {
                        ComputeDatasetService.Format f = ComputeDatasetService.Format
                                .of(in.format() == null ? "npz" : in.format())
                                .orElseThrow(() -> new ComputeDatasetService.DatasetRefused("bad-format", in.format()));
                        ComputeDatasetService.Dataset d = datasets.create(in.studyUid(), in.seriesUid(), f);
                        hs.add(d.handle());
                        all.add(d.handle());
                        createdBytes += d.bytes();
                    }
                    kept.put(it.key(), hs);
                } catch (ComputeDatasetService.DatasetRefused e) {
                    hs.forEach(datasets::discard);
                    all.removeAll(hs);
                    refused.add(Map.of("key", it.key(), "reason", e.reason()));
                }
                processed++;
                // 残りの組が一時フォルダに入るか。作れた分の平均から見積もる
                long need = kept.isEmpty() ? 0 : createdBytes / kept.size() * (total - processed);
                long free = datasets.usableSpace();
                if (need > free) {
                    all.forEach(datasets::discard);
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("ok", false);
                    out.put("error", "disk-insufficient");
                    out.put("neededBytes", need);
                    out.put("freeBytes", free);
                    throw new Failure(HttpStatus.UNPROCESSABLE_ENTITY, out);
                }
            }
            if (kept.isEmpty()) {
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("ok", false);
                out.put("error", "no-sendable-items");
                out.put("refused", refused);
                throw new Failure(HttpStatus.UNPROCESSABLE_ENTITY, out);
            }
            return new Prepared(kept, refused, all);
        } catch (Failure e) {
            throw e;
        } catch (RuntimeException e) {
            all.forEach(datasets::discard);
            throw e;
        }
    }

    void discard(List<String> handles) {
        handles.forEach(datasets::discard);
    }
}

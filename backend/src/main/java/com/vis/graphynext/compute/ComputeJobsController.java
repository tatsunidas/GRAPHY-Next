/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import org.springframework.context.annotation.Profile;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 計算ジョブの台帳（一覧・詳細・ログ・中止・行を消す）。standalone だけ（web では 404）。
 * 画面（計算ジョブの窓）が読む。患者名・患者 ID は返さない（画面が保管庫から UID で引く）。
 */
@RestController
@Profile("standalone")
@RequestMapping("/api/compute/jobs")
public class ComputeJobsController {

    private static final java.util.regex.Pattern JOB_ID = java.util.regex.Pattern.compile("cj_[0-9a-f-]{36}");

    private final ComputeJobLedger ledger;
    private final ComputeJobRunner runner;

    public ComputeJobsController(ComputeJobLedger ledger, ComputeJobRunner runner) {
        this.ledger = ledger;
        this.runner = runner;
    }

    @GetMapping
    public List<Map<String, Object>> list() {
        return ledger.list().stream().map(ledger::view).toList();
    }

    @GetMapping("/{id}")
    public ResponseEntity<Map<String, Object>> get(@PathVariable String id) {
        return known(id) ? ledger.find(id).map(j -> ResponseEntity.ok(ledger.view(j)))
                .orElseGet(() -> ResponseEntity.notFound().build()) : ResponseEntity.notFound().build();
    }

    /** {@code kind} は stdout / stderr / traceback。全文を返す。 */
    @GetMapping(value = "/{id}/log/{kind}", produces = MediaType.TEXT_PLAIN_VALUE + ";charset=UTF-8")
    public ResponseEntity<String> log(@PathVariable String id, @PathVariable String kind) {
        if (!known(id) || ledger.find(id).isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        return ledger.readLog(id, kind).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** 待ちなら計算機へ何も送らずに中止、実行中なら中断する。終わっていれば 409。 */
    @PostMapping("/{id}/cancel")
    public ResponseEntity<Map<String, Object>> cancel(@PathVariable String id) {
        if (!known(id) || ledger.find(id).isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        if (!runner.cancel(id)) {
            return ResponseEntity.status(409).body(Map.of("error", "not-cancellable"));
        }
        return ResponseEntity.accepted().body(ledger.find(id).map(ledger::view).orElse(Map.of()));
    }

    /** 終わった行とそのフォルダ（ログ・結果）を消す。終わっていなければ 409。 */
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        if (!known(id) || ledger.find(id).isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        try {
            ledger.delete(id);
        } catch (IllegalStateException e) {
            return ResponseEntity.status(409).build();
        }
        return ResponseEntity.noContent().build();
    }

    private static boolean known(String id) {
        return JOB_ID.matcher(id).matches();
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.emr;

import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 電子カルテ連携の状態と確認。standalone だけ（web では 404）。
 * 🔴 患者 ID を返すのは、画面に「いまの患者」を出すためだけ。ログには出さない。
 */
@RestController
@Profile("standalone")
@RequestMapping("/api/emr")
public class EmrController {

    /** 読み取りの確認の結果。ID は、全文でなく先頭と末尾だけ（確かめるには足りる）。 */
    public record CheckDto(boolean ok, String error, String hint) {
    }

    public record PatientDto(String id, long seq, long changedAt) {
    }

    public record StatusDto(boolean enabled, boolean valid, List<String> errors, boolean autoOpen,
                            EmrWatchService.FileState file, PatientDto patient, EmrPrefetchService.FetchState fetch) {
    }

    private final EmrWatchService watch;
    private final EmrPrefetchService prefetch;

    public EmrController(EmrWatchService watch, EmrPrefetchService prefetch) {
        this.watch = watch;
        this.prefetch = prefetch;
    }

    @GetMapping("/status")
    public StatusDto status() {
        EmrConfig cfg = watch.config();
        EmrWatchService.CurrentPatient p = watch.patient();
        return new StatusDto(cfg.enabled(), cfg.valid(), cfg.errors(), cfg.autoOpen(), watch.file(),
                p == null ? null : new PatientDto(p.id(), p.seq(), p.changedAt()), prefetch.state());
    }

    /** 保存した設定で、いまファイルから ID が読めるかを確かめる。 */
    @PostMapping("/check")
    public CheckDto check() {
        EmrFileReader.Result r = watch.readNow();
        return new CheckDto(r.ok(), r.error(), r.ok() ? hint(r.patientId()) : null);
    }

    /** いまの患者の過去検査を、もう一度取りに行く（［開く］を押したとき）。 */
    @PostMapping("/prefetch")
    public EmrPrefetchService.FetchState refetch() {
        EmrWatchService.CurrentPatient p = watch.patient();
        if (p != null) {
            prefetch.request(p.id(), p.seq());
        }
        return prefetch.state();
    }

    static String hint(String id) {
        int n = id.length();
        String h = n >= 6 ? id.substring(0, 2) + "…" + id.substring(n - 2) : id.substring(0, 1) + "…";
        return h + "（" + n + " 文字）";
    }
}

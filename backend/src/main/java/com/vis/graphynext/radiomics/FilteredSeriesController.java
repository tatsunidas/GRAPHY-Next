/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/** フィルタ画像（LoG の派生シリーズ）の作成。ジョブで投入してポーリングする。 */
@RestController
@RequestMapping("/api/series/filtered")
public class FilteredSeriesController {

    private final FilteredSeriesJobService jobs;

    public FilteredSeriesController(FilteredSeriesJobService jobs) {
        this.jobs = jobs;
    }

    @PostMapping("/jobs")
    public FilteredSeriesJobService.Status submit(@RequestBody FilteredSeriesRequest req) {
        try {
            return jobs.submit(req);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        } catch (IllegalStateException e) {
            // web モードで standalone 専用の機能を呼んだ
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, e.getMessage(), e);
        }
    }

    @GetMapping("/jobs/{jobId}")
    public FilteredSeriesJobService.Status get(@PathVariable String jobId) {
        FilteredSeriesJobService.Status s = jobs.get(jobId);
        if (s == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "不明なジョブです: " + jobId);
        }
        return s;
    }

    /** 取り消す。実際に止まるのは今のスケールを書き終えたところ（作り終えたシリーズは残る）。 */
    @DeleteMapping("/jobs/{jobId}")
    public FilteredSeriesJobService.Status cancel(@PathVariable String jobId) {
        FilteredSeriesJobService.Status s = jobs.cancel(jobId);
        if (s == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "不明なジョブです: " + jobId);
        }
        return s;
    }
}

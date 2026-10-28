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

import java.util.List;

/** ROI 特徴量の一括抽出のエンドポイント（組の候補を作り、確認した組を投入してポーリングする）。 */
@RestController
@RequestMapping("/api/radiomics/batch")
public class RadiomicsBatchController {

    private final RadiomicsBatchService batch;
    private final RadiomicsMode mode;

    public RadiomicsBatchController(RadiomicsBatchService batch, RadiomicsMode mode) {
        this.batch = batch;
        this.mode = mode;
    }

    @PostMapping("/plan")
    public List<BatchPair> plan(@RequestBody RadiomicsBatchService.PlanRequest req) {
        try {
            mode.require("ROI 特徴量の一括抽出");
            return batch.plan(req);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, e.getMessage(), e);
        }
    }

    @PostMapping("/jobs")
    public RadiomicsBatchService.Status submit(@RequestBody RadiomicsBatchService.BatchRequest req) {
        try {
            return batch.submit(req);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, e.getMessage(), e);
        }
    }

    @GetMapping("/jobs/{jobId}")
    public RadiomicsBatchService.Status get(@PathVariable String jobId) {
        RadiomicsBatchService.Status s = batch.get(jobId);
        if (s == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "不明なジョブです: " + jobId);
        }
        return s;
    }

    @GetMapping("/jobs/{jobId}/results")
    public List<RadiomicsBatchService.PairResult> results(@PathVariable String jobId) {
        List<RadiomicsBatchService.PairResult> r = batch.results(jobId);
        if (r == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "不明なジョブです: " + jobId);
        }
        return r;
    }

    @DeleteMapping("/jobs/{jobId}")
    public RadiomicsBatchService.Status cancel(@PathVariable String jobId) {
        RadiomicsBatchService.Status s = batch.cancel(jobId);
        if (s == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "不明なジョブです: " + jobId);
        }
        return s;
    }
}

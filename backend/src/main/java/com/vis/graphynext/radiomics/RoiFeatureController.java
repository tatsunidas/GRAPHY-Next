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

/** ROI 特徴量表のエンドポイント（投入してポーリングする）。 */
@RestController
@RequestMapping("/api/radiomics/features")
public class RoiFeatureController {

    private final RoiFeatureJobService jobs;

    public RoiFeatureController(RoiFeatureJobService jobs) {
        this.jobs = jobs;
    }

    @PostMapping("/jobs")
    public RoiFeatureJobService.Status submit(@RequestBody RoiFeatureRequest req) {
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
    public RoiFeatureJobService.Status get(@PathVariable String jobId) {
        RoiFeatureJobService.Status s = jobs.get(jobId);
        if (s == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "不明なジョブです: " + jobId);
        }
        return s;
    }

    @DeleteMapping("/jobs/{jobId}")
    public RoiFeatureJobService.Status cancel(@PathVariable String jobId) {
        RoiFeatureJobService.Status s = jobs.cancel(jobId);
        if (s == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "不明なジョブです: " + jobId);
        }
        return s;
    }
}

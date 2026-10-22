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
    private final MaxSectionService maxSection;

    public RoiFeatureController(RoiFeatureJobService jobs, MaxSectionService maxSection) {
        this.jobs = jobs;
        this.maxSection = maxSection;
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

    /** ROI の最大断面（前景の画素数が最大のスライス）。位置は患者座標の mm。 */
    @PostMapping("/max-section")
    public MaxSectionService.Result maxSection(@RequestBody MaxSectionService.Request req) {
        try {
            return maxSection.find(req);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, e.getMessage(), e);
        } catch (java.io.IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, e.getMessage(), e);
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

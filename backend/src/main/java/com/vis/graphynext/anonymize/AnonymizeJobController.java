/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** web の匿名化ジョブ API。standalone では存在しない（{@code /api/anonymizer/zip} などを使う）。 */
@RestController
@Profile("web")
@RequestMapping("/api/anonymizer/jobs")
public class AnonymizeJobController {

    /** 要求。{@code output} は {@code zip}（{@code stow} は PACS への保存で、別の段で対応）。 */
    public record JobRequest(List<String> studyUids, List<String> options, String replacePatientName,
            String replacePatientId, Long randomSeed, List<String> manualRetainTags,
            Map<String, String> customReplacements, boolean burnIn, String output,
            List<AnonymizeMaskStore.SeriesMask> masks) {
    }

    private static final int MAX_MASK_SERIES = 1000;

    private final AnonymizeJobService jobs;

    public AnonymizeJobController(AnonymizeJobService jobs) {
        this.jobs = jobs;
    }

    @PostMapping
    public AnonymizeJobService.Status submit(@RequestBody JobRequest req) {
        String output = req.output() == null || req.output().isBlank() ? "zip" : req.output();
        if (!"zip".equals(output)) {
            throw new ResponseStatusException(HttpStatus.NOT_IMPLEMENTED, "出力先 " + output + " は未対応です");
        }
        AnonymizeController.AnonRequest base = new AnonymizeController.AnonRequest(req.studyUids(), req.options(),
                req.replacePatientName(), req.replacePatientId(), req.randomSeed(), req.manualRetainTags(),
                req.customReplacements(), req.burnIn(), null);
        AnonymizeController.validate(base);
        AnonymizeConfig cfg = AnonymizeController.toConfig(base);
        Map<String, AnonymizeMaskStore.SeriesMask> masks = new HashMap<>();
        if (req.masks() != null) {
            if (req.masks().size() > MAX_MASK_SERIES) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "マスクのシリーズ数が多すぎます");
            }
            for (AnonymizeMaskStore.SeriesMask m : req.masks()) {
                if (m == null || m.seriesUid() == null) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "seriesUid が必要です");
                }
                AnonymizeController.validateMask(m);
                masks.put(m.seriesUid(), m);
            }
        }
        try {
            return jobs.submit(req.studyUids(), cfg, req.burnIn(), masks);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "ジョブを開始できません: " + e.getMessage());
        }
    }

    @GetMapping("/{id}")
    public AnonymizeJobService.Status status(@PathVariable String id) {
        AnonymizeJobService.Status s = jobs.status(id);
        if (s == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "ジョブが見つかりません（期限切れか、受け取り済みです）");
        }
        return s;
    }

    /** ZIP を渡す。渡し終えたらジョブごと消える（受け取れるのは1回だけ）。 */
    @GetMapping("/{id}/zip")
    public ResponseEntity<StreamingResponseBody> zip(@PathVariable String id) {
        AnonymizeJobService.Status s = jobs.status(id);
        if (s == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "ジョブが見つかりません（期限切れか、受け取り済みです）");
        }
        Path zip = jobs.zipOf(id);
        if (zip == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "ZIP はまだ（または作られませんでした）: " + s.state());
        }
        StreamingResponseBody body = out -> {
            try (var in = Files.newInputStream(zip)) {
                in.transferTo(out);
            }
            jobs.discard(id);
        };
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("application/zip"))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"anonymized.zip\"")
                .body(body);
    }

    @DeleteMapping("/{id}")
    public void cancel(@PathVariable String id) {
        if (!jobs.cancel(id)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "ジョブが見つかりません");
        }
    }
}

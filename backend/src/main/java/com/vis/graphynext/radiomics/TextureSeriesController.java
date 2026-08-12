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

import java.io.IOException;

/**
 * Texture（Radiomics 可視化マップ）生成エンドポイント。
 *
 * <p>入口は 2 つある。
 * <ul>
 *   <li>{@code POST /api/series/texture/jobs} … 計算を投入して即座に jobId を返し、
 *       {@code GET /api/series/texture/jobs/{id}} で進み具合を見る。<b>UI はこちらを使う</b>。
 *       マップ計算は分単位になりうるため（{@code fw/texture-radiomics-design.md} §11.6）。</li>
 *   <li>{@code POST /api/series/texture} … 終わるまで待つ従来どおりの経路。スクリプトやテストの
 *       ように待てる呼び出し向け。計算そのものは同じ実装を通る。</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/series")
public class TextureSeriesController {

    private final TextureSeriesService service;
    private final TextureJobService jobs;

    public TextureSeriesController(TextureSeriesService service, TextureJobService jobs) {
        this.service = service;
        this.jobs = jobs;
    }

    /** 終わるまで待つ経路。 */
    @PostMapping("/texture")
    public TextureSeriesService.Result createTexture(@RequestBody TextureSeriesRequest req) {
        try {
            return service.create(req);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Texture map generation failed", e);
        }
    }

    /** 計算を投入する。返るのは「まだ何も起きていない」状態。 */
    @PostMapping("/texture/jobs")
    public TextureJobService.Status submit(@RequestBody TextureSeriesRequest req) {
        return jobs.submit(req);
    }

    /** 進み具合と、終わっていれば結果。 */
    @GetMapping("/texture/jobs/{jobId}")
    public TextureJobService.Status status(@PathVariable String jobId) {
        TextureJobService.Status status = jobs.get(jobId);
        if (status == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "不明なジョブです: " + jobId);
        }
        return status;
    }

    /** キャンセルを頼む。実際に止まるのは走っているスライスが終わったところ。 */
    @DeleteMapping("/texture/jobs/{jobId}")
    public TextureJobService.Status cancel(@PathVariable String jobId) {
        TextureJobService.Status status = jobs.cancel(jobId);
        if (status == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "不明なジョブです: " + jobId);
        }
        return status;
    }
}

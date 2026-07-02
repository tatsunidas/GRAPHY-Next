/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.texture;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;

/**
 * Texture（Radiomics 可視化マップ）生成エンドポイント。
 *
 * <p>{@code POST /api/series/texture} でターゲット（＋任意マスク）から 1 特徴のマップを計算し、
 * 派生シリーズとして保存、新シリーズの UID を返す。
 */
@RestController
@RequestMapping("/api/series")
public class TextureSeriesController {

    private final TextureSeriesService service;

    public TextureSeriesController(TextureSeriesService service) {
        this.service = service;
    }

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
}

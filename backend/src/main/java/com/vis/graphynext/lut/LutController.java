/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.lut;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * LUT（カラールックアップテーブル）REST API。
 *
 * <ul>
 *   <li>{@code GET /api/luts}        → LUT名の一覧（昇順ソート）</li>
 *   <li>{@code GET /api/luts/{name}} → 指定 LUT の RGB 配列（各 256 値）</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/luts")
public class LutController {

    private final LutService lutService;

    public LutController(LutService lutService) {
        this.lutService = lutService;
    }

    /** LUT 名の一覧を返す（拡張子なし、昇順）。 */
    @GetMapping
    public List<String> listLuts() {
        return lutService.listNames();
    }

    /** 指定 LUT の RGB データを返す。見つからない場合は 404。 */
    @GetMapping("/{name}")
    public ResponseEntity<LutService.LutData> getLut(@PathVariable String name) {
        LutService.LutData data = lutService.load(name);
        if (data == null) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(data);
    }
}

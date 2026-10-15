/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** 監視フォルダの状態と手動走査（standalone のみ。web モードではこのクラスも Bean も無く 404）。 */
@RestController
@Profile("standalone")
@RequestMapping("/api/import/watch")
public class ImportWatchController {

    private final ImportWatchService service;

    public ImportWatchController(ImportWatchService service) {
        this.service = service;
    }

    @GetMapping("/status")
    public ImportWatchService.Status status() {
        return service.status();
    }

    @PostMapping("/scan")
    public ImportWatchService.Status scan() {
        return service.scanOnce();
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * ローカルインポート REST（standalone）。Electron がネイティブダイアログで選んだパスを受け取り取り込む。
 * web では実質使われない（クライアントのパスをサーバは読めない）。
 */
@RestController
@RequestMapping("/api/import")
@Profile("standalone") // サーバー上のパスを受けるので web では出さない（fw/security.md「サーバー上のパス」）
public class ImportController {

    private final ImportService service;

    public ImportController(ImportService service) {
        this.service = service;
    }

    @PostMapping("/paths")
    public ImportService.ImportResult importPaths(@RequestBody ImportRequest req) {
        return service.importPaths(req.paths());
    }

    public record ImportRequest(List<String> paths) {
    }
}

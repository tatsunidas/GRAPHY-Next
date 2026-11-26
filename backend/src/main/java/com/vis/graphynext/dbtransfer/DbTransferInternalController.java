/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbtransfer;

import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.Map;

/**
 * 外付けの荷物の取り込み。<b>Electron main だけ</b>が呼べる（{@code /api/internal/**} は
 * {@code MainChannelFilter} が守る）。
 *
 * <p>任意のフォルダを読んで DB に取り込む口なので、レンダラ（同じ realm のプラグインを含む）には開かない。
 * 取り込み元は、main が利用者にフォルダ選択のダイアログで選んでもらったものだけを渡す。
 */
@RestController
@Profile("standalone")
@RequestMapping("/api/internal/db-transfer/import")
public class DbTransferInternalController {

    public record FolderRequest(String folder) {
    }

    private final ExternalPackageImport imports;

    public DbTransferInternalController(ExternalPackageImport imports) {
        this.imports = imports;
    }

    @PostMapping("/scan")
    public ExternalPackageImport.ScanResult scan(@RequestBody FolderRequest req) throws IOException {
        return imports.scan(req.folder());
    }

    @PostMapping
    public Map<String, String> start(@RequestBody FolderRequest req) throws IOException {
        return Map.of("jobId", imports.start(req.folder()));
    }

    @GetMapping("/{jobId}")
    public ExternalPackageImport.JobStatus status(@PathVariable String jobId) {
        return imports.status(jobId);
    }
}

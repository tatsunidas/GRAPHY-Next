/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.microscopy;

import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;

/**
 * 顕微鏡の画素（Raw）を Confocal Microscopy Image（CFM・32 ビット・規格外）として取り込む（fw/microscopy-cfm.md）。
 * ローカル FS のパスなので standalone だけ。プラグインは H68（{@link PluginMicroscopyController}）を使う。
 *
 * <ul>
 *   <li>{@code POST /api/microscopy/import} … 1 チャネル＝1 シリーズとして取り込む</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/microscopy")
@Profile("standalone") // サーバー上のパスを受けるので web では出さない（fw/security.md「サーバー上のパス」）
public class MicroscopyImportController {

    private final MicroscopyImportService service;

    public MicroscopyImportController(MicroscopyImportService service) {
        this.service = service;
    }

    public record ImportResponse(String studyInstanceUid, String seriesInstanceUid, String frameOfReferenceUid,
                                 String specimenUid, int frames, String error) {
    }

    @PostMapping("/import")
    public ResponseEntity<ImportResponse> importChannel(@RequestBody MicroscopyImportService.ImportRequest req) {
        try {
            MicroscopyImportService.ImportResult r = service.importChannel(req, null);
            return ResponseEntity.ok(new ImportResponse(r.studyInstanceUid(), r.seriesInstanceUid(),
                    r.frameOfReferenceUid(), r.specimenUid(), r.frames(), null));
        } catch (IllegalArgumentException e) { // RawSpec.InvalidSpec も含む
            return bad(e.getMessage());
        } catch (IOException e) {
            return bad("取り込めません: " + e.getMessage());
        }
    }

    private static ResponseEntity<ImportResponse> bad(String msg) {
        return ResponseEntity.badRequest().body(new ImportResponse(null, null, null, null, 0, msg));
    }
}

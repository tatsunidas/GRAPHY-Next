/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;

/**
 * アンギオの解析結果を DICOM オブジェクトとして保存する API（{@code fw/angio-design.md} §14 / A10）。
 *
 * <ul>
 *   <li>{@code POST /api/angio/presentation-state} … XA/XRF GSPS（DSA 設定・VOI・計測描画・空間校正）</li>
 *   <li>{@code GET  /api/angio/presentation-state/{sop}} … 保管庫の GSPS を読んで適用可能な形にする</li>
 *   <li>{@code POST /api/angio/mp4} … フロントが焼いた PNG 列（ZIP）を MP4 にする</li>
 *   <li>{@code POST /api/angio/qca-sr} … QCA 計測値の Comprehensive SR</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/angio")
public class AngioController {

    private static final Logger log = LoggerFactory.getLogger(AngioController.class);

    private final AngioStoreService service;
    private final AngioMp4Service mp4;

    public AngioController(AngioStoreService service, AngioMp4Service mp4) {
        this.service = service;
        this.mp4 = mp4;
    }

    /**
     * PNG 列（ZIP）を MP4 にする（§14.3）。
     *
     * <p>🚨 <b>画像はフロントから来る。</b> 出したいのは「今見えている絵」——DSA の差分・
     * ピクセルシフト・W/L・白黒反転を当てた後の画像で、これらはフロントにしか無い。
     * 元の DICOM から作り直すと<b>画面と違う動画</b>が出る。
     *
     * <p>ffmpeg が無い環境では <b>422</b>（環境の問題であって、要求が壊れているわけではない）。
     */
    @PostMapping(value = "/mp4", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<byte[]> encodeMp4(
            @RequestBody byte[] zip,
            @RequestParam(name = "fps", defaultValue = "15") double fps) {
        if (zip == null || zip.length == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "フレームがありません");
        }
        try {
            byte[] out = mp4.encode(zip, fps);
            return ResponseEntity.ok()
                    .contentType(MediaType.parseMediaType("video/mp4"))
                    .body(out);
        } catch (AngioMp4Service.FfmpegUnavailableException e) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "ffmpeg が必要です");
        } catch (IOException e) {
            log.error("MP4 の生成に失敗", e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "MP4 を生成できませんでした");
        }
    }

    @PostMapping("/presentation-state")
    public ResponseEntity<AngioStoreService.Created> createPresentationState(
            @RequestBody AngioPresentationRequest req) {
        requireText(req.sopInstanceUid(), "sopInstanceUid");
        requireText(req.seriesInstanceUid(), "seriesInstanceUid");
        try {
            return ResponseEntity.ok(service.createPresentationState(req));
        } catch (IOException e) {
            log.error("GSPS の作成に失敗", e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "表示状態を保存できませんでした");
        }
    }

    /**
     * 保管庫の GSPS を読む（他社が書いたものを適用するための入口。§14.1）。
     *
     * <p>🚨 解釈しなかった項目は本文の {@code warnings} に入る。**呼び出し側は必ず出すこと**
     * ——黙って落とすと「適用したのに元と違う」になる。
     */
    @GetMapping("/presentation-state/{sopInstanceUid}")
    public ResponseEntity<XaPresentationState> readPresentationState(@PathVariable String sopInstanceUid) {
        requireText(sopInstanceUid, "sopInstanceUid");
        try {
            return ResponseEntity.ok(service.readPresentationState(sopInstanceUid));
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        } catch (IOException e) {
            log.warn("GSPS を読めませんでした {}", sopInstanceUid, e);
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "表示状態を読み込めませんでした");
        }
    }

    @PostMapping("/qca-sr")
    public ResponseEntity<AngioStoreService.Created> createQcaSr(@RequestBody QcaSrRequest req) {
        requireText(req.sopInstanceUid(), "sopInstanceUid");
        try {
            return ResponseEntity.ok(service.createQcaSr(req));
        } catch (IOException e) {
            log.error("QCA SR の作成に失敗", e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "解析結果を保存できませんでした");
        }
    }

    @PostMapping("/qlv-sr")
    public ResponseEntity<AngioStoreService.Created> createQlvSr(@RequestBody QlvSrRequest req) {
        requireText(req.sopInstanceUid(), "sopInstanceUid");
        try {
            return ResponseEntity.ok(service.createQlvSr(req));
        } catch (IOException e) {
            log.error("QLV SR の作成に失敗", e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "解析結果を保存できませんでした");
        }
    }

    @PostMapping("/qca3d-sr")
    public ResponseEntity<AngioStoreService.Created> createQca3dSr(@RequestBody Qca3dSrRequest req) {
        requireText(req.viewASopInstanceUid(), "viewASopInstanceUid");
        requireText(req.viewBSopInstanceUid(), "viewBSopInstanceUid");
        try {
            return ResponseEntity.ok(service.createQca3dSr(req));
        } catch (IOException e) {
            log.error("3D QCA SR の作成に失敗", e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "解析結果を保存できませんでした");
        }
    }

    /**
     * プラグインが書くアンギオ解析 SR（H37 ／ {@code fw/angio-design.md} §22.3 の G3）。
     *
     * <p>本体の 4 エンドポイントと**同じ writer** を使う。違いは出所（プラグイン id・版）を
     * 必ず刻むことだけ。**同意ダイアログはフロント側で必ず挟む**（抑止不可・H4b / H9 と同じ）。
     */
    @PostMapping("/plugin-sr")
    public ResponseEntity<AngioStoreService.Created> createPluginSr(@RequestBody AngioPluginSrRequest req) {
        try {
            return ResponseEntity.ok(service.createPluginSr(req));
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        } catch (IOException e) {
            log.error("プラグインのアンギオ SR 作成に失敗", e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "解析結果を保存できませんでした");
        }
    }

    /**
     * プラグインが書く XA GSPS（H38 ／ {@code fw/angio-design.md} §22.3 の G4）。
     * 書き手は本体の経路と同じで、出所（プラグイン id・版）が必ず入る。
     */
    @PostMapping("/plugin-presentation-state")
    public ResponseEntity<AngioStoreService.Created> createPluginPresentationState(
            @RequestBody AngioPluginPresentationRequest req) {
        try {
            return ResponseEntity.ok(service.createPluginPresentationState(req));
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        } catch (IOException e) {
            log.error("プラグインの GSPS 作成に失敗", e);
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "表示状態を保存できませんでした");
        }
    }

    private static void requireText(String v, String name) {
        if (v == null || v.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, name + " は必須です");
        }
    }
}

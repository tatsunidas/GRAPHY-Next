/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.roi;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * ROI（幾何注釈）永続化の REST（`fw/roi-manager-design.md` M5）。
 *
 * <ul>
 *   <li>{@code GET /api/rois/{patientKey}} … 読み出し（未保存でも 200 で空の器を返す）</li>
 *   <li>{@code PUT /api/rois/{patientKey}} … 保存（楽観ロック。版が古ければ 409）</li>
 *   <li>{@code DELETE /api/rois/{patientKey}} … 全削除</li>
 * </ul>
 *
 * <p>{@code patientKey} はフロントの同一患者判定キー（PatientID → PatientName → StudyInstanceUID）。
 *
 * <h3>🔴 キーはパスではなくクエリで渡す（{@code ?patientKey=...}）</h3>
 * PatientID には {@code /} が普通に入る（実データ {@code D97258/11053}）。URL エンコードして
 * {@code %2F} にしても、<b>Tomcat が経路の段で 400 を返す</b>（既定で符号化スラッシュを拒否する。
 * Spring まで届かないので CORS ヘッダも付かず、ブラウザには「CORS エラー」に見える）。
 * 実測（2026-08-26）: {@code GET /api/rois/PLAIN123} → 200、
 * {@code GET /api/rois/D97258%2F11053} → <b>400</b>。
 *
 * <p>結果として<b>その患者だけ ROI が永続化されない</b>——画面には何も出ず、
 * 描いた注釈が黙って消える。Tomcat を緩めるのは経路解釈全体を弱めるので採らず、
 * <b>キーをクエリに移した</b>。パス版は互換のために残すが、{@code /} を含むキーは表現できない。
 */
@RestController
@RequestMapping("/api/rois")
public class RoiDocumentController {

    private final RoiDocumentService service;

    public RoiDocumentController(RoiDocumentService service) {
        this.service = service;
    }

    /** 正。キーはクエリで渡す（{@code /} を含むキーはこちらでしか表現できない）。 */
    @GetMapping
    public RoiDocumentDto getByQuery(@RequestParam String patientKey) {
        return service.get(patientKey);
    }

    @PutMapping
    public RoiDocumentDto saveByQuery(@RequestParam String patientKey, @RequestBody SaveRoiDocumentRequest req) {
        return service.save(patientKey, req);
    }

    @DeleteMapping
    public void deleteByQuery(@RequestParam String patientKey) {
        service.delete(patientKey);
    }

    /** 互換のためのパス版。**{@code /} を含むキーには使えない**（上のクラスコメント）。 */
    @GetMapping("/{patientKey}")
    public RoiDocumentDto get(@PathVariable String patientKey) {
        return service.get(patientKey);
    }

    @PutMapping("/{patientKey}")
    public RoiDocumentDto save(@PathVariable String patientKey, @RequestBody SaveRoiDocumentRequest req) {
        return service.save(patientKey, req);
    }

    @DeleteMapping("/{patientKey}")
    public void delete(@PathVariable String patientKey) {
        service.delete(patientKey);
    }
}

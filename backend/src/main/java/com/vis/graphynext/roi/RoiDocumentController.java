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
 * PatientID に {@code /} 等が入り得るので、フロントは必ず URL エンコードして渡す。
 */
@RestController
@RequestMapping("/api/rois")
public class RoiDocumentController {

    private final RoiDocumentService service;

    public RoiDocumentController(RoiDocumentService service) {
        this.service = service;
    }

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

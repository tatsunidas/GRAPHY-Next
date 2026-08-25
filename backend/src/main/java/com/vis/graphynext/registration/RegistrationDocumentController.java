/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.registration;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 位置合わせ記録の保管 REST（{@code /api/registrations/{patientKey}}）。
 *
 * <p>用途は「開き直したときに同じ重ね合わせを復元する」こと。可搬な正式記録である
 * DICOM SRO とは別で、こちらはアプリ内の再現性を担う。
 *
 * <h3>🔴 キーはパスではなくクエリで渡す（{@code ?patientKey=...}）</h3>
 * PatientID には {@code /} が普通に入る。URL エンコードしても <b>Tomcat が経路の段で 400</b>
 * を返すため、<b>その患者だけ位置合わせが復元されない</b>（実測・2026-08-26）。
 * パス版は互換のために残すが、{@code /} を含むキーは表現できない。
 */
@RestController
@RequestMapping("/api/registrations")
public class RegistrationDocumentController {

    private final RegistrationDocumentService service;

    public RegistrationDocumentController(RegistrationDocumentService service) {
        this.service = service;
    }

    /** 正。キーはクエリで渡す（{@code /} を含むキーはこちらでしか表現できない）。 */
    @GetMapping
    public RegistrationDocumentDto getByQuery(@RequestParam String patientKey) {
        return service.get(patientKey);
    }

    @PostMapping
    public RegistrationDocumentDto saveByQuery(@RequestParam String patientKey,
                                               @RequestBody SaveRegistrationDocumentRequest req) {
        return service.save(patientKey, req);
    }

    @DeleteMapping
    public void deleteByQuery(@RequestParam String patientKey) {
        service.delete(patientKey);
    }

    /** 互換のためのパス版。**{@code /} を含むキーには使えない**。 */
    @GetMapping("/{patientKey}")
    public RegistrationDocumentDto get(@PathVariable String patientKey) {
        return service.get(patientKey);
    }

    @PostMapping("/{patientKey}")
    public RegistrationDocumentDto save(@PathVariable String patientKey,
                                        @RequestBody SaveRegistrationDocumentRequest req) {
        return service.save(patientKey, req);
    }

    @DeleteMapping("/{patientKey}")
    public void delete(@PathVariable String patientKey) {
        service.delete(patientKey);
    }
}

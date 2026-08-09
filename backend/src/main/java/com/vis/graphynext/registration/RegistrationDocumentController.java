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
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 位置合わせ記録の保管 REST（{@code /api/registrations/{patientKey}}）。
 *
 * <p>用途は「開き直したときに同じ重ね合わせを復元する」こと。可搬な正式記録である
 * DICOM SRO とは別で、こちらはアプリ内の再現性を担う。
 */
@RestController
@RequestMapping("/api/registrations")
public class RegistrationDocumentController {

    private final RegistrationDocumentService service;

    public RegistrationDocumentController(RegistrationDocumentService service) {
        this.service = service;
    }

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

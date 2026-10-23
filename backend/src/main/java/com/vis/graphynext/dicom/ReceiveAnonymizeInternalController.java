/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.anonymize.ReceiveAnonymizer;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;

/**
 * 仮名の鍵の書き出し。鍵は再識別に使えるので、通常の API には出さず、{@code /api/internal/**}
 * （Electron main だけに開く）に置く。
 */
@RestController
@RequestMapping("/api/internal/dicom/receive-anonymize")
@Profile("standalone")
public class ReceiveAnonymizeInternalController {

    private final ReceiveAnonymizer anonymizer;

    public ReceiveAnonymizeInternalController(ReceiveAnonymizer anonymizer) {
        this.anonymizer = anonymizer;
    }

    @GetMapping("/key")
    public ResponseEntity<byte[]> key() throws IOException {
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"receive-anon.key\"")
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .body(anonymizer.exportKey());
    }
}

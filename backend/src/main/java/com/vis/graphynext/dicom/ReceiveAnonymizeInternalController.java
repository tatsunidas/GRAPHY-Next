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
import java.util.Base64;
import java.util.Map;

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

    /** main（{@code computeBridge.call}）は JSON しか読めないので、鍵は base64 の JSON で返す。 */
    @GetMapping("/key")
    public ResponseEntity<Map<String, String>> key() throws IOException {
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_JSON)
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .body(Map.of("key", Base64.getEncoder().encodeToString(anonymizer.exportKey())));
    }
}

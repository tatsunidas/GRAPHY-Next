/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.fasterxml.jackson.core.JsonProcessingException;
import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * DIMSE TLS のパスワードを Electron main とやりとりする口。{@code /api/internal/**} なので
 * {@code MainChannelFilter} が main だけに開く。パスワードは main が OS のキーチェーンに預ける。
 */
@RestController
@RequestMapping("/api/internal/dicom")
@Profile("standalone")
public class DicomTlsInternalController {

    private final DicomTlsService tls;

    public DicomTlsInternalController(DicomTlsService tls) {
        this.tls = tls;
    }

    /** null は変えない・空文字は消す。persistPlaintext はキーチェーンが無い環境だけ（設定に平文で保存する）。 */
    public record SecretsRequest(String keyStorePassword, String trustStorePassword, boolean persistPlaintext) {
    }

    @PutMapping("/tls-secrets")
    public Map<String, Boolean> putSecrets(@RequestBody SecretsRequest req) throws JsonProcessingException {
        tls.putSecrets(req.keyStorePassword(), req.trustStorePassword(), req.persistPlaintext());
        return Map.of("ok", true);
    }

    /** 設定に平文で残っているパスワード（移行用）。 */
    @GetMapping("/tls-legacy-secrets")
    public Map<String, String> legacy() {
        return tls.legacyPlaintext();
    }

    /** main がキーチェーンへ移し終えたあとに呼ぶ。設定と DB の旧来の行から平文を消す。 */
    @PostMapping("/tls-legacy-secrets/clear")
    public Map<String, Boolean> clearLegacy() throws JsonProcessingException {
        tls.clearLegacyPlaintext();
        return Map.of("ok", true);
    }
}

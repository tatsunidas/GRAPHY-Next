/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * DIMSE TLS のパスワード（standalone で Electron main が OS のキーチェーンから渡したもの）。メモリにだけ持つ。
 *
 * <p>TLS の受信（SCP）は起動の途中でキーストアを開くので、main は backend を起動するときに環境変数で渡す
 * （起動引数は {@code ps} で他のユーザーにも見えるので使わない）。起動中の変更は main だけが通れる
 * {@code /api/internal/dicom/tls-secrets} で入れ直す。null は「渡されていない」（保存された値・既定を使う）。
 */
@Component
public class DicomTlsSecrets {

    private volatile String keyStorePassword;
    private volatile String trustStorePassword;

    public DicomTlsSecrets(@Value("${GRAPHY_TLS_KEY_STORE_PASSWORD:#{null}}") String keyStorePassword,
                           @Value("${GRAPHY_TLS_TRUST_STORE_PASSWORD:#{null}}") String trustStorePassword) {
        this.keyStorePassword = blankToNull(keyStorePassword);
        this.trustStorePassword = blankToNull(trustStorePassword);
    }

    public String keyStorePassword() {
        return keyStorePassword;
    }

    public String trustStorePassword() {
        return trustStorePassword;
    }

    /** null の引数は変えない。空文字は消す。 */
    public void update(String keyStore, String trustStore) {
        if (keyStore != null) {
            keyStorePassword = blankToNull(keyStore);
        }
        if (trustStore != null) {
            trustStorePassword = blankToNull(trustStore);
        }
    }

    private static String blankToNull(String s) {
        return s == null || s.isEmpty() ? null : s;
    }
}

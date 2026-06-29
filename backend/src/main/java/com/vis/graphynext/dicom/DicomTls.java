/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.net.Connection;
import org.dcm4che3.net.Device;

import java.io.File;

/**
 * {@link DicomProperties.Tls} を dcm4che の {@link Device} / {@link Connection} へ適用する共通ヘルパ。
 * SCP（listener）と SCU（送信）の両方から再利用する。GRAPHY の DicomTlsConfig と同じ方針。
 */
public final class DicomTls {

    private DicomTls() {
    }

    /** 自局の key-store（鍵+証明書）と trust-store（信頼する相手）を Device へ設定する。 */
    public static void applyKeyMaterial(Device device, DicomProperties.Tls tls) {
        device.setKeyStoreURL(toUrl(tls.getKeyStore()));
        device.setKeyStoreType(tls.getKeyStoreType());
        device.setKeyStorePin(tls.getKeyStorePassword());
        device.setKeyStoreKeyPin(tls.getKeyStorePassword());
        device.setTrustStoreURL(toUrl(tls.getTrustStore()));
        device.setTrustStoreType(tls.getTrustStoreType());
        device.setTrustStorePin(tls.getTrustStorePassword());
    }

    /**
     * Connection に TLS を適用する。cipher suites を設定すると {@code isTls()} が true になり TLS 化される。
     *
     * @param needClientAuth listener=true（相互TLS）、SCU=false
     */
    public static void applyToConnection(Connection c, DicomProperties.Tls tls, boolean needClientAuth) {
        c.setTlsCipherSuites(tls.getCipherSuites().toArray(String[]::new));
        if (tls.getProtocols() != null && !tls.getProtocols().isEmpty()) {
            c.setTlsProtocols(tls.getProtocols().toArray(String[]::new));
        }
        c.setTlsNeedClientAuth(needClientAuth);
    }

    /** ローカルパスを dcm4che が受け付ける URL(file:...) に変換する。 */
    static String toUrl(String path) {
        if (path == null) {
            return null;
        }
        if (path.startsWith("file:") || path.contains("://")) {
            return path;
        }
        return new File(path).toURI().toString();
    }
}

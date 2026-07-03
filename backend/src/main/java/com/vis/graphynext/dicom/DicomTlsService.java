/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.settings.SettingsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * DIMSE の相互 TLS（自局の鍵材料）設定を解決・保存するサービス。
 *
 * <p>既定値は application.yml の {@code graphy.dicom.tls}（{@link DicomProperties.Tls}）。
 * GUI（環境設定「DICOM 通信先」）から編集した分は Settings(H2) の {@link #TLS_KEY} に JSON で保存され、
 * 保存があれば <b>YAML 既定より優先</b>される（{@link #effective()}）。C-ECHO / C-STORE / Query-Retrieve の
 * SCU 送信と、SCP リスナーの TLS 有効化はいずれもこの実効設定を用いる。
 *
 * <p>SCU 送信（echo/send/QR）は呼び出しごとに実効設定を読むため即時反映。SCP の TLS リスナーは起動時に
 * バインドするため、変更の反映にはアプリ再起動が要る（GRAPHY と同様）。
 */
@Service
public class DicomTlsService {

    private static final Logger log = LoggerFactory.getLogger(DicomTlsService.class);

    /** Settings(H2) にグローバル TLS 設定を JSON で保存するキー。 */
    public static final String TLS_KEY = "dicom.tls";

    private final DicomProperties props;
    private final SettingsService settings;
    private final ObjectMapper mapper;

    public DicomTlsService(DicomProperties props, SettingsService settings, ObjectMapper mapper) {
        this.props = props;
        this.settings = settings;
        this.mapper = mapper;
    }

    /** 現在有効な TLS 設定。H2 に保存があればそれを、無ければ application.yml の既定を返す。 */
    public DicomProperties.Tls effective() {
        try {
            String json = settings.getAll().get(TLS_KEY);
            if (json == null || json.isBlank()) {
                return props.getTls();
            }
            return mapper.readValue(json, TlsConfigDto.class).toTls();
        } catch (Exception e) {
            // DB 未準備・JSON 破損など。いずれも YAML 既定へフォールバック（起動を止めない）。
            log.warn("TLS 設定（Settings {}）の解決に失敗（YAML 既定を使用）: {}", TLS_KEY, e.toString());
            return props.getTls();
        }
    }

    /** 実効設定を DTO で返す（GUI 表示用。usable は算出値）。 */
    public TlsConfigDto get() {
        return TlsConfigDto.from(effective());
    }

    /** GUI から編集した TLS 設定を H2 に保存し、実効設定（usable 再計算済み）を返す。 */
    public TlsConfigDto save(TlsConfigDto dto) throws JsonProcessingException {
        settings.putAll(Map.of(TLS_KEY, mapper.writeValueAsString(dto)));
        return get();
    }

    /**
     * TLS 設定の入出力 DTO。{@code usable} は算出値（出力のみ・保存時は無視される）。
     * パスワードは standalone 前提で平文保存・返却する（GRAPHY と同様）。
     */
    public record TlsConfigDto(
            boolean enabled,
            int port,
            String keyStore,
            String keyStorePassword,
            String keyStoreType,
            String trustStore,
            String trustStorePassword,
            String trustStoreType,
            List<String> protocols,
            List<String> cipherSuites,
            boolean needClientAuth,
            boolean usable) {

        public DicomProperties.Tls toTls() {
            DicomProperties.Tls t = new DicomProperties.Tls();
            t.setEnabled(enabled);
            t.setPort(port <= 0 ? 2762 : port);
            t.setKeyStore(keyStore == null ? "" : keyStore);
            t.setKeyStorePassword(keyStorePassword == null ? "" : keyStorePassword);
            t.setKeyStoreType(keyStoreType == null || keyStoreType.isBlank() ? "PKCS12" : keyStoreType);
            t.setTrustStore(trustStore == null ? "" : trustStore);
            t.setTrustStorePassword(trustStorePassword == null ? "" : trustStorePassword);
            t.setTrustStoreType(trustStoreType == null || trustStoreType.isBlank() ? "PKCS12" : trustStoreType);
            if (protocols != null && !protocols.isEmpty()) {
                t.setProtocols(new ArrayList<>(protocols));
            }
            if (cipherSuites != null && !cipherSuites.isEmpty()) {
                t.setCipherSuites(new ArrayList<>(cipherSuites));
            }
            t.setNeedClientAuth(needClientAuth);
            return t;
        }

        public static TlsConfigDto from(DicomProperties.Tls t) {
            return new TlsConfigDto(
                    t.isEnabled(), t.getPort(),
                    t.getKeyStore(), t.getKeyStorePassword(), t.getKeyStoreType(),
                    t.getTrustStore(), t.getTrustStorePassword(), t.getTrustStoreType(),
                    new ArrayList<>(t.getProtocols()), new ArrayList<>(t.getCipherSuites()),
                    t.isNeedClientAuth(), t.isUsable());
        }
    }
}

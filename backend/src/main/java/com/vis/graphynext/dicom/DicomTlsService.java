/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.vis.graphynext.compute.MainChannelFilter;
import com.vis.graphynext.settings.SettingsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * DIMSE の相互 TLS（自局の鍵材料）設定を解決・保存するサービス。
 *
 * <p>既定値は application.yml の {@code graphy.dicom.tls}（{@link DicomProperties.Tls}）。
 * GUI（環境設定「DICOM 通信先」）から編集した分は Settings の {@link #TLS_KEY} に JSON で保存され、
 * 保存があれば <b>YAML 既定より優先</b>される（{@link #effective()}）。C-ECHO / C-STORE / Query-Retrieve の
 * SCU 送信と、SCP リスナーの TLS 有効化はいずれもこの実効設定を用いる。
 *
 * <p>SCU 送信（echo/send/QR）は呼び出しごとに実効設定を読むため即時反映。SCP の TLS リスナーは起動時に
 * バインドするため、変更の反映にはアプリ再起動が要る（GRAPHY と同様）。
 *
 * <p>🔴 パスワードは API で返さない（画面と同じ場所で動くプラグインからも読めるため）。standalone では
 * OS のキーチェーン（Electron main）に預け、{@link DicomTlsSecrets} でメモリにだけ持つ。
 * キーチェーンが無い環境と web モードは、従来どおり設定に保存する。
 */
@Service
public class DicomTlsService {

    private static final Logger log = LoggerFactory.getLogger(DicomTlsService.class);

    /** Settings にグローバル TLS 設定を JSON で保存するキー。 */
    public static final String TLS_KEY = "dicom.tls";
    private static final String KS = "keyStorePassword";
    private static final String TS = "trustStorePassword";

    private final DicomProperties props;
    private final SettingsService settings;
    private final ObjectMapper mapper;
    private final DicomTlsSecrets secrets;
    private final MainChannelFilter mainChannel;

    public DicomTlsService(DicomProperties props, SettingsService settings, ObjectMapper mapper,
                           DicomTlsSecrets secrets, MainChannelFilter mainChannel) {
        this.props = props;
        this.settings = settings;
        this.mapper = mapper;
        this.secrets = secrets;
        this.mainChannel = mainChannel;
    }

    /**
     * 現在有効な TLS 設定。保存があればそれを、無ければ application.yml の既定を土台にし、
     * main から渡されたパスワード（{@link DicomTlsSecrets}）があればそれを重ねる。
     */
    public DicomProperties.Tls effective() {
        DicomProperties.Tls t = stored().toTls();
        if (secrets.keyStorePassword() != null) {
            t.setKeyStorePassword(secrets.keyStorePassword());
        }
        if (secrets.trustStorePassword() != null) {
            t.setTrustStorePassword(secrets.trustStorePassword());
        }
        return t;
    }

    /** 画面に返す設定。🔴 パスワードは返さない（設定済みかどうかだけ）。 */
    public TlsConfigDto get() {
        DicomProperties.Tls t = effective();
        return TlsConfigDto.from(t).withoutPasswords(!t.getKeyStorePassword().isEmpty(),
                !t.getTrustStorePassword().isEmpty());
    }

    /**
     * 画面から編集した TLS 設定を保存する。パスワードは null なら今の値を保ち、空文字なら消す。
     *
     * <p>standalone で main の口があるとき（＝Electron から起動）は、パスワードを受け付けない。
     * OS のキーチェーンに預ける経路（main の {@code graphy:tls-password-set}）だけを使わせる。
     */
    public TlsConfigDto save(TlsConfigDto dto) throws JsonProcessingException {
        if (mainChannel.enabled() && (dto.keyStorePassword() != null || dto.trustStorePassword() != null)) {
            throw new IllegalArgumentException("tls-password-via-keychain");
        }
        TlsConfigDto cur = stored();
        TlsConfigDto next = dto.withPasswords(
                dto.keyStorePassword() == null ? cur.keyStorePassword() : dto.keyStorePassword(),
                dto.trustStorePassword() == null ? cur.trustStorePassword() : dto.trustStorePassword());
        settings.putAll(Map.of(TLS_KEY, mapper.writeValueAsString(next)));
        return get();
    }

    /** main から渡されたパスワードをメモリに入れる。persistPlaintext はキーチェーンの無い環境の代わりの経路。 */
    public void putSecrets(String keyStore, String trustStore, boolean persistPlaintext)
            throws JsonProcessingException {
        secrets.update(keyStore, trustStore);
        if (persistPlaintext) {
            TlsConfigDto cur = stored();
            TlsConfigDto next = cur.withPasswords(keyStore == null ? cur.keyStorePassword() : keyStore,
                    trustStore == null ? cur.trustStorePassword() : trustStore);
            settings.putAll(Map.of(TLS_KEY, mapper.writeValueAsString(next)));
        }
    }

    /** 設定に平文で残っているパスワード（移行用。main がキーチェーンへ移す）。 */
    public Map<String, String> legacyPlaintext() {
        TlsConfigDto cur = stored();
        Map<String, String> m = new LinkedHashMap<>();
        if (cur.keyStorePassword() != null && !cur.keyStorePassword().isEmpty()) {
            m.put(KS, cur.keyStorePassword());
        }
        if (cur.trustStorePassword() != null && !cur.trustStorePassword().isEmpty()) {
            m.put(TS, cur.trustStorePassword());
        }
        return m;
    }

    /** 設定（共通ファイル）と DB に残る旧来の行の両方から、平文のパスワードを消す。 */
    public void clearLegacyPlaintext() throws JsonProcessingException {
        String json = settings.getAll().get(TLS_KEY);
        if (json != null && !json.isBlank()) {
            settings.putAll(Map.of(TLS_KEY, stripPasswords(json)));
        }
        settings.rewriteDbRow(TLS_KEY, v -> {
            try {
                return stripPasswords(v);
            } catch (JsonProcessingException e) {
                throw new IllegalStateException("TLS 設定（DB の行）を読めません", e);
            }
        });
    }

    /** 設定の API が返す前に、{@code dicom.tls} の JSON からパスワードを除く。読めなければ丸ごと隠す。 */
    public String redact(String json) {
        if (json == null || json.isBlank()) {
            return json;
        }
        try {
            ObjectNode n = (ObjectNode) mapper.readTree(json);
            n.put(KS + "Set", n.path(KS).asText("").length() > 0);
            n.put(TS + "Set", n.path(TS).asText("").length() > 0);
            n.putNull(KS);
            n.putNull(TS);
            return mapper.writeValueAsString(n);
        } catch (Exception e) {
            return null;
        }
    }

    private String stripPasswords(String json) throws JsonProcessingException {
        ObjectNode n = (ObjectNode) mapper.readTree(json);
        n.put(KS, "");
        n.put(TS, "");
        return mapper.writeValueAsString(n);
    }

    /** 保存された設定（パスワード込み）。無い・壊れていれば YAML の既定の写し。 */
    private TlsConfigDto stored() {
        try {
            String json = settings.getAll().get(TLS_KEY);
            if (json != null && !json.isBlank()) {
                return mapper.readValue(json, TlsConfigDto.class);
            }
        } catch (Exception e) {
            // DB 未準備・JSON 破損など。いずれも YAML 既定へフォールバック（起動を止めない）。
            log.warn("TLS 設定（Settings {}）の解決に失敗（YAML 既定を使用）: {}", TLS_KEY, e.toString());
        }
        return TlsConfigDto.from(props.getTls());
    }

    /**
     * TLS 設定の入出力 DTO。{@code usable} と {@code *PasswordSet} は算出値（出力のみ・保存時は無視される）。
     * 画面へはパスワードを null にして返す（{@link #get()}）。
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
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
            boolean usable,
            boolean keyStorePasswordSet,
            boolean trustStorePasswordSet) {

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
                    t.isNeedClientAuth(), t.isUsable(), false, false);
        }

        TlsConfigDto withPasswords(String ks, String ts) {
            return new TlsConfigDto(enabled, port, keyStore, ks, keyStoreType, trustStore, ts, trustStoreType,
                    protocols, cipherSuites, needClientAuth, false, false, false);
        }

        TlsConfigDto withoutPasswords(boolean ksSet, boolean tsSet) {
            return new TlsConfigDto(enabled, port, keyStore, null, keyStoreType, trustStore, null, trustStoreType,
                    protocols, cipherSuites, needClientAuth, usable, ksSet, tsSet);
        }
    }
}

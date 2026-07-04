/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.settings.SettingsService;
import org.springframework.stereotype.Service;

/**
 * 自局 AE（AE タイトル / SCP ポート / バインドアドレス）の実効値を解決するサービス。
 *
 * <p>既定値は application.yml の {@code graphy.dicom}（{@link DicomProperties}）。GUI（環境設定
 * 「DICOM通信」＞「自局」）から編集した分は Settings(H2) に保存され、YAML 既定より優先される
 * （{@link DicomTlsService} と同じパターン）。
 *
 * <p>SCU 発信（C-ECHO / C-STORE / C-FIND / C-MOVE の Calling AE）は呼び出しごとに {@link #aeTitle()}
 * を読むため即時反映。SCP リスナー（AE タイトル・ポート・バインドアドレス）は起動時にバインドするため、
 * GUI での変更はアプリ再起動後に反映される。
 */
@Service
public class DicomLocalAeService {

    /** Settings(H2) に自局 AE タイトルを保存するキー。frontend の registry と一致させること。 */
    public static final String AE_TITLE_KEY = "dicom.localAeTitle";
    /** Settings(H2) に自局 SCP ポートを保存するキー。 */
    public static final String PORT_KEY = "dicom.localAePort";
    /** Settings(H2) に自局 SCP バインドアドレスを保存するキー。 */
    public static final String BIND_ADDRESS_KEY = "dicom.localAeBindAddress";

    private final DicomProperties props;
    private final SettingsService settings;

    public DicomLocalAeService(DicomProperties props, SettingsService settings) {
        this.props = props;
        this.settings = settings;
    }

    /** 実効 AE タイトル。Settings(H2) 保存があればそれを、無ければ application.yml の既定を返す。 */
    public String aeTitle() {
        String v = settings.getAll().get(AE_TITLE_KEY);
        return (v == null || v.isBlank()) ? props.getLocalAeTitle() : v.trim();
    }

    /** 実効 SCP ポート（変更はアプリ再起動後に反映）。 */
    public int scpPort() {
        String v = settings.getAll().get(PORT_KEY);
        if (v == null || v.isBlank()) {
            return props.getScp().getPort();
        }
        try {
            return Integer.parseInt(v.trim());
        } catch (NumberFormatException e) {
            return props.getScp().getPort();
        }
    }

    /** 実効バインドアドレス（変更はアプリ再起動後に反映）。 */
    public String bindAddress() {
        String v = settings.getAll().get(BIND_ADDRESS_KEY);
        return (v == null || v.isBlank()) ? props.getScp().getBindAddress() : v.trim();
    }
}

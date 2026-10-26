/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.settings.SettingsService;
import org.springframework.stereotype.Component;

/**
 * 他端末からの検索（C-FIND）を受け付けるかと、受け付ける相手の判定。
 *
 * <p>患者情報を返す機能なので<b>既定は OFF</b>。ON でも、既定では登録済みの相手先 AE
 * （{@link DicomRemoteAeService}）からの要求だけに応える。「すべて許可」は設定で明示したときだけ。
 * 既定値は application.yml（{@code graphy.dicom.scp.query-retrieve}）、環境設定から保存した値が優先
 * （{@link DicomLocalAeService} と同じ作り）。
 *
 * <p>有効/無効は SCP の起動時に読む（サービスの登録は起動時のため、変更は再起動後に反映）。
 * 許可の判定は<b>要求のたび</b>に行うので、相手先の一覧や「すべて許可」の変更はすぐに効く。
 *
 * <p>呼び出し AE タイトルは相手の自己申告で、偽装できる。本人確認が要るなら相互 TLS
 * （{@code graphy.dicom.tls.need-client-auth}）を併用する。
 */
@Component
public class DicomQrAccess {

    /** Settings(H2) に「他端末からの検索を受け付ける」を保存するキー。frontend の registry と一致させること。 */
    public static final String ENABLED_KEY = "dicom.scpQrEnabled";
    /** Settings(H2) に「登録外の相手にも応える」を保存するキー。 */
    public static final String ALLOW_ALL_KEY = "dicom.scpQrAllowAll";

    private final DicomProperties props;
    private final SettingsService settings;
    private final DicomRemoteAeService remoteAes;

    public DicomQrAccess(DicomProperties props, SettingsService settings, DicomRemoteAeService remoteAes) {
        this.props = props;
        this.settings = settings;
        this.remoteAes = remoteAes;
    }

    /** 検索を受け付けるか（SCP の起動時に読む）。 */
    public boolean enabled() {
        return flag(ENABLED_KEY, props.getScp().getQueryRetrieve().isEnabled());
    }

    /** 登録外の相手にも応えるか。 */
    public boolean allowAll() {
        return flag(ALLOW_ALL_KEY, props.getScp().getQueryRetrieve().isAllowAll());
    }

    /** 呼び出し AE タイトルが許可されているか。 */
    public boolean allows(String callingAet) {
        if (allowAll()) {
            return true;
        }
        if (callingAet == null || callingAet.isBlank()) {
            return false;
        }
        String aet = callingAet.trim();
        return remoteAes.list().stream().anyMatch(a -> aet.equals(a.aeTitle().trim()));
    }

    private boolean flag(String key, boolean fallback) {
        String v = settings.getAll().get(key);
        return (v == null || v.isBlank()) ? fallback : Boolean.parseBoolean(v.trim());
    }
}

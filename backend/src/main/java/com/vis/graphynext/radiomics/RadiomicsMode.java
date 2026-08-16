/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import java.util.Arrays;

/**
 * Radiomics が動作できるモードかを判定する。
 *
 * <p>可視化マップも GLAM 解析も、画素を {@code DicomStorageService#resolveInstanceFile} から読む。
 * これは<b>ローカル保管庫の {@code file:} URI しか解決しない</b>。web モードのデータは外部 PACS にあり
 * DICOMweb 経由で取ってくるので、この経路には乗らない。
 *
 * <p>そのまま走らせると「スライスをデコードできません（圧縮転送構文の可能性）」という、
 * <b>原因がモードだと分からないメッセージ</b>で失敗する。実際には転送構文とは何の関係も無い。
 * だから入口で判定して、理由の分かる形で断る。
 *
 * <p>判定は既存の {@code PluginManagerService} と同じ「standalone プロファイルか」で行う。
 */
@Component
public class RadiomicsMode {

    private final Environment env;

    public RadiomicsMode(Environment env) {
        this.env = env;
    }

    /** ローカル保管庫から画素を読めるモードか。 */
    public boolean isSupported() {
        return Arrays.asList(env.getActiveProfiles()).contains("standalone");
    }

    /**
     * 動作できないモードなら、理由を添えて断る。
     *
     * @param feature 利用者に見せる機能名
     */
    public void require(String feature) {
        if (!isSupported()) {
            throw new IllegalStateException(feature + " は standalone モード専用です。"
                    + "画素をローカル保管庫から直接読むため、外部 PACS を参照する web モードでは実行できません。");
        }
    }
}

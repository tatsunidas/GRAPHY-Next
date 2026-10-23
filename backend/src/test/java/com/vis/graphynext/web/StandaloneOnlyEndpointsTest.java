/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.Profile;

import com.vis.graphynext.importer.ImportController;
import com.vis.graphynext.importer.ImportWatchController;
import com.vis.graphynext.importer.UrlImportController;
import com.vis.graphynext.nifti.NiftiImportController;
import com.vis.graphynext.nifti.RawImportController;
import com.vis.graphynext.nondicom.NonDicomController;

/**
 * サーバー上のパスを受ける（またはサーバーから外へ取りに行く）取り込み API は、web では出さない
 * （fw/security.md「サーバー上のパス」）。web は既定で認証が無く、全インターフェースで待ち受けるので、
 * 出すと誰でもサーバーのファイルを読み込ませられる。
 */
class StandaloneOnlyEndpointsTest {

    private static final List<Class<?>> STANDALONE_ONLY = List.of(
            ImportController.class,
            NonDicomController.class,
            NiftiImportController.class,
            RawImportController.class,
            UrlImportController.class,
            ImportWatchController.class,
            com.vis.graphynext.microscopy.MicroscopyImportController.class,
            com.vis.graphynext.microscopy.PluginMicroscopyController.class,
            com.vis.graphynext.dbadmin.TagEditController.class,
            com.vis.graphynext.dicom.ReceiveAnonymizeController.class,
            com.vis.graphynext.dicom.ReceiveAnonymizeInternalController.class);

    @Test
    void ローカルのファイルを読み書きするコントローラは_standalone_だけ() {
        for (Class<?> c : STANDALONE_ONLY) {
            Profile p = c.getAnnotation(Profile.class);
            assertThat(p).as(c.getSimpleName() + " に @Profile が無い").isNotNull();
            assertThat(p.value()).as(c.getSimpleName()).containsExactly("standalone");
        }
    }
}

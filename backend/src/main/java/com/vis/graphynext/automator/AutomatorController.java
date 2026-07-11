/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.automator;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * automator（自律検証ツール、{@code automator/}）専用の開発者向けREST。
 *
 * <p><b>{@code GRAPHY_AUTOMATOR=1} 環境変数が設定されているときだけ Bean 登録される</b>
 * （{@code @ConditionalOnProperty}）。未設定時はこのコントローラ自体が存在しないため、
 * 配布用インストーラ（standalone プロファイル）が誤って本エンドポイントに到達することはない。
 * ビルド/CI/release.yml のいずれにもこのフラグを混入させないこと。
 */
@RestController
@RequestMapping("/api/automator")
@ConditionalOnProperty(name = "GRAPHY_AUTOMATOR", havingValue = "1")
public class AutomatorController {

    private final AutomatorService service;

    public AutomatorController(AutomatorService service) {
        this.service = service;
    }

    /** 症例データ（DICOM索引・実ファイル・レポート）を全削除する。環境設定(Setting)は対象外。 */
    @PostMapping("/reset")
    public AutomatorService.ResetResult reset() {
        return service.reset();
    }
}

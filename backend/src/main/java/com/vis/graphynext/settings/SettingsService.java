/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.settings;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * アプリ設定の取得・保存。キー→値の汎用ストア。
 *
 * <p>現状はサーバーグローバル（standalone は単一ユーザーで問題なし）。web のマルチユーザー
 * では将来ユーザー単位に拡張する余地を残す。
 */
@Service
public class SettingsService {

    /** デバッグモードのキー。値が変わったらログレベルを切り替える。 */
    public static final String DEBUG_MODE_KEY = "general.debugMode";

    /**
     * プラグイン導入のユーザーオプトイン（環境設定＞プラグインのトグル）。既定 false。
     * 設計: fw/plugin-manager-design.md §5。
     */
    public static final String PLUGIN_INSTALL_ENABLED_KEY = "plugins.installEnabled";

    /**
     * XA の空間校正（シリーズ単位）。キーは {@code xa.calibration.<SeriesInstanceUID>}。
     * 設計: fw/angio-design.md §7.4。
     *
     * <p>🚨 <b>これは環境設定ではなく症例に紐づくデータ</b>。だから
     * {@code AutomatorService.reset()} は<b>このプレフィックスだけ消す</b>——
     * 消し残すと、前の実行で確定した校正が次の実行に効いて
     * <b>「未校正なら px 表示」の検証が黙って通る</b>（ROI 保存で実際に起きた形）。
     */
    public static final String XA_CALIBRATION_PREFIX = "xa.calibration.";

    private final SettingRepository repo;
    private final DebugLogControl debugLogControl;

    public SettingsService(SettingRepository repo, DebugLogControl debugLogControl) {
        this.repo = repo;
        this.debugLogControl = debugLogControl;
    }

    @Transactional(readOnly = true)
    public Map<String, String> getAll() {
        Map<String, String> map = new LinkedHashMap<>();
        for (Setting s : repo.findAll()) {
            map.put(s.getKey(), s.getValue());
        }
        return map;
    }

    /** 与えられたキーのみ上書き（部分更新・マージ）。 */
    @Transactional
    public Map<String, String> putAll(Map<String, String> updates) {
        if (updates != null) {
            updates.forEach((k, v) -> {
                Setting s = repo.findById(k).orElseGet(() -> new Setting(k));
                s.setValue(v);
                repo.save(s);
            });
            // デバッグモードが変わったらログレベルを即時反映
            if (updates.containsKey(DEBUG_MODE_KEY)) {
                debugLogControl.apply(Boolean.parseBoolean(updates.get(DEBUG_MODE_KEY)));
            }
        }
        return getAll();
    }

    /**
     * プレフィックスに一致するキーを消す（症例に紐づく設定の後始末用）。
     *
     * @return 消した件数
     */
    @Transactional
    public int deleteByPrefix(String prefix) {
        if (prefix == null || prefix.isBlank()) {
            return 0;
        }
        List<Setting> hit = new ArrayList<>();
        for (Setting s : repo.findAll()) {
            if (s.getKey() != null && s.getKey().startsWith(prefix)) {
                hit.add(s);
            }
        }
        repo.deleteAll(hit);
        return hit.size();
    }
}

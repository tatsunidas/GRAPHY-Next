package com.vis.graphynext.settings;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.LinkedHashMap;
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
}

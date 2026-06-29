/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.settings;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/**
 * アプリケーションレベルの設定 1 項目（キー→値の文字列ストア）。
 *
 * <p>値の型解釈はフロントのレジストリ（項目定義）が持つ。ここは汎用 KV として保持し、
 * 設定項目を後から増やしてもスキーマ変更が要らない設計にする。
 */
@Entity
@Table(name = "app_setting")
public class Setting {

    @Id
    @Column(name = "setting_key", length = 200)
    private String key;

    @Column(name = "setting_value", length = 4000)
    private String value;

    protected Setting() {
        // JPA 用
    }

    public Setting(String key) {
        this.key = key;
    }

    public String getKey() {
        return key;
    }

    public String getValue() {
        return value;
    }

    public void setValue(String value) {
        this.value = value;
    }
}

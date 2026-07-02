/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.spi;

import java.util.Map;

/**
 * バックエンド面プラグインが実装する SPI。
 *
 * <p>プラグイン JAR はこのインターフェースを実装したクラスを 1 つ持ち、
 * マニフェストの {@code backend.entrypoint} にその完全修飾名を書く。
 * {@code POST /api/plugins/{id}/run} の要求本文が {@code args} として渡る。
 *
 * <p>GRAPHY の {@code PlugIn} 系インターフェースの後継にあたる最小契約。
 * この型は backend の JVM と プラグイン JAR で共有されるため、依存を増やさないよう
 * JDK 標準型のみで定義する。
 */
public interface GraphyPlugin {

    /**
     * プラグイン本体を実行する。
     *
     * @param args フロントから渡る任意のパラメータ（未指定なら空 Map）
     * @return JSON 化して返す結果（任意。null 可）
     */
    Object run(Map<String, Object> args) throws Exception;
}

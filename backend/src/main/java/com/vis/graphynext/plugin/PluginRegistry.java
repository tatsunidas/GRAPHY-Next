/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * プラグインの出所を抽象化する継ぎ目（{@code DicomDataService} と同じ思想）。
 * フロントは常に {@code /api/plugins} を叩くだけで、standalone / web の違いを意識しない。
 *
 * <ul>
 *   <li>standalone: {@link StandalonePluginRegistry}（ローカルフォルダを走査・JAR ロード）</li>
 *   <li>web: {@link WebPluginRegistry}（運営配備の一覧のみ。バックエンド実行はサンドボックス前提で未提供）</li>
 * </ul>
 */
public interface PluginRegistry {

    /** 全プラグインのマニフェスト。 */
    List<PluginManifest> manifests();

    /** プラグインの UI バンドル（ES モジュール）のバイト列。無ければ empty。 */
    Optional<byte[]> uiBundle(String id);

    /**
     * バックエンド面を実行する（{@code POST /api/plugins/&#123;id&#125;/run}）。
     *
     * @throws java.util.NoSuchElementException プラグインが存在しない
     * @throws UnsupportedOperationException このモード/プラグインでは実行不可
     */
    Object run(String id, Map<String, Object> payload);

    /**
     * そのプラグインが掴んでいる資源（クラスローダ＝JAR のファイルハンドル）を解放する。
     *
     * <p>🔴 <b>Windows では開いたままの JAR を削除できない</b>ため、削除・更新・再インストールの
     * 前に必ず呼ぶこと。呼ばないと {@code deleteRecursively} が JAR で
     * 「別のプロセスが使用中です」で落ち、<b>先に消えた {@code plugin.json} / {@code ui.js} だけが
     * 失われて JAR と台帳が残る</b>という中途半端な状態になる（2026-08-24 に実機で発生）。
     *
     * <p>既定は何もしない（web モードは JAR を読み込まない）。
     */
    default void release(String id) {
        // no-op
    }
}

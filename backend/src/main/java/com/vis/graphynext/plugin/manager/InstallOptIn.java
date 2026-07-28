/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

/**
 * ユーザーによる導入オプトイン（環境設定＞プラグインの「プラグインの導入を許可する」トグル）。
 *
 * <p>プラグインはアプリと同じ権限で動くが署名検証は未実装（P2）のため、導入操作は
 * 既定で無効とし、ユーザーが明示的に有効化したときだけ許す。{@code graphy.plugins.manager-enabled}
 * が「この環境で管理機能を許すか（管理者ゲート）」なのに対し、こちらは「ユーザーが今それを
 * 使うか」を表す。設計: fw/plugin-manager-design.md §5。
 *
 * <p>単体テスト可能にするための継ぎ目（{@link GitHubReleaseClient} と同じ方針）。
 */
public interface InstallOptIn {

    /** ユーザーが導入を許可しているか。 */
    boolean isEnabled();
}

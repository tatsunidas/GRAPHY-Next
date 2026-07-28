/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import java.util.List;
import java.util.Locale;

/**
 * プラグインの対応 OS（{@code engines.os}）と実行中の OS の突き合わせ。
 *
 * <p>GRAPHY-Next 本体は OS ごとにリリースを分けており、プラグインも JNI/ネイティブバイナリを
 * 含めば OS 専用になる。別 OS 向けの zip を展開してから実行時に落ちるのを避けるため、
 * <b>取得直後・展開前</b>に判定する（設計: fw/plugin-manager-design.md §5）。
 *
 * <p>トークンは Node の {@code process.platform} に合わせた {@code win32} / {@code darwin} /
 * {@code linux}。マニフェスト側は {@code windows} / {@code mac} / {@code macos} / {@code osx} /
 * {@code win} も別名として受理する（書き手の取り違えで無用に弾かないため）。
 */
final class OsCompat {

    private OsCompat() {}

    /** 実行中の OS のトークン（判別できなければ {@code os.name} の小文字）。 */
    static String current() {
        return fromOsName(System.getProperty("os.name", ""));
    }

    /** {@code os.name} 相当の文字列をトークンへ写す（テスト可能にするため分離）。 */
    static String fromOsName(String osName) {
        String s = osName == null ? "" : osName.toLowerCase(Locale.ROOT);
        if (s.contains("win")) return "win32";
        if (s.contains("mac") || s.contains("darwin")) return "darwin";
        if (s.contains("nux") || s.contains("nix") || s.contains("aix")) return "linux";
        return s.isBlank() ? "unknown" : s;
    }

    /** マニフェストの表記ゆれを吸収する。 */
    static String normalize(String token) {
        String s = token == null ? "" : token.trim().toLowerCase(Locale.ROOT);
        return switch (s) {
            case "win", "win32", "windows", "win64" -> "win32";
            case "mac", "macos", "darwin", "osx", "mac os x" -> "darwin";
            case "linux" -> "linux";
            default -> s;
        };
    }

    /**
     * 宣言された対応 OS が現在の OS を含むか。
     * 未宣言・空・{@code "*"} を含む場合は OS 非依存として true。
     */
    static boolean satisfies(List<String> declared, String currentOs) {
        if (declared == null || declared.isEmpty()) return true;
        for (String d : declared) {
            String n = normalize(d);
            if (n.equals("*") || n.equals("any")) return true;
            if (n.equals(currentOs)) return true;
        }
        return false;
    }
}

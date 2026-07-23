/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

/**
 * 最小限の SemVer（MAJOR.MINOR.PATCH）比較と互換範囲判定。
 *
 * <p>プラグインの {@code engines.graphy}（例 {@code ">=0.2.0 <0.3.0"}）を、コアのバージョン
 * （{@code /api/status} の version＝pom の {@code <version>}）に対して満たすか判定する。
 * pre-release / build メタデータ（{@code -} / {@code +} 以降）は無視する。外部依存を足さないため自前実装。
 */
public final class SemVer implements Comparable<SemVer> {

    private final int major;
    private final int minor;
    private final int patch;

    private SemVer(int major, int minor, int patch) {
        this.major = major;
        this.minor = minor;
        this.patch = patch;
    }

    /**
     * {@code "v1.2.3"} / {@code "1.2"} 等を解釈する。先頭の {@code v} と {@code -}/{@code +} 以降は無視。
     *
     * @throws IllegalArgumentException 数値の x.y.z として解釈できないとき
     */
    public static SemVer parse(String s) {
        if (s == null) throw new IllegalArgumentException("version is null");
        String t = s.trim();
        if (t.startsWith("v") || t.startsWith("V")) t = t.substring(1);
        int cut = t.length();
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (c == '-' || c == '+') { cut = i; break; }
        }
        t = t.substring(0, cut);
        String[] parts = t.split("\\.");
        try {
            int major = parts.length > 0 && !parts[0].isBlank() ? Integer.parseInt(parts[0].trim()) : 0;
            int minor = parts.length > 1 && !parts[1].isBlank() ? Integer.parseInt(parts[1].trim()) : 0;
            int patch = parts.length > 2 && !parts[2].isBlank() ? Integer.parseInt(parts[2].trim()) : 0;
            return new SemVer(major, minor, patch);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("not a semver: " + s);
        }
    }

    @Override
    public int compareTo(SemVer o) {
        if (major != o.major) return Integer.compare(major, o.major);
        if (minor != o.minor) return Integer.compare(minor, o.minor);
        return Integer.compare(patch, o.patch);
    }

    /**
     * {@code version} が互換範囲 {@code range} を満たすか。
     *
     * <p>{@code range} は空白区切りの比較子（すべて AND）。例 {@code ">=0.2.0 <0.3.0"}。
     * 対応演算子: {@code >=, <=, >, <, =}。演算子なしの裸のバージョンは完全一致（{@code =}）扱い。
     * {@code range} が null / 空 / {@code "*"} なら制約なし＝常に true。
     * {@code version} が semver として解釈できない場合（例 dev ビルドの {@code "dev"}）は、
     * 開発を妨げないため true を返す（gating しない）。
     */
    public static boolean satisfies(String version, String range) {
        if (range == null || range.isBlank() || range.trim().equals("*")) return true;
        SemVer v;
        try {
            v = parse(version);
        } catch (IllegalArgumentException e) {
            return true; // 非 semver のコア（dev 等）はブロックしない
        }
        for (String tokenRaw : range.trim().split("\\s+")) {
            if (!satisfiesOne(v, tokenRaw.trim())) return false;
        }
        return true;
    }

    private static boolean satisfiesOne(SemVer v, String token) {
        if (token.isEmpty() || token.equals("*")) return true;
        String op;
        String operand;
        if (token.startsWith(">=") || token.startsWith("<=")) {
            op = token.substring(0, 2);
            operand = token.substring(2);
        } else if (token.startsWith(">") || token.startsWith("<") || token.startsWith("=")) {
            op = token.substring(0, 1);
            operand = token.substring(1);
        } else {
            op = "=";
            operand = token;
        }
        SemVer target;
        try {
            target = parse(operand);
        } catch (IllegalArgumentException e) {
            return false; // 範囲側が壊れている＝満たさない（安全側）
        }
        int cmp = v.compareTo(target);
        return switch (op) {
            case ">=" -> cmp >= 0;
            case "<=" -> cmp <= 0;
            case ">" -> cmp > 0;
            case "<" -> cmp < 0;
            default -> cmp == 0; // "="
        };
    }

    @Override
    public String toString() {
        return major + "." + minor + "." + patch;
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import java.util.regex.Pattern;

/**
 * Markdown 本文を DICOM SR の TEXT content item（平文）へ変換する。
 *
 * <p>フルパーサは使わず、見出し/強調/リンク等の記号を取り除きつつ行構造（見出し・箇条書き・引用）は
 * 保持する軽量な整形のみ行う（`fw/report-design.md` §4/§9「Markdown→SRプレーンテキスト変換の忠実度」）。
 */
final class MarkdownPlainText {

    private static final Pattern HEADER = Pattern.compile("^(#{1,6})\\s+(.*)$");
    private static final Pattern HR = Pattern.compile("^\\s*([-*_])(\\s*\\1){2,}\\s*$");
    private static final Pattern BOLD = Pattern.compile("\\*\\*(.+?)\\*\\*|__(.+?)__");
    private static final Pattern ITALIC = Pattern.compile("(?<!\\*)\\*([^*\\n]+?)\\*(?!\\*)|(?<!_)_([^_\\n]+?)_(?!_)");
    private static final Pattern STRIKE = Pattern.compile("~~(.+?)~~");
    private static final Pattern INLINE_CODE = Pattern.compile("`([^`]+?)`");
    private static final Pattern LINK = Pattern.compile("\\[([^\\]]*)]\\(([^)]*)\\)");

    private MarkdownPlainText() {
    }

    static String flatten(String markdown) {
        if (markdown == null || markdown.isBlank()) {
            return "";
        }
        String normalized = markdown.replace("\r\n", "\n").replace("\r", "\n");
        StringBuilder out = new StringBuilder();
        for (String line : normalized.split("\n", -1)) {
            out.append(flattenLine(line)).append('\n');
        }
        return out.toString().strip();
    }

    private static String flattenLine(String line) {
        var hr = HR.matcher(line);
        if (hr.matches()) {
            return "-".repeat(40);
        }
        String t = line;
        var h = HEADER.matcher(t);
        if (h.matches()) {
            t = h.group(2).strip();
        }
        t = replaceAllGroup(BOLD, t);
        t = replaceAllGroup(ITALIC, t);
        t = replaceAllGroup(STRIKE, t);
        t = INLINE_CODE.matcher(t).replaceAll("$1");
        t = LINK.matcher(t).replaceAll("$1 ($2)");
        return t;
    }

    /** マッチした最初の非 null グループをそのまま残す（{@code **a**}/{@code __a__} のような選択群対応）。 */
    private static String replaceAllGroup(Pattern p, String s) {
        var m = p.matcher(s);
        StringBuilder sb = new StringBuilder();
        while (m.find()) {
            String g = m.group(1) != null ? m.group(1) : m.group(2);
            m.appendReplacement(sb, java.util.regex.Matcher.quoteReplacement(g));
        }
        m.appendTail(sb);
        return sb.toString();
    }
}

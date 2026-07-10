/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Markdown → SR TEXT content item 平文化の変換ルールを検証する。
 */
class MarkdownPlainTextTest {

    @Test
    void flattenHeadersBoldItalicAndLinks() {
        String md = "## 所見\n\n**異常なし**。*経過観察*が望ましい。[参考](http://example.com)";
        String out = MarkdownPlainText.flatten(md);
        assertEquals("所見\n\n異常なし。経過観察が望ましい。参考 (http://example.com)", out);
    }

    @Test
    void flattenPreservesListAndBlockquote() {
        String md = "- 項目1\n- 項目2\n> 引用文";
        String out = MarkdownPlainText.flatten(md);
        assertEquals("- 項目1\n- 項目2\n> 引用文", out);
    }

    @Test
    void flattenHorizontalRuleAndInlineCode() {
        String md = "before\n\n---\n\n`code`.";
        String out = MarkdownPlainText.flatten(md);
        assertEquals("before\n\n" + "-".repeat(40) + "\n\ncode.", out);
    }

    @Test
    void flattenNullOrBlankReturnsEmpty() {
        assertEquals("", MarkdownPlainText.flatten(null));
        assertEquals("", MarkdownPlainText.flatten("   \n  "));
    }
}

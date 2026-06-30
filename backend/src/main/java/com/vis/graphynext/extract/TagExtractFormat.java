/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.extract;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 抽出結果（{@link TagExtractService.ExtractResult}）→ CSV / JSON 文字列への純粋整形。
 * I/O を持たないため単体テスト可能。
 */
public final class TagExtractFormat {

    private TagExtractFormat() {}

    /** RFC4180 準拠の CSV（先頭に UTF-8 BOM を付与し Excel での文字化けを防ぐ）。 */
    public static String toCsv(TagExtractService.ExtractResult r) {
        StringBuilder sb = new StringBuilder("﻿");
        csvRow(sb, r.columns());
        for (List<String> row : r.rows()) {
            csvRow(sb, row);
        }
        return sb.toString();
    }

    private static void csvRow(StringBuilder sb, List<String> cells) {
        for (int i = 0; i < cells.size(); i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append(csvEscape(cells.get(i)));
        }
        sb.append("\r\n");
    }

    private static String csvEscape(String s) {
        if (s == null) {
            return "";
        }
        if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
            return '"' + s.replace("\"", "\"\"") + '"';
        }
        return s;
    }

    /** 列名をキーにした行オブジェクトの配列（{@code [{col: val, ...}, ...]}）。 */
    public static String toJson(TagExtractService.ExtractResult r) {
        List<Map<String, String>> objs = new java.util.ArrayList<>();
        for (List<String> row : r.rows()) {
            Map<String, String> obj = new LinkedHashMap<>();
            for (int i = 0; i < r.columns().size(); i++) {
                obj.put(r.columns().get(i), i < row.size() ? row.get(i) : "");
            }
            objs.add(obj);
        }
        StringBuilder sb = new StringBuilder("[\n");
        for (int i = 0; i < objs.size(); i++) {
            sb.append("  {");
            int j = 0;
            for (Map.Entry<String, String> e : objs.get(i).entrySet()) {
                if (j++ > 0) {
                    sb.append(", ");
                }
                sb.append(jsonStr(e.getKey())).append(": ").append(jsonStr(e.getValue()));
            }
            sb.append('}');
            sb.append(i < objs.size() - 1 ? ",\n" : "\n");
        }
        sb.append("]\n");
        return sb.toString();
    }

    private static String jsonStr(String s) {
        if (s == null) {
            return "\"\"";
        }
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        return sb.append('"').toString();
    }
}

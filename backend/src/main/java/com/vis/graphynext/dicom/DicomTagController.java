/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.ElementDictionary;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * DICOM タグ番号 → キーワード/VR の解決（環境設定のオーバーレイ項目入力 UI 用）。
 * dcm4che の標準データディクショナリを使う。
 */
@RestController
@RequestMapping("/api/dicom")
public class DicomTagController {

    /** 例: {@code GET /api/dicom/tag?tag=00100010} → {tag, keyword:"PatientName", vr:"PN"}。 */
    @GetMapping("/tag")
    public Map<String, String> tag(@RequestParam String tag) {
        String hex = tag.replaceAll("[^0-9A-Fa-f]", "");
        Map<String, String> out = new LinkedHashMap<>();
        if (hex.length() != 8) {
            out.put("tag", tag);
            out.put("keyword", "");
            out.put("vr", "");
            return out;
        }
        int t = (int) Long.parseLong(hex, 16);
        ElementDictionary dict = ElementDictionary.getStandardElementDictionary();
        String keyword = dict.keywordOf(t);
        VR vr = dict.vrOf(t);
        out.put("tag", hex.toUpperCase());
        out.put("keyword", keyword == null ? "" : keyword);
        out.put("vr", vr == null ? "" : vr.name());
        return out;
    }

    /** タグ辞書エントリ（8 桁 hex, キーワード, VR）。 */
    public record TagDictEntry(String tag, String keyword, String vr) {
    }

    /** 標準データディクショナリの一覧（リフレクションで一度だけ構築しキャッシュ）。 */
    private static volatile List<TagDictEntry> DICTIONARY;

    /**
     * 標準 DICOM タグ辞書の一覧（TagExtractor の辞書検索・SQ 判定用）。
     * {@code org.dcm4che3.data.Tag} の public static int 定数をリフレクションで列挙する。
     */
    @GetMapping("/tags")
    public List<TagDictEntry> tags() {
        List<TagDictEntry> dict = DICTIONARY;
        if (dict == null) {
            dict = buildDictionary();
            DICTIONARY = dict;
        }
        return dict;
    }

    private static synchronized List<TagDictEntry> buildDictionary() {
        if (DICTIONARY != null) {
            return DICTIONARY;
        }
        ElementDictionary dict = ElementDictionary.getStandardElementDictionary();
        List<TagDictEntry> out = new ArrayList<>();
        for (Field f : Tag.class.getFields()) {
            if (f.getType() != int.class || !Modifier.isStatic(f.getModifiers())) {
                continue;
            }
            int tag;
            try {
                tag = f.getInt(null);
            } catch (IllegalAccessException e) {
                continue;
            }
            // group length (eeee=0000) や区切り要素(FFFE,xxxx)、マスク定数は除外。
            int group = (tag >>> 16) & 0xFFFF;
            int elem = tag & 0xFFFF;
            if (group == 0xFFFE || elem == 0x0000) {
                continue;
            }
            String hex = String.format("%08X", tag);
            VR vr = dict.vrOf(tag);
            out.add(new TagDictEntry(hex, f.getName(), vr == null ? "" : vr.name()));
        }
        out.sort((a, b) -> a.keyword().compareToIgnoreCase(b.keyword()));
        return out;
    }
}

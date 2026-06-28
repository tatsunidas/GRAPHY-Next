package com.vis.graphynext.dicom;

import org.dcm4che3.data.ElementDictionary;
import org.dcm4che3.data.VR;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
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
}

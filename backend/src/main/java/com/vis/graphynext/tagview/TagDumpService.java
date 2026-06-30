/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.tagview;

import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.ElementDictionary;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.dcm4che3.util.TagUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 単一インスタンス（SOP）の DICOM 属性ダンプ（TagViewer 用・Read only）。
 *
 * <p>GRAPHY の {@code DicomTagsViewer} を踏襲し、各属性を {tag, name(keyword), VR, value} の行に展開する。
 * シーケンス(SQ)はネストの深さ {@code depth} を付与し、各アイテムを {@code (FFFE,E000) Item #n} 行で区切って
 * 再帰展開する。ピクセルデータ等のバルクは読み込まない（ヘッダのみ）。
 */
@Service
public class TagDumpService {

    private static final Logger log = LoggerFactory.getLogger(TagDumpService.class);

    private final DicomStorageService storage;

    public TagDumpService(DicomStorageService storage) {
        this.storage = storage;
    }

    /** ダンプ 1 行。{@code depth} はシーケンスのネスト深さ（0=トップレベル）。 */
    public record TagRow(int depth, String tag, String name, String vr, String value) {}

    /**
     * sopUid のローカルファイルを読み、属性ダンプを返す。索引に無い／ファイルが無い場合は {@code null}。
     */
    @Transactional(readOnly = true)
    public List<TagRow> dump(String sopUid) {
        Path path = storage.resolveInstanceFile(sopUid);
        if (path == null) {
            return null;
        }
        Attributes ds;
        try (DicomInputStream in = new DicomInputStream(path.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            ds = in.readDatasetUntilPixelData();
        } catch (IOException e) {
            log.warn("tagview: 読取失敗 {}", sopUid, e);
            return null;
        }
        List<TagRow> rows = new ArrayList<>();
        walk(ds, 0, rows);
        return rows;
    }

    /** データセットを走査して行に展開する（ファイル非依存・テスト可能）。 */
    static void walk(Attributes ds, int depth, List<TagRow> out) {
        for (int tag : ds.tags()) {
            VR vr = ds.getVR(tag);
            String creator = ds.getPrivateCreator(tag);
            String name = ElementDictionary.keywordOf(tag, creator);
            if (name == null) {
                name = "";
            }
            String tagStr = TagUtils.toString(tag);
            if (vr == VR.SQ) {
                out.add(new TagRow(depth, tagStr, name, "SQ", ""));
                Sequence seq = ds.getSequence(tag);
                if (seq != null) {
                    int i = 1;
                    for (Attributes item : seq) {
                        out.add(new TagRow(depth + 1, "(FFFE,E000)", "Item #" + i, "", ""));
                        walk(item, depth + 2, out);
                        i++;
                    }
                }
            } else {
                out.add(new TagRow(depth, tagStr, name, vr != null ? vr.name() : "", value(ds, tag)));
            }
        }
    }

    /** 値を文字列化。文字列 VR は連結（{@code \\}）、バルク/バイナリは長さ表記。 */
    private static String value(Attributes ds, int tag) {
        try {
            String[] ss = ds.getStrings(tag);
            if (ss != null) {
                return String.join("\\", ss);
            }
        } catch (RuntimeException ignore) {
            // 文字列化不可 VR はバイナリ扱いへフォールバック
        }
        try {
            byte[] b = ds.getBytes(tag);
            if (b != null && b.length > 0) {
                return "<binary " + b.length + " bytes>";
            }
        } catch (IOException | RuntimeException ignore) {
            // ベストエフォート
        }
        return "";
    }
}

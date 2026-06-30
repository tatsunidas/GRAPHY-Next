/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import com.vis.graphynext.dicom.DicomProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * DICOM Send（C-STORE SCU）のオーケストレーション。
 *
 * <p>選択されたスタディ／シリーズに属するローカル DICOM ファイルを {@link DicomStorageService} で解決し、
 * {@link DicomStoreScu#storeAll} で<b>単一アソシエーション</b>としてリモート AE へ送る。standalone 専用
 * （ローカル索引＝H2+FS が前提。web モードでは索引が無いため送信対象を解決できない）。
 */
@Service
public class DicomSendService {

    private static final Logger log = LoggerFactory.getLogger(DicomSendService.class);

    private final DicomStorageService storage;
    private final DicomProperties props;
    private final DicomStoreScu scu = new DicomStoreScu();

    public DicomSendService(DicomStorageService storage, DicomProperties props) {
        this.storage = storage;
        this.props = props;
    }

    /** 送信対象（1 スタディと、その中で送る対象シリーズ。空なら当該スタディ全体）。 */
    public record Selection(String studyUid, List<String> seriesUids) {
    }

    /**
     * 送信結果サマリ。
     *
     * @param total    解決された送信対象ファイル数
     * @param sent     送信成功数
     * @param failed   失敗数
     * @param messages 失敗/警告メッセージ（先頭から最大数件）
     */
    public record SendSummary(int total, int sent, int failed, List<String> messages) {
    }

    /**
     * 選択スタディ/シリーズをリモート AE へ C-STORE する。
     *
     * @param tls true なら TLS（設定が揃っている場合のみ実効。未整備なら平文）。
     */
    public SendSummary send(List<Selection> selections, String host, int port, String calledAet,
                            String callingAet, boolean tls) {
        List<Path> files = new ArrayList<>();
        for (Selection sel : selections) {
            if (sel == null || sel.studyUid() == null || sel.studyUid().isBlank()) {
                continue;
            }
            files.addAll(storage.resolveFiles(sel.studyUid(), sel.seriesUids()));
        }
        if (files.isEmpty()) {
            log.warn("DICOM Send: 送信対象ファイルが 0 件（selections={}）", selections.size());
            return new SendSummary(0, 0, 0, List.of("送信対象が見つかりませんでした"));
        }
        DicomProperties.Tls tlsCfg = tls ? props.getTls() : null;
        DicomStoreScu.BatchResult r = scu.storeAll(host, port, calledAet, callingAet, files, tlsCfg);
        return new SendSummary(r.total(), r.sent(), r.failed(), r.messages());
    }
}

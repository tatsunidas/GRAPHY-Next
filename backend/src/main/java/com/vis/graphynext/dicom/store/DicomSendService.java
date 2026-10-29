/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.DicomTlsService;
import com.vis.graphynext.report.ReportService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

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
    private final DicomTlsService tlsService;
    private final DicomStoreScu scu;
    private final ReportService reports;

    public DicomSendService(DicomStorageService storage, DicomTlsService tlsService,
                            com.vis.graphynext.anonymize.PixelCodec codec, ReportService reports) {
        this.storage = storage;
        this.tlsService = tlsService;
        this.scu = new DicomStoreScu(codec);
        this.reports = reports;
    }

    /**
     * 送信の付加指定。
     *
     * @param tsPolicy         転送構文の方針
     * @param keyImagesOnly    true なら、選択スタディの確定済みレポートのキー画像だけを送る（シリーズの選択は問わない）
     * @param includeKeyObject keyImagesOnly のとき、確定時に作られた KO も送るか
     */
    public record Options(DicomStoreScu.TsPolicy tsPolicy, boolean keyImagesOnly, boolean includeKeyObject) {
        public static Options defaults() {
            return new Options(DicomStoreScu.TsPolicy.STORED, false, true);
        }
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

    /** 保存どおりの転送構文で送る。 */
    public SendSummary send(List<Selection> selections, String host, int port, String calledAet,
                            String callingAet, boolean tls) {
        return send(selections, host, port, calledAet, callingAet, tls, Options.defaults());
    }

    /**
     * 選択スタディ/シリーズをリモート AE へ C-STORE する。
     *
     * @param tls true なら TLS（設定が揃っている場合のみ実効。未整備なら平文）。
     */
    public SendSummary send(List<Selection> selections, String host, int port, String calledAet,
                            String callingAet, boolean tls, Options options) {
        List<Path> files = new ArrayList<>();
        List<String> notes = new ArrayList<>();
        int unresolved = 0;
        for (Selection sel : selections) {
            if (sel == null || sel.studyUid() == null || sel.studyUid().isBlank()) {
                continue;
            }
            if (options.keyImagesOnly()) {
                unresolved += resolveKeyImages(sel.studyUid(), options.includeKeyObject(), files, notes);
            } else {
                files.addAll(storage.resolveFiles(sel.studyUid(), sel.seriesUids()));
            }
        }
        if (files.isEmpty()) {
            log.warn("DICOM Send: 送信対象ファイルが 0 件（selections={}）", selections.size());
            List<String> msgs = new ArrayList<>(notes);
            if (msgs.isEmpty()) {
                msgs.add("送信対象が見つかりませんでした");
            }
            return new SendSummary(unresolved, 0, unresolved, msgs);
        }
        DicomProperties.Tls tlsCfg = tls ? tlsService.effective() : null;
        DicomStoreScu.BatchResult r = scu.storeAll(host, port, calledAet, callingAet, files, tlsCfg, options.tsPolicy());
        List<String> msgs = new ArrayList<>(notes);
        msgs.addAll(r.messages());
        return new SendSummary(r.total() + unresolved, r.sent(), r.failed() + unresolved, msgs);
    }

    /** 「キー画像のみ」で送れるキー画像と KO（確定済みレポートが参照するもの）。 */
    public ReportService.SendableKeyImages sendableKeyImages(String studyUid) {
        return reports.sendableKeyImages(studyUid);
    }

    /**
     * 1 スタディ分のキー画像（と KO）のファイルを files へ足す。保管庫に無いものは足さず、その数を返す（失敗として数える）。
     * キー画像の無いスタディは notes に理由を書くだけで、送信対象にしない。
     */
    private int resolveKeyImages(String studyUid, boolean includeKo, List<Path> files, List<String> notes) {
        ReportService.SendableKeyImages ki = reports.sendableKeyImages(studyUid);
        if (ki.imageSopUids().isEmpty()) {
            notes.add("キー画像がないため送りません（確定済みレポートが無いか、キー画像が未選択）: " + studyUid);
            return 0;
        }
        Set<String> sops = new LinkedHashSet<>(ki.imageSopUids());
        if (includeKo) {
            sops.addAll(ki.koSopUids());
        }
        int missing = 0;
        for (String sop : sops) {
            Path p = storage.resolveInstanceFile(sop);
            if (p == null) {
                missing++;
                notes.add("保管庫に無いため送れません: " + sop);
            } else {
                files.add(p);
            }
        }
        for (String sop : ki.frameRefSopUids()) {
            notes.add("特定フレームのキー画像のため、インスタンス全体を送ります: " + sop);
        }
        return missing;
    }
}

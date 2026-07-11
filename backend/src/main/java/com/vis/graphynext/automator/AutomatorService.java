/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.automator;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.report.ReportRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * automator（自律検証ツール）専用のDBリセット。{@link AutomatorController} からのみ呼ばれ、
 * 呼び出し口は {@code GRAPHY_AUTOMATOR=1} が設定されているときだけ有効化される
 * （{@link AutomatorController} の {@code @ConditionalOnProperty} 参照）。
 *
 * <p>H2 ファイルを OS レベルで削除する（プロセス再起動を要する）方式ではなく、実行中の JVM 内で
 * リポジトリ経由の全削除に留める。理由: (1) H2 は {@code AUTO_SERVER=TRUE} でファイルロックを持つため、
 * Windows ではプロセスを止めてからでないと安全に削除できずレースが起きやすい、(2) プロセス再起動無しで
 * automator のドライバ（Playwright セッション）を維持できる、(3) desktop/web の CWD 差異
 * （{@code desktop/data} / {@code backend/data} / {@code /data}）を automator 側で分岐する必要が無い。
 */
@Service
public class AutomatorService {

    private static final Logger log = LoggerFactory.getLogger(AutomatorService.class);

    private final DicomInstanceRepository dicomRepo;
    private final ReportRepository reportRepo;

    public AutomatorService(DicomInstanceRepository dicomRepo, ReportRepository reportRepo) {
        this.dicomRepo = dicomRepo;
        this.reportRepo = reportRepo;
    }

    public record ResetResult(int deletedInstances, int deletedReports) {
    }

    /** 症例データ（DICOMインスタンス索引＋実ファイル、レポート）を全削除する。環境設定(Setting)は対象外。 */
    @Transactional
    public ResetResult reset() {
        List<DicomInstance> instances = dicomRepo.findAll();
        for (DicomInstance inst : instances) {
            if (inst.getUri() != null) {
                try {
                    Files.deleteIfExists(Path.of(URI.create(inst.getUri())));
                } catch (Exception e) {
                    log.warn("[automator] ファイル削除に失敗: {} ({})", inst.getUri(), e.toString());
                }
            }
        }
        dicomRepo.deleteAll(instances);

        long reportCount = reportRepo.count();
        reportRepo.deleteAll();

        log.info("[automator] reset: instances={}, reports={}", instances.size(), reportCount);
        return new ResetResult(instances.size(), (int) reportCount);
    }
}

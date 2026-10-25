/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import com.vis.graphynext.dicom.store.DicomStorageService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * 起動後に、受信日時を持たない既存の行を背景で埋める（{@link DicomStorageService#backfillReceivedAt()}）。
 * 起動を遅らせないよう別スレッドで走らせる。失敗しても起動は止めない（埋まるまで、その検査は自動削除の対象にならない）。
 */
@Component
public class RetentionBackfill {

    private static final Logger log = LoggerFactory.getLogger(RetentionBackfill.class);

    private final DicomStorageService storage;

    public RetentionBackfill(DicomStorageService storage) {
        this.storage = storage;
    }

    @EventListener(ApplicationReadyEvent.class)
    void onReady() {
        Thread t = new Thread(() -> {
            try {
                storage.backfillReceivedAt();
            } catch (RuntimeException e) {
                log.warn("受信日時の埋め直しに失敗しました（その検査は自動削除の対象になりません）", e);
            }
        }, "received-at-backfill");
        t.setDaemon(true);
        t.start();
    }
}

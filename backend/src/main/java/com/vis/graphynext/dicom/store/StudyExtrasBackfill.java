/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * 起動後に、StudyTime・StudyID・ReferringPhysicianName をまだ読んでいない既存の行を背景で埋める
 * （{@link DicomStorageService#backfillStudyExtras()}）。起動を遅らせないよう別スレッドで走らせる。
 * 失敗しても起動は止めない（埋まるまで、これらの属性は他端末からの検索で空として扱われる）。
 */
@Component
public class StudyExtrasBackfill {

    private static final Logger log = LoggerFactory.getLogger(StudyExtrasBackfill.class);

    private final DicomStorageService storage;

    public StudyExtrasBackfill(DicomStorageService storage) {
        this.storage = storage;
    }

    @EventListener(ApplicationReadyEvent.class)
    void onReady() {
        Thread t = new Thread(() -> {
            try {
                storage.backfillStudyExtras();
            } catch (RuntimeException e) {
                log.warn("StudyTime などの埋め直しに失敗しました（他端末からの検索では空として扱われます）", e);
            }
        }, "study-extras-backfill");
        t.setDaemon(true);
        t.start();
    }
}

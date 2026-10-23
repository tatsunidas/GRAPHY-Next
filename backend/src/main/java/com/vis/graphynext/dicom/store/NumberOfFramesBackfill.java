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
 * 起動後に、NumberOfFrames を持たない既存の行を背景で埋める（{@link DicomStorageService#backfillNumberOfFrames()}）。
 * 起動を遅らせないよう別スレッドで走らせる。失敗しても起動は止めない（埋まるまで枚数は「不明」と出る）。
 */
@Component
public class NumberOfFramesBackfill {

    private static final Logger log = LoggerFactory.getLogger(NumberOfFramesBackfill.class);

    private final DicomStorageService storage;

    public NumberOfFramesBackfill(DicomStorageService storage) {
        this.storage = storage;
    }

    @EventListener(ApplicationReadyEvent.class)
    void onReady() {
        Thread t = new Thread(() -> {
            try {
                storage.backfillNumberOfFrames();
            } catch (RuntimeException e) {
                log.warn("NumberOfFrames の埋め直しに失敗しました（枚数は「不明」のままです）", e);
            }
        }, "number-of-frames-backfill");
        t.setDaemon(true);
        t.start();
    }
}

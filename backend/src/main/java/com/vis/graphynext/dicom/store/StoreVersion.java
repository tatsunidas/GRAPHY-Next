/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import com.vis.graphynext.gdrive.StorageChanged;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 保管庫の変更（取り込み・受信・削除）の通し番号。メイン一覧が「新しい検査が届いたか」を軽く問い合わせるためのもの
 * （一覧そのものを取り直さずに済む）。{@link StorageChanged} は索引へ保存したあとに出るので、番号が増えた時点で
 * 一覧を取り直せば、その検査が載る。プロセスの中だけの数なので、再起動で 0 から始まる（問い合わせる側は、減ったら基準を引き直す）。
 */
@Component
public class StoreVersion {

    public record Snapshot(long version, long changedAt) {
    }

    private final AtomicLong version = new AtomicLong();
    private volatile long changedAt;
    private final Clock clock;

    public StoreVersion() {
        this(Clock.systemUTC());
    }

    StoreVersion(Clock clock) {
        this.clock = clock;
    }

    @EventListener
    public void onStorageChanged(StorageChanged e) {
        changedAt = clock.millis();
        version.incrementAndGet();
    }

    public Snapshot snapshot() {
        return new Snapshot(version.get(), changedAt);
    }
}

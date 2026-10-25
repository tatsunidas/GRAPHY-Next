/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import com.vis.graphynext.dicom.store.StorageLayout;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;

/** 保管庫があるディスクの空きと全容量。テストで差し替える。 */
@Component
public class FreeSpaceProvider {

    private final StorageLayout layout;

    public FreeSpaceProvider(StorageLayout layout) {
        this.layout = layout;
    }

    /** 保管庫のフォルダは最初の受信で作られる。まだ無いときは、同じディスクにある最も近い親で測る。 */
    private static java.nio.file.Path existing(java.nio.file.Path p) {
        java.nio.file.Path cur = p.toAbsolutePath();
        while (cur != null && !Files.exists(cur)) {
            cur = cur.getParent();
        }
        if (cur == null) {
            throw new IllegalStateException("保管庫のあるディスクを特定できません: " + p);
        }
        return cur;
    }

    public long usableBytes() {
        try {
            return Files.getFileStore(existing(layout.root())).getUsableSpace();
        } catch (IOException e) {
            throw new IllegalStateException("ディスクの空きを取得できません: " + layout.root(), e);
        }
    }

    public long totalBytes() {
        try {
            return Files.getFileStore(existing(layout.root())).getTotalSpace();
        } catch (IOException e) {
            throw new IllegalStateException("ディスクの容量を取得できません: " + layout.root(), e);
        }
    }
}

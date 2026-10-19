/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/**
 * 監視フォルダで処理済みのファイル 1 件の台帳。キーは正規化した絶対パス。大きさか更新時刻が変われば別のファイルとして
 * 扱い直す。索引（H2）の中にあるので DB フォルダごと。台帳を失えば、置き直したのと同じく取り込み直す（DICOM は冪等）。
 */
@Entity
@Table(name = "import_watch_item")
public class ImportWatchItem {

    public static final String IMPORTED = "IMPORTED";
    public static final String SKIPPED = "SKIPPED";
    public static final String FAILED = "FAILED";
    /** 取り込まずに保留（例: 患者情報の無い NIfTI）。完了扱いにせず、条件が変われば再判定する。理由は {@code error}。 */
    public static final String HELD = "HELD";
    /** 取り込み済みの NIfTI の中身が後から変わった（再取り込みはしない）。 */
    public static final String CHANGED = "CHANGED";

    @Id
    @Column(length = 1024)
    private String path;
    private long size;
    private long mtime;
    @Column(length = 16, nullable = false)
    private String status;
    /** 処理した時刻（epoch ms）。 */
    private long at;
    @Column(length = 400)
    private String error;

    protected ImportWatchItem() {
    }

    public ImportWatchItem(String path, long size, long mtime, String status, long at, String error) {
        this.path = path;
        this.size = size;
        this.mtime = mtime;
        this.status = status;
        this.at = at;
        this.error = error == null || error.length() <= 400 ? error : error.substring(0, 400);
    }

    public String getPath() {
        return path;
    }

    public long getSize() {
        return size;
    }

    public long getMtime() {
        return mtime;
    }

    public String getStatus() {
        return status;
    }

    public long getAt() {
        return at;
    }

    public String getError() {
        return error;
    }
}

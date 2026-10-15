/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;

/**
 * 同期台帳の 1 行＝保管庫の 1 ファイル。索引（H2）の中に持つので、索引ごと別の場所へ移せば台帳も付いていく。
 * 台帳を失っても reconcile が Drive 側と突き合わせて作り直す（重複して送らない）。
 */
@Entity
@Table(name = "gdrive_sync_item", indexes = @Index(name = "ix_gdrive_state_next", columnList = "state,nextAttemptAt"))
public class GdriveSyncItem {

    public static final String SYNCED = "SYNCED";
    public static final String PENDING = "PENDING";
    /** ローカルに無くなった。Drive 側をゴミ箱へ移す待ち。 */
    public static final String REMOVE = "REMOVE";
    /** 権限などで止まった。Drive には触れず、利用者の対応を待つ。 */
    public static final String BLOCKED = "BLOCKED";

    /** 保管庫ルートからの相対パス（{@code /} 区切り）。 */
    @Id
    @Column(length = 512)
    private String relPath;

    /** 同期先の Drive フォルダ。別のフォルダへ切り替えたときは、この行を捨てて出し直す。 */
    @Column(length = 128, nullable = false)
    private String folderId;

    private long size;
    private long mtime;
    @Column(length = 32)
    private String md5;
    @Column(length = 128)
    private String driveFileId;
    @Column(length = 16, nullable = false)
    private String state;
    private int attempts;
    private long nextAttemptAt;
    @Column(length = 2048)
    private String sessionUri;
    @Column(length = 200)
    private String lastError;
    /** モード A: 手元の実体を追い出した（Drive が正本として持っている）。既存の行は false のまま（DEFAULT つきの列追加）。 */
    @Column(nullable = false, columnDefinition = "boolean default false not null")
    private boolean evicted;
    /** 最後に読まれた（または同期済みになった）時刻。追い出しの古い順に使う。 */
    @Column(nullable = false, columnDefinition = "bigint default 0 not null")
    private long lastAccessAt;

    protected GdriveSyncItem() {
    }

    public GdriveSyncItem(String relPath, String folderId, String state) {
        this.relPath = relPath;
        this.folderId = folderId;
        this.state = state;
    }

    public String getRelPath() {
        return relPath;
    }

    public String getFolderId() {
        return folderId;
    }

    public long getSize() {
        return size;
    }

    public void setSize(long size) {
        this.size = size;
    }

    public long getMtime() {
        return mtime;
    }

    public void setMtime(long mtime) {
        this.mtime = mtime;
    }

    public String getMd5() {
        return md5;
    }

    public void setMd5(String md5) {
        this.md5 = md5;
    }

    public String getDriveFileId() {
        return driveFileId;
    }

    public void setDriveFileId(String driveFileId) {
        this.driveFileId = driveFileId;
    }

    public String getState() {
        return state;
    }

    public void setState(String state) {
        this.state = state;
    }

    public int getAttempts() {
        return attempts;
    }

    public void setAttempts(int attempts) {
        this.attempts = attempts;
    }

    public long getNextAttemptAt() {
        return nextAttemptAt;
    }

    public void setNextAttemptAt(long nextAttemptAt) {
        this.nextAttemptAt = nextAttemptAt;
    }

    public String getSessionUri() {
        return sessionUri;
    }

    public void setSessionUri(String sessionUri) {
        this.sessionUri = sessionUri;
    }

    public String getLastError() {
        return lastError;
    }

    public void setLastError(String lastError) {
        this.lastError = lastError == null || lastError.length() <= 200 ? lastError : lastError.substring(0, 200);
    }

    public boolean isEvicted() {
        return evicted;
    }

    public void setEvicted(boolean evicted) {
        this.evicted = evicted;
    }

    public long getLastAccessAt() {
        return lastAccessAt;
    }

    public void setLastAccessAt(long lastAccessAt) {
        this.lastAccessAt = lastAccessAt;
    }
}

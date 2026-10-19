/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

/**
 * 保管庫のファイルが手元に無く、取り寄せることもできなかった（モード A: Drive が正本）。
 * 🔴 「ファイルが無い」（null）と区別するための例外。呼び出し側が null を「その画像は無い」と読んで
 * 黙ってスキップすると、「ROI なし」「線量なし」「ZIP に入らない」のような誤った成功になるため、必ず上へ投げる。
 */
public class StorageUnavailableException extends RuntimeException {

    public static final String OFFLINE = "offline";
    public static final String NEEDS_LOGIN = "needs-login";
    public static final String DISABLED = "drive-disabled";
    public static final String MD5_MISMATCH = "md5-mismatch";
    public static final String NO_CHECKSUM = "no-checksum";
    public static final String NOT_ON_DRIVE = "not-on-drive";
    public static final String DRIVE_ERROR = "drive-error";

    private final String reason;

    public StorageUnavailableException(String reason) {
        super("storage-unavailable: " + reason);
        this.reason = reason;
    }

    public StorageUnavailableException(String reason, Throwable cause) {
        super("storage-unavailable: " + reason, cause);
        this.reason = reason;
    }

    /** 理由コード（画面の文言に対応づける）。 */
    public String reason() {
        return reason;
    }
}

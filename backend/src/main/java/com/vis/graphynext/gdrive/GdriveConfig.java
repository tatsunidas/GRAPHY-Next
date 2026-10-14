/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import java.util.regex.Pattern;

/**
 * main から届く設定。<b>メモリにだけ持つ</b>（正本は main の safeStorage と db-folders.json）。
 * 🔴 {@link #toString()} に秘密を出さない。
 */
public record GdriveConfig(String clientId, String clientSecret, String refreshToken,
                           String folderId, String driveId, String name) {

    /** {@code desktop/dbFolders.js} の {@code DRIVE_ID_RE} と同じ形。 */
    static final Pattern ID_RE = Pattern.compile("[A-Za-z0-9_-]{10,128}");

    /** 問題があれば理由、無ければ null。 */
    public String problem() {
        if (blank(clientId) || blank(refreshToken)) {
            return "credentials-missing";
        }
        if (folderId == null || !ID_RE.matcher(folderId).matches()) {
            return "bad-folder-id";
        }
        if (driveId != null && !driveId.isEmpty() && !ID_RE.matcher(driveId).matches()) {
            return "bad-drive-id";
        }
        return null;
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    @Override
    public String toString() {
        return "GdriveConfig[folderId=" + folderId + ", driveId=" + driveId + "]";
    }
}

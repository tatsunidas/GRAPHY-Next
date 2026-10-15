/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

/** 保管庫のファイルが変わった合図。取りこぼしても reconcile が拾うので、あくまで「早く気付く」ためのもの。 */
public record StorageChanged(String relPath) {
}

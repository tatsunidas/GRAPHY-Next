/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** 保管庫の変更の通し番号（読み取りだけ）。web モードでは保管庫への取り込みが無いので、番号は 0 のまま。 */
@RestController
@RequestMapping("/api/studies")
public class StoreVersionController {

    private final StoreVersion storeVersion;

    public StoreVersionController(StoreVersion storeVersion) {
        this.storeVersion = storeVersion;
    }

    @GetMapping("/version")
    public StoreVersion.Snapshot version() {
        return storeVersion.snapshot();
    }
}

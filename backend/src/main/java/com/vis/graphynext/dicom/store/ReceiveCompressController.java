/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** 受信時の可逆圧縮の状態。受信（SCP）は standalone だけなので、この口も standalone だけ。設定は汎用の設定 API。 */
@RestController
@RequestMapping("/api/dicom/receive-compress")
@Profile("standalone")
public class ReceiveCompressController {

    private final ReceiveCompressor compressor;

    public ReceiveCompressController(ReceiveCompressor compressor) {
        this.compressor = compressor;
    }

    @GetMapping("/status")
    public ReceiveCompressor.Status status() {
        return compressor.status();
    }
}

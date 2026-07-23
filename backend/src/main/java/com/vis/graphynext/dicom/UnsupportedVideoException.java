/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

/**
 * 動画の転送構文がブラウザで無変換再生できず、サーバ側トランスコード（ffmpeg, P4 で対応）が必要なときに
 * 投げる。P1 時点ではトランスコード未対応のため、コントローラは 415 Unsupported Media Type に写像する。
 */
public class UnsupportedVideoException extends RuntimeException {

    private final String transferSyntaxUid;

    public UnsupportedVideoException(String transferSyntaxUid) {
        super("video transfer syntax not playable without transcode: " + transferSyntaxUid);
        this.transferSyntaxUid = transferSyntaxUid;
    }

    public String getTransferSyntaxUid() {
        return transferSyntaxUid;
    }
}

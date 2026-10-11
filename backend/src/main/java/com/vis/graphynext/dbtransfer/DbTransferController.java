/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbtransfer;

import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletRequestWrapper;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.net.InetAddress;
import java.util.List;

/**
 * DB フォルダ間のコピー・移動（standalone のみ）。
 *
 * <p>入力の誤りは 400 で、{@code message} に理由コード（{@code target-not-found} など）を返す。
 *
 * <p>🔴 この PC からの要求だけを受ける。書き込み先のフォルダを受け取るので、LAN の他の端末から呼べると
 * 患者の DICOM を任意の共有フォルダへ書き出させることができてしまう。
 */
@RestController
@RequestMapping("/api/db-transfer")
@Profile("standalone")
public class DbTransferController {

    private final DbTransferService transfer;
    private final InboxIngestService inbox;

    public DbTransferController(DbTransferService transfer, InboxIngestService inbox) {
        this.transfer = transfer;
        this.inbox = inbox;
    }

    public record TransferRequest(List<String> studyUids, String targetFolder, String mode) {
    }

    @PostMapping
    public DbTransferService.TransferResult transfer(@RequestBody TransferRequest req, HttpServletRequest http)
            throws IOException {
        requireLoopback(http);
        DbTransferService.Mode mode;
        try {
            mode = DbTransferService.Mode.valueOf(req.mode() == null ? "" : req.mode());
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("bad-mode");
        }
        return transfer.transfer(req.studyUids(), req.targetFolder(), mode);
    }

    /** この起動で取り込んだ荷物の結果と、書きかけで残っている荷物。 */
    @GetMapping("/inbox")
    public InboxIngestService.Status inbox(HttpServletRequest http) {
        requireLoopback(http);
        return inbox.status();
    }

    /**
     * 接続元がこの PC か。{@code forward-headers-strategy: framework} では外側の要求が
     * {@code X-Forwarded-For} で接続元を書き換えるので、ラッパーをはがした生の接続元で判定する。
     */
    static void requireLoopback(HttpServletRequest http) {
        ServletRequest raw = http;
        while (raw instanceof ServletRequestWrapper w) {
            raw = w.getRequest();
        }
        boolean loopback;
        try {
            loopback = InetAddress.getByName(raw.getRemoteAddr()).isLoopbackAddress();
        } catch (IOException e) {
            loopback = false;
        }
        if (!loopback) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "local-only");
        }
    }
}

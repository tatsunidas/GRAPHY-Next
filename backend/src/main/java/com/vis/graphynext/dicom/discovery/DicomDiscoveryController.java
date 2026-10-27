/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.discovery;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.util.List;

/** 同じ LAN の DICOM 機器の探索（利用者が押したときだけ）と、自局の広告状態。 */
@RestController
@RequestMapping("/api/dicom/discovery")
@ConditionalOnProperty(prefix = "graphy.dicom.scp", name = "enabled", havingValue = "true")
public class DicomDiscoveryController {

    private final DicomDiscoveryService discovery;

    public DicomDiscoveryController(DicomDiscoveryService discovery) {
        this.discovery = discovery;
    }

    /** 約 3 秒探して、見つかった機器を返す（自局は除く）。検出した機器は認証されていない。 */
    @PostMapping("/scan")
    public List<DicomDiscoveryService.Found> scan() {
        try {
            return discovery.scan();
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "ネットワークを探せません: " + e.getMessage());
        }
    }

    @GetMapping("/status")
    public DicomDiscoveryService.Status status() {
        return discovery.status();
    }
}

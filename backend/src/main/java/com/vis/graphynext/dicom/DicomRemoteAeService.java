/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.settings.SettingsService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/**
 * 設定済みの相手先 AE の一覧。application.yml の {@code graphy.dicom.remote-aes}（運用配布の既定値）と、
 * Settings(H2) に GUI から保存された分（{@link DicomController#REMOTE_AES_KEY}）を<b>マージ</b>する。
 * AE タイトルが重複したら Settings 側が上書きする。
 *
 * <p>送信先の選択肢（{@code GET /api/dicom/remote-aes}）と、他端末からの検索を受け付ける相手の
 * 許可リスト（{@link DicomQrAccess}）が、同じ一覧を見るためにここへ集めてある。
 */
@Service
public class DicomRemoteAeService {

    private static final Logger log = LoggerFactory.getLogger(DicomRemoteAeService.class);

    private final DicomProperties props;
    private final SettingsService settings;
    private final ObjectMapper mapper;

    public DicomRemoteAeService(DicomProperties props, SettingsService settings, ObjectMapper mapper) {
        this.props = props;
        this.settings = settings;
        this.mapper = mapper;
    }

    public List<DicomController.RemoteAeDto> list() {
        LinkedHashMap<String, DicomController.RemoteAeDto> byAet = new LinkedHashMap<>();
        for (DicomProperties.RemoteAe a : props.getRemoteAes()) {
            if (a.getAeTitle() != null && !a.getAeTitle().isBlank()) {
                byAet.put(a.getAeTitle(),
                        new DicomController.RemoteAeDto(a.getAeTitle(), a.getHost(), a.getPort(), a.isTls()));
            }
        }
        String json = settings.getAll().get(DicomController.REMOTE_AES_KEY);
        if (json != null && !json.isBlank()) {
            try {
                List<DicomController.RemoteAeDto> stored = mapper.readValue(json,
                        new TypeReference<List<DicomController.RemoteAeDto>>() {
                        });
                for (DicomController.RemoteAeDto a : stored) {
                    if (a.aeTitle() != null && !a.aeTitle().isBlank()) {
                        byAet.put(a.aeTitle(), a); // Settings 保存分が YAML を上書き
                    }
                }
            } catch (Exception e) {
                log.warn("Settings の {} を解析できませんでした（無視）: {}", DicomController.REMOTE_AES_KEY, e.toString());
            }
        }
        return new ArrayList<>(byAet.values());
    }
}

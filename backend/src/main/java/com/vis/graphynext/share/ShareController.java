/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.share;

import com.vis.graphynext.dicom.StudyDto;
import com.vis.graphynext.dicom.store.DicomStorageService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 受け手に見せる「この共有の検査」。許可範囲は {@link ShareAccessFilter} が Cookie から決めて渡す。
 * 一覧 API（{@code /api/studies}）は許可リスト外なので、受け手はこれでしか検査を知れない。
 */
@RestController
@ConditionalOnProperty(prefix = "graphy.share", name = "enabled", havingValue = "true")
public class ShareController {

    private final DicomStorageService storage;

    public ShareController(DicomStorageService storage) {
        this.storage = storage;
    }

    @GetMapping(ShareRoutes.SHARE_INFO_PATH)
    public ResponseEntity<List<StudyDto>> study(HttpServletRequest request) {
        ShareGrant grant = (ShareGrant) request.getAttribute(ShareAccessFilter.GRANT_ATTR);
        if (grant == null) {
            return ResponseEntity.notFound().build(); // フィルタを通っていない＝到達しない想定の守り
        }
        List<StudyDto> studies = storage.listStudies().stream()
                .filter(s -> grant.getStudyUids().contains(s.studyInstanceUid()))
                .toList();
        return ResponseEntity.ok(studies);
    }
}

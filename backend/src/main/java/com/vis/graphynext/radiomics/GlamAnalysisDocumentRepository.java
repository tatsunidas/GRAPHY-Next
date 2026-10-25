/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface GlamAnalysisDocumentRepository extends JpaRepository<GlamAnalysisDocument, String> {

    List<GlamAnalysisDocument> findByStudyInstanceUidOrderBySavedAtDesc(String studyInstanceUid);

    /** 自動削除の保護: GLAM 解析がある検査（本文は読まない）。 */
    @org.springframework.data.jpa.repository.Query("select distinct g.studyInstanceUid from GlamAnalysisDocument g where g.studyInstanceUid is not null")
    List<String> studiesWithAnalyses();
}

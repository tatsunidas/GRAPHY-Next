/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface GlamAnalysisDocumentRepository extends JpaRepository<GlamAnalysisDocument, String> {

    List<GlamAnalysisDocument> findByStudyInstanceUidOrderBySavedAtDesc(String studyInstanceUid);
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.roi;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.Collection;
import java.util.List;

public interface RoiMaskDocumentRepository extends JpaRepository<RoiMaskDocument, String> {

    /** 画像の削除に伴う掃除用。消した行数を返す。 */
    long deleteBySeriesUidIn(Collection<String> seriesUids);

    long deleteByPatientKey(String patientKey);

    List<RoiMaskDocument> findByPatientKey(String patientKey);

    /** 画素（{@code frames}）を読まずに一覧を引く（画素は 1 件ごとに別 API で取る）。 */
    @Query("select new com.vis.graphynext.roi.RoiMaskSummary(d.maskUid, d.seriesUid, d.meta, d.frameCount, "
            + "d.frameBytes, d.version, d.updatedAt) from RoiMaskDocument d where d.patientKey = ?1 order by d.updatedAt")
    List<RoiMaskSummary> findSummariesByPatientKey(String patientKey);
}

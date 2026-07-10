/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface ReportRepository extends JpaRepository<Report, String> {

    List<Report> findByStudyInstanceUidOrderByCreatedAtDesc(String studyInstanceUid);

    List<Report> findByPatientIdOrderByCreatedAtDesc(String patientId);

    /** MainScreen 一覧用: スタディごとの下書き件数・確定件数（`fw/report-design.md` §6）。 */
    @Query("""
            select r.studyInstanceUid as studyInstanceUid,
                   sum(case when r.status = 'DRAFT' then 1L else 0L end) as draftCount,
                   sum(case when r.status <> 'DRAFT' then 1L else 0L end) as finalCount
            from Report r
            where r.studyInstanceUid in :studyUids
            group by r.studyInstanceUid
            """)
    List<StudyReportCountRow> countByStudy(@Param("studyUids") List<String> studyUids);

    interface StudyReportCountRow {
        String getStudyInstanceUid();

        long getDraftCount();

        long getFinalCount();
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface PrefetchHoldRepository extends JpaRepository<PrefetchHold, String> {
    @Query("select h.studyUid from PrefetchHold h where h.untilMs > :nowMs")
    List<String> activeStudyUids(@Param("nowMs") long nowMs);
}

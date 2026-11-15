/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface PrefetchRunRepository extends JpaRepository<PrefetchRun, Long> {
    List<PrefetchRun> findTop20ByOrderByIdDesc();

    boolean existsBySlotKeyAndStatus(String slotKey, String status);

    PrefetchRun findTopBySlotKeyOrderByIdDesc(String slotKey);
}

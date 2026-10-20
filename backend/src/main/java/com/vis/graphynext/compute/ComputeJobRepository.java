/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;

interface ComputeJobRepository extends JpaRepository<ComputeJobRecord, String> {

    List<ComputeJobRecord> findAllByOrderByQueuedAtDesc();

    List<ComputeJobRecord> findByStateIn(Collection<String> states);

    List<ComputeJobRecord> findByRemoteCleanup(String remoteCleanup);

    List<ComputeJobRecord> findByInputRefsContaining(String text);

    long countByBatchId(String batchId);
}

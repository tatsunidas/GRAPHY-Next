/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

@Component
class JpaComputeJobStore implements ComputeJobStore {

    private final ComputeBatchRepository batches;
    private final ComputeJobRepository jobs;

    JpaComputeJobStore(ComputeBatchRepository batches, ComputeJobRepository jobs) {
        this.batches = batches;
        this.jobs = jobs;
    }

    @Override
    public ComputeBatchRecord saveBatch(ComputeBatchRecord b) {
        return batches.save(b);
    }

    @Override
    public ComputeJobRecord saveJob(ComputeJobRecord j) {
        return jobs.save(j);
    }

    @Override
    public Optional<ComputeBatchRecord> findBatch(String id) {
        return batches.findById(id);
    }

    @Override
    public Optional<ComputeJobRecord> findJob(String id) {
        return jobs.findById(id);
    }

    @Override
    public List<ComputeJobRecord> listJobs() {
        return jobs.findAllByOrderByQueuedAtDesc();
    }

    @Override
    public List<ComputeJobRecord> findJobsByState(Collection<String> states) {
        return jobs.findByStateIn(states);
    }

    @Override
    public List<ComputeJobRecord> findCleanupPending() {
        return jobs.findByRemoteCleanup("pending");
    }

    @Override
    public List<ComputeJobRecord> findJobsReferencing(String seriesUid) {
        return jobs.findByInputRefsContaining(seriesUid);
    }

    @Override
    public void deleteJob(String id) {
        jobs.deleteById(id);
    }

    @Override
    public void deleteBatch(String id) {
        batches.deleteById(id);
    }

    @Override
    public long countJobsInBatch(String batchId) {
        return jobs.countByBatchId(batchId);
    }
}

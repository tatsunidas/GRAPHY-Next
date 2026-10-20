/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/** Spring を使わないテスト用の台帳の保存先（保存・読み出しのたびに写しを作り、本物の H2 のように別物として扱う）。 */
class InMemoryComputeJobStore implements ComputeJobStore {

    private final Map<String, ComputeBatchRecord> batches = new ConcurrentHashMap<>();
    private final Map<String, ComputeJobRecord> jobs = new ConcurrentHashMap<>();

    @Override
    public ComputeBatchRecord saveBatch(ComputeBatchRecord b) {
        batches.put(b.id, copy(b));
        return b;
    }

    @Override
    public ComputeJobRecord saveJob(ComputeJobRecord j) {
        jobs.put(j.id, copy(j));
        return j;
    }

    @Override
    public Optional<ComputeBatchRecord> findBatch(String id) {
        return Optional.ofNullable(batches.get(id)).map(InMemoryComputeJobStore::copy);
    }

    @Override
    public Optional<ComputeJobRecord> findJob(String id) {
        return Optional.ofNullable(jobs.get(id)).map(InMemoryComputeJobStore::copy);
    }

    @Override
    public List<ComputeJobRecord> listJobs() {
        return jobs.values().stream().map(InMemoryComputeJobStore::copy)
                .sorted(Comparator.comparing((ComputeJobRecord j) -> j.queuedAt).reversed()).toList();
    }

    @Override
    public List<ComputeJobRecord> findJobsByState(Collection<String> states) {
        return jobs.values().stream().filter(j -> states.contains(j.state)).map(InMemoryComputeJobStore::copy).toList();
    }

    @Override
    public List<ComputeJobRecord> findCleanupPending() {
        return jobs.values().stream().filter(j -> "pending".equals(j.remoteCleanup)).map(InMemoryComputeJobStore::copy)
                .toList();
    }

    @Override
    public List<ComputeJobRecord> findJobsReferencing(String seriesUid) {
        return jobs.values().stream().filter(j -> j.inputRefs != null && j.inputRefs.contains(seriesUid))
                .map(InMemoryComputeJobStore::copy).toList();
    }

    @Override
    public void deleteJob(String id) {
        jobs.remove(id);
    }

    @Override
    public void deleteBatch(String id) {
        batches.remove(id);
    }

    @Override
    public long countJobsInBatch(String batchId) {
        return jobs.values().stream().filter(j -> batchId.equals(j.batchId)).count();
    }

    private static ComputeBatchRecord copy(ComputeBatchRecord s) {
        ComputeBatchRecord d = new ComputeBatchRecord(s.id);
        d.pluginId = s.pluginId;
        d.pluginName = s.pluginName;
        d.pluginVersion = s.pluginVersion;
        d.pluginPackageSha256 = s.pluginPackageSha256;
        d.code = s.code;
        d.codeSha256 = s.codeSha256;
        d.endpointId = s.endpointId;
        d.endpointLabel = s.endpointLabel;
        d.endpointKind = s.endpointKind;
        d.endpointHost = s.endpointHost;
        d.plaintext = s.plaintext;
        d.timeoutSec = s.timeoutSec;
        d.interactive = s.interactive;
        d.pausedReason = s.pausedReason;
        d.consentRequestId = s.consentRequestId;
        d.createdAt = s.createdAt;
        return d;
    }

    private static ComputeJobRecord copy(ComputeJobRecord s) {
        ComputeJobRecord d = new ComputeJobRecord(s.id, s.batchId);
        d.itemKey = s.itemKey;
        d.attempt = s.attempt;
        d.inputRefs = s.inputRefs;
        d.requestId = s.requestId;
        d.contentHash = s.contentHash;
        d.pluginJobId = s.pluginJobId;
        d.state = s.state;
        d.phase = s.phase;
        d.progress = s.progress;
        d.message = s.message;
        d.reason = s.reason;
        d.errorName = s.errorName;
        d.errorValue = s.errorValue;
        d.envJson = s.envJson;
        d.remoteRunDir = s.remoteRunDir;
        d.kernelId = s.kernelId;
        d.remoteCleanup = s.remoteCleanup;
        d.queuedAt = s.queuedAt;
        d.startedAt = s.startedAt;
        d.finishedAt = s.finishedAt;
        d.outputsBytes = s.outputsBytes;
        d.collectedAt = s.collectedAt;
        return d;
    }
}

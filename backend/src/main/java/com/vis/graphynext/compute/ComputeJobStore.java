/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/** 計算ジョブの台帳の保存先（本番は H2＝{@link JpaComputeJobStore}、Spring を使わないテストはメモリ）。 */
interface ComputeJobStore {

    ComputeBatchRecord saveBatch(ComputeBatchRecord b);

    ComputeJobRecord saveJob(ComputeJobRecord j);

    Optional<ComputeBatchRecord> findBatch(String id);

    Optional<ComputeJobRecord> findJob(String id);

    /** 新しい順。 */
    List<ComputeJobRecord> listJobs();

    List<ComputeJobRecord> findJobsByState(Collection<String> states);

    /** {@code remote_cleanup = pending} の行。 */
    List<ComputeJobRecord> findCleanupPending();

    /** 入力に {@code seriesUid} を含む行（{@code inputRefs} の部分一致。呼び出し側が JSON を読み直して確かめる）。 */
    List<ComputeJobRecord> findJobsReferencing(String seriesUid);

    void deleteJob(String id);

    void deleteBatch(String id);

    long countJobsInBatch(String batchId);
}

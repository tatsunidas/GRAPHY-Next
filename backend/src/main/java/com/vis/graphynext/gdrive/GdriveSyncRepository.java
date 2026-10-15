/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

public interface GdriveSyncRepository extends JpaRepository<GdriveSyncItem, String> {

    long countByFolderIdAndState(String folderId, String state);

    /** 今やるべき分（待ち・削除待ち）。古い順。 */
    @Query("select i from GdriveSyncItem i where i.folderId = :folderId and i.state in ('PENDING','REMOVE') "
            + "and i.nextAttemptAt <= :now order by i.nextAttemptAt, i.relPath")
    List<GdriveSyncItem> due(String folderId, long now);

    List<GdriveSyncItem> findByFolderId(String folderId);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Transactional
    @Query("delete from GdriveSyncItem i where i.folderId <> :folderId")
    int deleteOtherFolders(String folderId);

    /** 手元にある実体の合計（追い出し済みと Drive 側の削除待ちは数えない）。 */
    @Query("select coalesce(sum(i.size), 0) from GdriveSyncItem i where i.folderId = :folderId "
            + "and i.evicted = false and i.state <> 'REMOVE'")
    long localBytes(String folderId);

    @Query("select count(i) from GdriveSyncItem i where i.folderId = :folderId and i.evicted = false and i.state <> 'REMOVE'")
    long localCount(String folderId);

    long countByFolderIdAndEvictedTrue(String folderId);

    List<GdriveSyncItem> findByFolderIdAndEvictedTrue(String folderId);

    /** 追い出してよい候補（Drive に md5 一致で載っている・手元にある・{@code cutoff} より前に最後に使われた）。古い順。 */
    @Query("select i from GdriveSyncItem i where i.folderId = :folderId and i.state = 'SYNCED' and i.evicted = false "
            + "and i.lastAccessAt < :cutoff order by i.lastAccessAt, i.relPath")
    List<GdriveSyncItem> evictable(String folderId, long cutoff, org.springframework.data.domain.Pageable page);
}

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
}

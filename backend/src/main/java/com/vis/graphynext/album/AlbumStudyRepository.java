/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.album;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Collection;
import java.util.List;

public interface AlbumStudyRepository extends JpaRepository<AlbumStudy, AlbumStudyId> {

    /** 追加順（同じ時刻なら UID 順）。 */
    @Query("select s.id.studyInstanceUid from AlbumStudy s where s.id.albumId = :albumId"
            + " order by s.addedAt, s.id.studyInstanceUid")
    List<String> findUids(@Param("albumId") Long albumId);

    @Query("select s.id.studyInstanceUid from AlbumStudy s"
            + " where s.id.albumId = :albumId and s.id.studyInstanceUid in :uids")
    List<String> findExisting(@Param("albumId") Long albumId, @Param("uids") Collection<String> uids);

    /** アルバムごとの所属数（[albumId, count]）。 */
    @Query("select s.id.albumId, count(s) from AlbumStudy s group by s.id.albumId")
    List<Object[]> countByAlbum();

    long countByIdAlbumId(Long albumId);

    @Modifying
    @Query("delete from AlbumStudy s where s.id.albumId = :albumId and s.id.studyInstanceUid in :uids")
    int deleteMembers(@Param("albumId") Long albumId, @Param("uids") Collection<String> uids);

    @Modifying
    @Query("delete from AlbumStudy s where s.id.albumId = :albumId")
    int deleteAllMembers(@Param("albumId") Long albumId);
}

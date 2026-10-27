/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.album;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;

import java.io.Serializable;
import java.util.Objects;

/** アルバムの所属の鍵（アルバム id ＋ StudyInstanceUID）。同じスタディは 1 つのアルバムに 1 回だけ入る。 */
@Embeddable
public class AlbumStudyId implements Serializable {

    private static final long serialVersionUID = 1L;

    @Column(name = "album_id", nullable = false)
    private Long albumId;

    @Column(name = "study_instance_uid", length = AlbumService.UID_MAX, nullable = false)
    private String studyInstanceUid;

    protected AlbumStudyId() {
        // JPA 用
    }

    public AlbumStudyId(Long albumId, String studyInstanceUid) {
        this.albumId = albumId;
        this.studyInstanceUid = studyInstanceUid;
    }

    public Long getAlbumId() {
        return albumId;
    }

    public String getStudyInstanceUid() {
        return studyInstanceUid;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof AlbumStudyId other)) {
            return false;
        }
        return Objects.equals(albumId, other.albumId) && Objects.equals(studyInstanceUid, other.studyInstanceUid);
    }

    @Override
    public int hashCode() {
        return Objects.hash(albumId, studyInstanceUid);
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.album;

import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * アルバムに入っているスタディ 1 件。<b>スタディの存在は確かめない</b>:
 * web ではスタディが PACS にあり、standalone でもスタディを削除したあとに宙ぶらりんの UID を残してよい
 * （「見つかりません」と出すのは画面側。ほかのスタディの表示は妨げない）。
 */
@Entity
@Table(name = "album_study")
public class AlbumStudy {

    @EmbeddedId
    private AlbumStudyId id;

    @Column(nullable = false)
    private Instant addedAt;

    protected AlbumStudy() {
        // JPA 用
    }

    public AlbumStudy(Long albumId, String studyInstanceUid, Instant addedAt) {
        this.id = new AlbumStudyId(albumId, studyInstanceUid);
        this.addedAt = addedAt;
    }

    public AlbumStudyId getId() {
        return id;
    }

    public Instant getAddedAt() {
        return addedAt;
    }
}

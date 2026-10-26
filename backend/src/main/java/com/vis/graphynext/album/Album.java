/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.album;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

import java.time.Instant;

/**
 * スタディを手動でまとめる「アルバム」（研究症例・教育症例など）。
 *
 * <p>表は DB（H2）に置く。アルバムは StudyInstanceUID に紐づくので、standalone では DB フォルダに追従し、
 * web ではサーバーに残って同じサーバーに接続した別の端末から同じものが見える。
 * <b>所属はスタディ本体の索引ではない</b>（{@link AlbumStudy}）。アルバムを消しても外しても、
 * スタディ（画像・索引）には触らない。
 */
@Entity
@Table(name = "album", uniqueConstraints = @UniqueConstraint(name = "uk_album_name", columnNames = "name"))
public class Album {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = AlbumService.NAME_MAX)
    private String name;

    @Column(nullable = false)
    private Instant createdAt;

    protected Album() {
        // JPA 用
    }

    public Album(String name) {
        this.name = name;
        this.createdAt = Instant.now();
    }

    public Long getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}

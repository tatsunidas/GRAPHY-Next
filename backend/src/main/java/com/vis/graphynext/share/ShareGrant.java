/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.share;

import jakarta.persistence.CollectionTable;
import jakarta.persistence.Column;
import jakarta.persistence.ElementCollection;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * 共有リンクが許す閲覧の範囲（どの検査を、いつまで）。
 *
 * <p>🔴 <b>生のトークンは持たない</b>。持つのは SHA-256 のハッシュだけで、DB が漏れても閲覧リンクは作れない。
 */
@Entity
@Table(name = "share_grant")
public class ShareGrant {

    @Id
    @Column(length = 36)
    private String id;

    @Column(name = "token_hash", length = 64, unique = true, nullable = false)
    private String tokenHash;

    @ElementCollection(fetch = FetchType.EAGER)
    @CollectionTable(name = "share_grant_study", joinColumns = @JoinColumn(name = "grant_id"))
    @Column(name = "study_uid", length = 64, nullable = false)
    private Set<String> studyUids = new LinkedHashSet<>();

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "revoked_at")
    private Instant revokedAt;

    protected ShareGrant() {
    }

    ShareGrant(String id, String tokenHash, Set<String> studyUids, Instant createdAt, Instant expiresAt) {
        this.id = id;
        this.tokenHash = tokenHash;
        this.studyUids = new LinkedHashSet<>(studyUids);
        this.createdAt = createdAt;
        this.expiresAt = expiresAt;
    }

    public String getId() { return id; }
    String getTokenHash() { return tokenHash; }
    public Set<String> getStudyUids() { return studyUids; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getExpiresAt() { return expiresAt; }
    public Instant getRevokedAt() { return revokedAt; }
    void setRevokedAt(Instant revokedAt) { this.revokedAt = revokedAt; }

    /** 取り消されておらず、期限内か。 */
    boolean isActiveAt(Instant now) {
        return revokedAt == null && now.isBefore(expiresAt);
    }
}

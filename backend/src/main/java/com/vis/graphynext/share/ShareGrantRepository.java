/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.share;

import org.springframework.data.jpa.repository.JpaRepository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface ShareGrantRepository extends JpaRepository<ShareGrant, String> {

    Optional<ShareGrant> findByTokenHash(String tokenHash);

    List<ShareGrant> findByExpiresAtBefore(Instant cutoff);
}

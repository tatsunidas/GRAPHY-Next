/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface PrefetchItemRepository extends JpaRepository<PrefetchItem, Long> {
    List<PrefetchItem> findTop500ByRunIdOrderByIdAsc(long runId);
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ImportWatchRepository extends JpaRepository<ImportWatchItem, String> {

    long countByStatus(String status);

    List<ImportWatchItem> findTop20ByStatusOrderByAtDesc(String status);
}

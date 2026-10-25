/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface RetentionRunRepository extends JpaRepository<RetentionRun, String> {
    List<RetentionRun> findAllByOrderByAtDesc(Pageable page);
}

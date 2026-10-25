/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import org.springframework.data.jpa.repository.JpaRepository;

public interface RetentionFirstRunRepository extends JpaRepository<RetentionFirstRun, String> {
}

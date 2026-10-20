/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import org.springframework.data.jpa.repository.JpaRepository;

interface ComputeBatchRepository extends JpaRepository<ComputeBatchRecord, String> {
}

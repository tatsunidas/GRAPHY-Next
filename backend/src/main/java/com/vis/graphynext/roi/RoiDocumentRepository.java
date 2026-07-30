/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.roi;

import org.springframework.data.jpa.repository.JpaRepository;

public interface RoiDocumentRepository extends JpaRepository<RoiDocument, String> {
}

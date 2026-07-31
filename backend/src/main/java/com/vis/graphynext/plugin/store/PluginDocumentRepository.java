/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.store;

import org.springframework.data.jpa.repository.JpaRepository;

public interface PluginDocumentRepository extends JpaRepository<PluginDocument, PluginDocumentId> {
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.registration;

import org.springframework.data.jpa.repository.JpaRepository;

public interface RegistrationDocumentRepository extends JpaRepository<RegistrationDocument, String> {
}

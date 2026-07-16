/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.auth;

import org.springframework.data.jpa.repository.JpaRepository;

public interface MailingListSubscriberRepository extends JpaRepository<MailingListSubscriber, String> {
}

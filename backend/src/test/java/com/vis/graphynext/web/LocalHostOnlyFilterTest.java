/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Host ヘッダの読み方（DNS リバインディング対策）。 */
class LocalHostOnlyFilterTest {

    @Test
    void localhost_の書き方だけを通す() {
        for (String ok : new String[]{"localhost", "localhost:8080", "127.0.0.1:18650", "[::1]", "[::1]:8080", "LocalHost:1"}) {
            assertTrue(LocalHostOnlyFilter.allowedHost(ok), ok);
        }
        for (String ng : new String[]{null, "", "evil.example", "evil.example:8080", "localhost.evil.example",
                "127.0.0.1.nip.io", "localhost:8080@evil", "[::1]evil", "127.0.0.2:8080", "localhost:abc"}) {
            assertFalse(LocalHostOnlyFilter.allowedHost(ng), String.valueOf(ng));
        }
    }
}

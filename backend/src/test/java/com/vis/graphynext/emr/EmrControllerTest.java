/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.emr;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

class EmrControllerTest {

    @Test
    void hintShowsOnlyTheEnds_neverTheWholeId() {
        assertEquals("12…78（8 文字）", EmrController.hint("12345678"));
        assertEquals("P…（4 文字）", EmrController.hint("P123")); // 短い ID は、先頭の 1 文字だけ
        String h = EmrController.hint("A1234567890123456789");
        assertFalse(h.contains("1234567890"));
        assertEquals("A1…89（20 文字）", h);
    }
}

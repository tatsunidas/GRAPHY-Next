/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.roi;

import java.time.Instant;

/** マスクの一覧 1 件（画素を含まない）。JPQL のコンストラクタ式で直接作る。 */
public record RoiMaskSummary(
        String maskUid,
        String seriesUid,
        String meta,
        int frameCount,
        int bytes,
        Long version,
        Instant updatedAt) {
}

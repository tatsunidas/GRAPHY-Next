/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.album;

import java.util.List;

/** アルバム API の要求・応答の本文。 */
public final class AlbumRequests {

    private AlbumRequests() {
    }

    public record NameRequest(String name) {
    }

    public record StudyUidsRequest(List<String> studyUids) {
    }

    /** 追加の結果。{@code alreadyIn} は既にアルバムに入っていて、増やさなかった件数。 */
    public record AddResult(int added, int alreadyIn) {
    }
}

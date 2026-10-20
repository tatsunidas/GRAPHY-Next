/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.share;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ShareRoutesTest {

    private static final String S = "1.2.840.1";
    private static final String X = "1.2.840.2";
    private static final String I = "1.2.840.3";

    @Test
    void allowedRoutesYieldTheStudyOrSop() {
        for (String p : new String[] {
                "/api/studies/" + S + "/series",
                "/api/studies/" + S + "/series/" + X + "/layout",
                "/api/studies/" + S + "/series/" + X + "/blank/file",
                "/api/studies/" + S + "/series/" + X + "/instances",
                "/api/studies/" + S + "/series/" + X + "/instances/" + I + "/file",
                "/api/studies/" + S + "/series/" + X + "/instances/" + I + "/frames/3/file"}) {
            var r = ShareRoutes.parse("GET", p).orElseThrow(() -> new AssertionError(p));
            assertThat(r.kind()).as(p).isEqualTo(ShareRoutes.Kind.STUDY);
            assertThat(r.studyUid()).as(p).isEqualTo(S);
        }
        var inst = ShareRoutes.parse("GET", "/api/instances/" + I + "/frames/2/file").orElseThrow();
        assertThat(inst.kind()).isEqualTo(ShareRoutes.Kind.INSTANCE);
        assertThat(inst.sopUid()).isEqualTo(I);
        assertThat(ShareRoutes.parse("GET", "/api/instances/" + I + "/file")).isPresent();
        assertThat(ShareRoutes.parse("GET", "/api/share/study").orElseThrow().kind())
                .isEqualTo(ShareRoutes.Kind.SHARE_INFO);
    }

    @Test
    void everythingElseIsRefused() {
        for (String p : new String[] {
                "/api/studies", "/api/settings", "/api/dicom/send", "/api/patients",
                "/api/studies/" + S, "/api/studies/" + S + "/series/",
                "/api/studies/" + S + "/series/" + X + "/instances/" + I + "/tags", // タグ表示は段 1 では許可しない
                "/api/studies/" + S + "/series/" + X + "/prefetch",
                "/api/studies/../settings/series", "/api/studies/" + S + "/../series",
                "/api/studies/%2e%2e/series", "/api/studies/" + S + "%2fx/series",
                "/api/studies//series", "/api/studies/" + S + "/series?x=1",
                "/api/studies/abc/series", "/api/instances/" + I, "/api/instances/" + I + "/file/",
                "", "/", "api/studies/" + S + "/series"}) {
            assertThat(ShareRoutes.parse("GET", p)).as(p).isEmpty();
        }
        assertThat(ShareRoutes.parse(null, "/api/share/study")).isEmpty();
        assertThat(ShareRoutes.parse("GET", null)).isEmpty();
    }

    @Test
    void onlyGetIsAllowed() {
        for (String m : new String[] {"POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "get"}) {
            assertThat(ShareRoutes.parse(m, "/api/studies/" + S + "/series")).as(m).isEmpty();
            assertThat(ShareRoutes.parse(m, "/api/share/study")).as(m).isEmpty();
        }
    }
}

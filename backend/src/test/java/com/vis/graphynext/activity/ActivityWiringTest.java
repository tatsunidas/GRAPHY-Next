/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.activity;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Path;

/** デスクトップ（standalone）の実アプリのコンテキストで、終了前の一覧が組み上がっていること（個々の Service の登録と、要求の数え上げの配線）。 */
@ActiveProfiles("standalone")
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:activitywire;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class ActivityWiringTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    List<ActiveWork> works;
    @Autowired
    ActivityService activity;
    @Autowired
    InFlightRequestFilter filter;

    @Test
    void everyJobServiceIsRegisteredWithItsOwnKind() {
        Set<String> kinds = works.stream().map(ActiveWork::kind).collect(Collectors.toSet());
        assertEquals(works.size(), kinds.size(), "kind が重複していない（二重に数えない）");
        for (String k : List.of("import", "urlImport", "export", "seriesExtract", "qrRetrieve", "plugin",
                "compute", "texture", "filteredSeries", "roiFeature")) {
            assertTrue(kinds.contains(k), k + " が登録されている: " + kinds);
        }
    }

    @Test
    void anIdleAppHasNothingToConfirm() {
        assertTrue(activity.snapshot().isEmpty(), "起動直後は何も走っていない: " + activity.snapshot());
    }

    @Test
    void aRequestInFlightThroughTheRealFilterShowsUpInTheSnapshot() throws Exception {
        List<ActivityService.Item> during = new ArrayList<>();
        MockFilterChain chain = new MockFilterChain() {
            @Override
            public void doFilter(jakarta.servlet.ServletRequest rq, jakarta.servlet.ServletResponse rs) {
                during.addAll(activity.snapshot());
            }
        };
        filter.doFilter(new MockHttpServletRequest("POST", "/api/dicom/send"), new MockHttpServletResponse(), chain);
        assertEquals(List.of(new ActivityService.Item("send", 1, false)), during, "処理の最中は一覧に出る");
        assertTrue(activity.snapshot().isEmpty(), "終わったら消える");
    }
}

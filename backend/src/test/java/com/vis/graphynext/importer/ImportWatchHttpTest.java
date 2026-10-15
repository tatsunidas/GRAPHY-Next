/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.file.Path;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 監視取り込みの状態と手動走査の HTTP（standalone）。 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:importwatchhttp;DB_CLOSE_DELAY=-1",
        "graphy.dicom.scp.enabled=false",
        "graphy.import-watch.auto-run=false"
})
@ActiveProfiles("standalone")
@AutoConfigureMockMvc
class ImportWatchHttpTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("db/dicom").toString());
    }

    @Autowired
    MockMvc mvc;

    @Test
    void 状態と手動走査が返る() throws Exception {
        mvc.perform(get("/api/import/watch/status")).andExpect(status().isOk())
                .andExpect(jsonPath("$.enabled").value(false))
                .andExpect(jsonPath("$.imported").value(0));
        mvc.perform(post("/api/import/watch/scan")).andExpect(status().isOk())
                .andExpect(jsonPath("$.enabled").value(false));
    }
}

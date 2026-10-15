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
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** web モード（standalone でない）では、監視取り込みの Bean も API も無い。設定 API から監視先を書かれても何も起きない。 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:importwatchweb;DB_CLOSE_DELAY=-1",
        "graphy.dicom.scp.enabled=false"
})
@AutoConfigureMockMvc
class ImportWatchWebProfileTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("db/dicom").toString());
    }

    @Autowired
    MockMvc mvc;
    @Autowired
    org.springframework.context.ApplicationContext ctx;

    @Test
    void bean_が無く_404() throws Exception {
        assertEquals(0, ctx.getBeanNamesForType(ImportWatchService.class).length);
        mvc.perform(get("/api/import/watch/status")).andExpect(status().isNotFound());
        mvc.perform(post("/api/import/watch/scan")).andExpect(status().isNotFound());
    }
}

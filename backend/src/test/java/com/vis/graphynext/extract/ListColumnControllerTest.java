/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.extract;

import com.vis.graphynext.extract.ListColumnService.Cell;
import com.vis.graphynext.extract.ListColumnService.State;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;
import java.util.Map;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 一覧の列の REST 入口: 正常系の形と、不正な入力の拒否（サービスを呼ばない）。 */
class ListColumnControllerTest {

    private final ListColumnService service = mock(ListColumnService.class);
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new ListColumnController(service)).build();

    private static final String OK_COLUMN = "{\"id\":\"c1\",\"segments\":[{\"tag\":\"00181030\",\"creator\":null}]}";

    @Test
    void studiesReturnsCellsKeyedByStudyAndColumn() throws Exception {
        when(service.studyCells(any(), any())).thenReturn(
                Map.of("ST1", Map.of("c1", new Cell(List.of("A", "B"), State.OK, false))));
        mvc.perform(post("/api/studies/columns").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"studyUids\":[\"ST1\"],\"columns\":[" + OK_COLUMN + "]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ST1.c1.values[0]").value("A"))
                .andExpect(jsonPath("$.ST1.c1.values[1]").value("B"))
                .andExpect(jsonPath("$.ST1.c1.state").value("OK"))
                .andExpect(jsonPath("$.ST1.c1.incomplete").value(false));
    }

    @Test
    void seriesReturnsCellsKeyedBySeries() throws Exception {
        when(service.seriesCells(any(), any())).thenReturn(
                Map.of("SE1", Map.of("c1", new Cell(List.of(), State.NOT_LOCAL, false))));
        mvc.perform(post("/api/studies/ST1/series/columns").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"columns\":[" + OK_COLUMN + "]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.SE1.c1.state").value("NOT_LOCAL"));
    }

    @Test
    void invalidRequestsAreRejectedWithoutCallingTheService() throws Exception {
        String noSegments = "{\"id\":\"c1\",\"segments\":[]}";
        String noId = "{\"id\":\"\",\"segments\":[{\"tag\":\"00181030\"}]}";
        for (String body : List.of(
                "{\"studyUids\":[\"ST1\"],\"columns\":[" + noSegments + "]}",
                "{\"studyUids\":[\"ST1\"],\"columns\":[" + noId + "]}",
                "{\"studyUids\":[\"ST1\"]}",
                "{\"columns\":[" + OK_COLUMN + "]}")) {
            mvc.perform(post("/api/studies/columns").contentType(MediaType.APPLICATION_JSON).content(body))
                    .andExpect(status().isBadRequest());
        }
        String tooMany = "[" + String.join(",", java.util.Collections.nCopies(ListColumnController.MAX_STUDIES + 1, "\"S\"")) + "]";
        mvc.perform(post("/api/studies/columns").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"studyUids\":" + tooMany + ",\"columns\":[" + OK_COLUMN + "]}"))
                .andExpect(status().isBadRequest());
        verify(service, never()).studyCells(any(), any());
    }
}

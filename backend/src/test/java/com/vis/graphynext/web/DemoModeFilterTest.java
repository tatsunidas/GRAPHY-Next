/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import jakarta.servlet.FilterChain;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

class DemoModeFilterTest {

    private final DemoModeFilter filter = new DemoModeFilter();

    @ParameterizedTest
    @CsvSource({
            "POST,/api/import/paths",
            "POST,/api/import/nondicom",
            "POST,/api/dicom/send",
            "POST,/api/dicom/qr/find",
            "GET,/api/dicom/qr/retrieve/job1",
            "POST,/api/dicom/rtstruct",
            "POST,/api/series/derived",
            "DELETE,/api/series/1.2/1.3",
            "POST,/api/dbadmin/series/merge",
            "GET,/api/patients",
            "DELETE,/api/patients/42",
            "DELETE,/api/studies/1.2",
            "PUT,/api/studies/1.2/patient",
            "DELETE,/api/instances/1.2/1.3/1.4",
            "GET,/api/stats",
            "GET,/api/system/logs",
            "POST,/api/imagej/bridge",
            "POST,/api/plugins/foo/run",
            "POST,/api/export/zip",
            "POST,/api/series-extract/verify",
            "POST,/api/series-extract/copy",
            "POST,/api/series-extract/zip",
            "POST,/api/anonymizer/zip",
            "POST,/api/anonymizer/copy",
            "POST,/api/anonymizer/masks",
            "DELETE,/api/anonymizer/masks",
            "POST,/api/dicom/echo",
            "POST,/api/dicom/tls-config",
            "PUT,/api/settings",
    })
    void blocksRiskyRoutes(String method, String path) throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest(method, path);
        req.setServletPath(path);
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        assertThat(res.getStatus()).isEqualTo(403);
        verifyNoInteractions(chain);
    }

    @ParameterizedTest
    @CsvSource({
            "GET,/api/studies",
            "GET,/api/studies/1.2/series",
            "GET,/api/studies/1.2/series/1.3/instances",
            "GET,/api/studies/1.2/series/1.3/instances/1.4/file",
            "POST,/api/studies/1.2/series/1.3/prefetch",
            "GET,/api/dicom/rtstruct",
            // 毎晩の自動リストアで消えるため、デモ体験として意図的に許可（RTSTRUCT書き出しは対象外）。
            "POST,/api/dicom/seg",
            "GET,/api/instances/1.4/document",
            "GET,/api/plugins/foo/ui.js",
            "GET,/api/status",
            "GET,/api/anonymizer/profiles",
            "GET,/api/anonymizer/masks",
            "GET,/api/settings",
            "GET,/api/dicom/tls-config",
            "GET,/api/reports",
            "POST,/api/reports",
            "PUT,/api/reports/1",
            "DELETE,/api/reports/1",
            "POST,/api/reports/1/finalize",
    })
    void allowsViewingRoutes(String method, String path) throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest(method, path);
        req.setServletPath(path);
        MockHttpServletResponse res = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(req, res, chain);

        verify(chain).doFilter(req, res);
    }
}

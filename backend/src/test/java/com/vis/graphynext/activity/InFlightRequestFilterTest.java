/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.activity;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;

import jakarta.servlet.ServletException;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class InFlightRequestFilterTest {

    @Test
    void mutatingRequestsOnTrackedRoutesAreClassified() {
        assertEquals("send", InFlightRequestFilter.kindOf("POST", "/api/dicom/send"));
        assertEquals("qrGetMove", InFlightRequestFilter.kindOf("POST", "/api/dicom/qr/move"));
        assertEquals("qrGetMove", InFlightRequestFilter.kindOf("POST", "/api/dicom/qr/get"));
        assertEquals("dbTransfer", InFlightRequestFilter.kindOf("POST", "/api/db-transfer"));
        assertEquals("dbEdit", InFlightRequestFilter.kindOf("DELETE", "/api/studies/1.2.3"));
        assertEquals("dbEdit", InFlightRequestFilter.kindOf("PUT", "/api/patients/P1"));
        assertEquals("dbEdit", InFlightRequestFilter.kindOf("POST", "/api/dbadmin/series/merge"));
        assertEquals("reportSave", InFlightRequestFilter.kindOf("PUT", "/api/reports/7"));
    }

    @Test
    void longSynchronousOperationsAreClassified() {
        // standalone の匿名化は web 用のジョブ Service を通らず、この同期の要求で走る
        assertEquals("anonymizeRun", InFlightRequestFilter.kindOf("POST", "/api/anonymizer/zip"));
        assertEquals("anonymizeRun", InFlightRequestFilter.kindOf("POST", "/api/anonymizer/copy"));
        assertEquals("exportRun", InFlightRequestFilter.kindOf("POST", "/api/export/zip"));
        assertEquals("seriesExtractRun", InFlightRequestFilter.kindOf("POST", "/api/series-extract/copy"));
        assertEquals("importRun", InFlightRequestFilter.kindOf("POST", "/api/import/paths"));
        assertEquals("importRun", InFlightRequestFilter.kindOf("POST", "/api/nifti/import"));
        assertEquals("prefetchRun", InFlightRequestFilter.kindOf("POST", "/api/prefetch/run"));
        assertEquals("prefetchRun", InFlightRequestFilter.kindOf("POST", "/api/studies/1.2/series/3.4/prefetch"));
        assertEquals("analysisRun", InFlightRequestFilter.kindOf("POST", "/api/series/texture"));
        assertNull(InFlightRequestFilter.kindOf("POST", "/api/import/paths/jobs"), "ジョブの投入はすぐ返る");
        assertNull(InFlightRequestFilter.kindOf("POST", "/api/import/paths/jobs/abc/cancel"), "中止もすぐ返る");
        assertNull(InFlightRequestFilter.kindOf("POST", "/api/series/texture/jobs"), "ジョブの投入はすぐ返る");
        assertNull(InFlightRequestFilter.kindOf("DELETE", "/api/series/texture/jobs/abc"), "ジョブの中止は DB の編集ではない");
        assertNull(InFlightRequestFilter.kindOf("POST", "/api/studies/columns"), "列の取得は編集ではない");
        assertEquals("dbEdit", InFlightRequestFilter.kindOf("DELETE", "/api/series/1.2.3/4.5.6"));
        assertEquals("dbEdit", InFlightRequestFilter.kindOf("PUT", "/api/studies/1.2.3/patient"));
    }

    @Test
    void readsAndUntrackedRoutesAreNotCounted() {
        assertNull(InFlightRequestFilter.kindOf("GET", "/api/studies"), "GET は数えない");
        assertNull(InFlightRequestFilter.kindOf("OPTIONS", "/api/dicom/send"));
        assertNull(InFlightRequestFilter.kindOf("POST", "/api/dicom/echo"), "すぐ返る要求は数えない");
        assertNull(InFlightRequestFilter.kindOf("POST", "/api/internal/activity"), "終了の口自身を数えない");
        assertNull(InFlightRequestFilter.kindOf("POST", "/api/export/jobs"), "ジョブはそれぞれの Service が持つ");
    }

    @Test
    void countsWhileTheRequestIsRunningAndReleasesWhenItEnds() throws Exception {
        InFlightRequests inFlight = new InFlightRequests();
        InFlightRequestFilter f = new InFlightRequestFilter(inFlight);
        Map<String, Integer>[] during = new Map[1];
        MockFilterChain chain = new MockFilterChain() {
            @Override
            public void doFilter(jakarta.servlet.ServletRequest rq, jakarta.servlet.ServletResponse rs) {
                during[0] = inFlight.snapshot();
            }
        };
        f.doFilter(new MockHttpServletRequest("POST", "/api/dicom/send"), new MockHttpServletResponse(), chain);
        assertEquals(Map.of("send", 1), during[0], "処理の最中は数えている");
        assertTrue(inFlight.snapshot().isEmpty(), "終わったら戻る");
    }

    @Test
    void releasesEvenWhenTheRequestFails() {
        InFlightRequests inFlight = new InFlightRequests();
        InFlightRequestFilter f = new InFlightRequestFilter(inFlight);
        MockFilterChain boom = new MockFilterChain() {
            @Override
            public void doFilter(jakarta.servlet.ServletRequest rq, jakarta.servlet.ServletResponse rs) throws ServletException {
                throw new ServletException("fail");
            }
        };
        assertThrows(ServletException.class,
                () -> f.doFilter(new MockHttpServletRequest("PUT", "/api/reports/1"), new MockHttpServletResponse(), boom));
        assertTrue(inFlight.snapshot().isEmpty(), "例外で終わっても数えたままにしない（終了が永久に待たされる）");
    }
}

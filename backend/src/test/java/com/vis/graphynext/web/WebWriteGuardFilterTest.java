/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import com.vis.graphynext.config.CorsProperties;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class WebWriteGuardFilterTest {

    private static int status(WebWriteGuardFilter f, String method, String path, String header, String origin,
            String host) throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest(method, path);
        req.setServletPath(path);
        if (header != null) {
            req.addHeader(WebWriteGuardFilter.HEADER, header);
        }
        if (origin != null) {
            req.addHeader("Origin", origin);
        }
        if (host != null) {
            req.addHeader("Host", host);
        }
        MockHttpServletResponse res = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        f.doFilter(req, res, chain);
        return chain.getRequest() == null ? res.getStatus() : 200;
    }

    private static WebWriteGuardFilter filter(String... allowedOrigins) {
        CorsProperties c = new CorsProperties();
        c.setAllowedOriginPatterns(List.of(allowedOrigins));
        return new WebWriteGuardFilter(c);
    }

    @Test
    void guarded_requests_need_the_custom_header() throws Exception {
        WebWriteGuardFilter f = filter();
        assertEquals(403, status(f, "POST", "/api/anonymizer/jobs", null, null, "pacs.example:8080"));
        assertEquals(403, status(f, "DELETE", "/api/anonymizer/jobs/abc", null, null, "pacs.example:8080"));
        assertEquals(200, status(f, "POST", "/api/anonymizer/jobs", "1", null, "pacs.example:8080"));
        assertEquals(200, status(f, "DELETE", "/api/anonymizer/jobs/abc", "1", null, "pacs.example:8080"));
    }

    @Test
    void a_foreign_origin_is_refused_even_with_the_header() throws Exception {
        WebWriteGuardFilter f = filter("http://localhost:*");
        assertEquals(403, status(f, "POST", "/api/anonymizer/jobs", "1", "https://evil.example", "pacs.example:8080"));
        assertEquals(200, status(f, "POST", "/api/anonymizer/jobs", "1", "http://pacs.example:8080", "pacs.example:8080"),
                "同じオリジンは通る");
        assertEquals(200, status(f, "POST", "/api/anonymizer/jobs", "1", "http://localhost:5173", "pacs.example:8080"),
                "許可済みの CORS オリジンは通る");
    }

    @Test
    void reads_and_other_paths_are_not_guarded() throws Exception {
        WebWriteGuardFilter f = filter();
        assertEquals(200, status(f, "GET", "/api/anonymizer/jobs/abc/zip", null, null, "pacs.example:8080"));
        assertEquals(200, status(f, "GET", "/api/anonymizer/jobs/abc", null, null, "pacs.example:8080"));
        assertEquals(200, status(f, "POST", "/api/anonymizer/profiles", null, null, "pacs.example:8080"));
    }
}

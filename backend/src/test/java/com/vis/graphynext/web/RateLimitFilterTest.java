/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import com.vis.graphynext.config.RateLimitProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

class RateLimitFilterTest {

    private RateLimitFilter filterWithLimit(int requestsPerMinute) {
        RateLimitProperties properties = new RateLimitProperties();
        properties.setEnabled(true);
        properties.setRequestsPerMinute(requestsPerMinute);
        return new RateLimitFilter(properties);
    }

    @Test
    void allowsRequestsWithinLimit() throws Exception {
        RateLimitFilter filter = filterWithLimit(3);
        FilterChain chain = mock(FilterChain.class);

        for (int i = 0; i < 3; i++) {
            MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/studies");
            req.addHeader("CF-Connecting-IP", "203.0.113.10");
            MockHttpServletResponse res = new MockHttpServletResponse();
            filter.doFilter(req, res, chain);
        }
        verify(chain, times(3)).doFilter(any(ServletRequest.class), any(ServletResponse.class));
    }

    @Test
    void blocksRequestsOverLimit() throws Exception {
        RateLimitFilter filter = filterWithLimit(2);
        FilterChain chain = mock(FilterChain.class);

        for (int i = 0; i < 2; i++) {
            MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/studies");
            req.addHeader("CF-Connecting-IP", "203.0.113.20");
            MockHttpServletResponse res = new MockHttpServletResponse();
            filter.doFilter(req, res, chain);
        }

        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/studies");
        req.addHeader("CF-Connecting-IP", "203.0.113.20");
        MockHttpServletResponse res = new MockHttpServletResponse();
        filter.doFilter(req, res, chain);

        assertThat(res.getStatus()).isEqualTo(429);
        assertThat(res.getHeader("Retry-After")).isEqualTo("60");
        verify(chain, times(2)).doFilter(any(ServletRequest.class), any(ServletResponse.class));
    }

    @Test
    void tracksLimitsPerIpIndependently() throws Exception {
        RateLimitFilter filter = filterWithLimit(1);
        FilterChain chain = mock(FilterChain.class);

        MockHttpServletRequest req1 = new MockHttpServletRequest("GET", "/api/studies");
        req1.addHeader("CF-Connecting-IP", "203.0.113.30");
        MockHttpServletResponse res1 = new MockHttpServletResponse();
        filter.doFilter(req1, res1, chain);

        MockHttpServletRequest req2 = new MockHttpServletRequest("GET", "/api/studies");
        req2.addHeader("CF-Connecting-IP", "203.0.113.31");
        MockHttpServletResponse res2 = new MockHttpServletResponse();
        filter.doFilter(req2, res2, chain);

        verify(chain, times(2)).doFilter(any(ServletRequest.class), any(ServletResponse.class));
    }

    @Test
    void fallsBackToRemoteAddrWhenNoCloudflareHeader() throws Exception {
        RateLimitFilter filter = filterWithLimit(1);
        FilterChain chain = mock(FilterChain.class);

        MockHttpServletRequest req1 = new MockHttpServletRequest("GET", "/api/studies");
        req1.setRemoteAddr("192.0.2.5");
        MockHttpServletResponse res1 = new MockHttpServletResponse();
        filter.doFilter(req1, res1, chain);

        MockHttpServletRequest req2 = new MockHttpServletRequest("GET", "/api/studies");
        req2.setRemoteAddr("192.0.2.5");
        MockHttpServletResponse res2 = new MockHttpServletResponse();
        filter.doFilter(req2, res2, chain);

        assertThat(res2.getStatus()).isEqualTo(429);
        verify(chain, times(1)).doFilter(any(ServletRequest.class), any(ServletResponse.class));
    }
}

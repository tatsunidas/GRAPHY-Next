/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** main だけが通れること。破れるとレンダラ（＝プラグイン）がトークンを差し替えられる。 */
class MainChannelFilterTest {

    private static final String SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

    private static MockHttpServletRequest req(String uri) {
        MockHttpServletRequest r = new MockHttpServletRequest("PUT", uri);
        r.setRemoteAddr("127.0.0.1");
        r.addHeader("Authorization", "Bearer " + SECRET);
        return r;
    }

    /** 通れば chain に届く（届いた要求が chain に残る）。 */
    private static boolean passes(MainChannelFilter f, MockHttpServletRequest r) throws Exception {
        MockHttpServletResponse res = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        f.doFilter(r, res, chain);
        if (chain.getRequest() == null) {
            assertEquals(404, res.getStatus(), "口の存在を教えない");
            return false;
        }
        return true;
    }

    @Test
    void mainWithSecretFromLoopbackPasses() throws Exception {
        assertTrue(passes(new MainChannelFilter(SECRET), req("/api/internal/compute/endpoints")));
        MockHttpServletRequest v6 = req("/api/internal/compute/endpoints");
        v6.setRemoteAddr("0:0:0:0:0:0:0:1");
        assertTrue(passes(new MainChannelFilter(SECRET), v6));
    }

    @Test
    void wrongOrMissingSecretIsRejected() throws Exception {
        MainChannelFilter f = new MainChannelFilter(SECRET);
        MockHttpServletRequest wrong = new MockHttpServletRequest("PUT", "/api/internal/compute/endpoints");
        wrong.setRemoteAddr("127.0.0.1");
        wrong.addHeader("Authorization", "Bearer " + SECRET.replace('0', '1'));
        assertFalse(passes(f, wrong));
        MockHttpServletRequest none = new MockHttpServletRequest("PUT", "/api/internal/compute/endpoints");
        none.setRemoteAddr("127.0.0.1");
        assertFalse(passes(f, none));
    }

    @Test
    void requestsWithOriginAreRejected() throws Exception {
        // ブラウザ・レンダラからの要求は Origin を付けうる。main の Node は付けない
        MockHttpServletRequest r = req("/api/internal/compute/endpoints");
        r.addHeader("Origin", "file://");
        assertFalse(passes(new MainChannelFilter(SECRET), r));
    }

    @Test
    void remoteAddressesAreRejected() throws Exception {
        MockHttpServletRequest r = req("/api/internal/compute/endpoints");
        r.setRemoteAddr("192.168.1.5");
        assertFalse(passes(new MainChannelFilter(SECRET), r));
    }

    @Test
    void withoutSecretTheChannelDoesNotExist() throws Exception {
        // web モード・main を通さずに起動した backend
        MainChannelFilter none = new MainChannelFilter("");
        assertFalse(none.enabled());
        assertFalse(passes(none, req("/api/internal/compute/endpoints")));
        // 短すぎる secret も無いのと同じ
        assertFalse(new MainChannelFilter("short").enabled());
    }

    @Test
    void otherPathsAreUntouched() throws Exception {
        MockHttpServletRequest r = new MockHttpServletRequest("GET", "/api/settings");
        MockFilterChain chain = new MockFilterChain();
        new MainChannelFilter("").doFilter(r, new MockHttpServletResponse(), chain);
        assertNotNull(chain.getRequest());
        MockHttpServletRequest near = new MockHttpServletRequest("GET", "/api/internalx");
        MockFilterChain c2 = new MockFilterChain();
        new MainChannelFilter("").doFilter(near, new MockHttpServletResponse(), c2);
        assertNotNull(c2.getRequest());
    }
}

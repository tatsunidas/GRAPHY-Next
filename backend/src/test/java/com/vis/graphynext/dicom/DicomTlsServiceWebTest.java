/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.compute.MainChannelFilter;
import com.vis.graphynext.settings.SettingsService;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** main の口が無いとき（web・main を通さない起動）: パスワードは REST で保存し、null は保つ・空は消す。 */
class DicomTlsServiceWebTest {

    private final Map<String, String> store = new HashMap<>();

    private DicomTlsService service() {
        SettingsService s = mock(SettingsService.class);
        when(s.getAll()).thenAnswer(i -> new HashMap<>(store));
        when(s.putAll(anyMap())).thenAnswer(i -> {
            store.putAll(i.getArgument(0));
            return new HashMap<>(store);
        });
        return new DicomTlsService(new DicomProperties(), s, new ObjectMapper(), new DicomTlsSecrets(null, null),
                new MainChannelFilter(""));
    }

    private static DicomTlsService.TlsConfigDto dto(String ks, String ts) {
        return new DicomTlsService.TlsConfigDto(true, 2762, "/k.p12", ks, "PKCS12", "/t.p12", ts, "PKCS12",
                null, null, true, false, false, false);
    }

    @Test
    void null_は保ち_空は消し_値は入れる_返すときは伏せる() throws Exception {
        DicomTlsService svc = service();
        var out = svc.save(dto("ks1", "ts1"));
        assertNull(out.keyStorePassword());
        assertTrue(out.keyStorePasswordSet() && out.trustStorePasswordSet());

        svc.save(dto(null, ""));
        assertEquals("ks1", svc.effective().getKeyStorePassword());
        assertEquals("", svc.effective().getTrustStorePassword());
        assertFalse(svc.get().trustStorePasswordSet());
    }

    @Test
    void redact_はパスワードを除き_読めない値は丸ごと隠す() {
        DicomTlsService svc = service();
        String r = svc.redact("{\"keyStore\":\"/k\",\"keyStorePassword\":\"pw\",\"trustStorePassword\":\"\"}");
        assertFalse(r.contains("\"pw\""), r);
        assertTrue(r.contains("\"keyStorePasswordSet\":true") && r.contains("\"trustStorePasswordSet\":false"), r);
        assertTrue(r.contains("/k"));
        assertNull(svc.redact("not json pw"));
    }
}

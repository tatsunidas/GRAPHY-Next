/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.anonymize.ReceiveAnonymizer;
import com.vis.graphynext.settings.SettingsService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import java.nio.file.Path;
import java.util.Base64;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.mockito.Mockito.mock;

/** 鍵の書き出し: main が読める JSON（base64）で、鍵そのもの（32 バイト）を返し、キャッシュさせない。 */
class ReceiveAnonymizeInternalControllerTest {

    @TempDir
    Path tmp;

    @Test
    void keyIsReturnedAsBase64JsonAndMatchesTheKeyFile() throws Exception {
        Path keyFile = tmp.resolve("receive-anon.key");
        ReceiveAnonymizer anonymizer = new ReceiveAnonymizer(mock(SettingsService.class), keyFile.toString());
        ResponseEntity<Map<String, String>> r = new ReceiveAnonymizeInternalController(anonymizer).key();

        assertEquals(MediaType.APPLICATION_JSON, r.getHeaders().getContentType());
        assertEquals("no-store", r.getHeaders().getCacheControl());
        byte[] key = Base64.getDecoder().decode(r.getBody().get("key"));
        assertEquals(32, key.length);
        // 2 回目も同じ鍵（作り直さない）
        byte[] again = Base64.getDecoder().decode(
                new ReceiveAnonymizeInternalController(anonymizer).key().getBody().get("key"));
        assertArrayEquals(key, again);
        // 別の鍵ファイルなら別の鍵（定数を返していないこと）
        ReceiveAnonymizer other = new ReceiveAnonymizer(mock(SettingsService.class), tmp.resolve("other.key").toString());
        byte[] otherKey = Base64.getDecoder().decode(
                new ReceiveAnonymizeInternalController(other).key().getBody().get("key"));
        assertNotEquals(Base64.getEncoder().encodeToString(key), Base64.getEncoder().encodeToString(otherKey));
    }
}

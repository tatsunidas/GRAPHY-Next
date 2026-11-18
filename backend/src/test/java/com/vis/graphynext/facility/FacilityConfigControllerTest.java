/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.facility;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Clock;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/** API: 未設定は 204、内容は検証済みの構造だけ、ETag で 304。 */
class FacilityConfigControllerTest {

    @TempDir
    Path tmp;

    @Test
    void 未設定は204_設定済みは200と内容_同じETagなら304() throws IOException {
        Path f = tmp.resolve("c.json");
        java.util.HashMap<String, String> settings = new java.util.HashMap<>();
        FacilityConfigWatchService watch = new FacilityConfigWatchService(() -> settings, Clock.systemUTC(), "", true, false);
        FacilityConfigController api = new FacilityConfigController(watch);

        watch.tick();
        assertEquals(HttpStatus.NO_CONTENT, api.config(null).getStatusCode());

        Files.writeString(f, "{\"schemaVersion\":1,\"groups\":[{\"id\":\"g\",\"title\":\"G\"}]}");
        Files.setLastModifiedTime(f, FileTime.fromMillis(5_000));
        settings.put(FacilityConfigWatchService.KEY_PATH, f.toString());
        watch.tick();
        watch.tick();

        ResponseEntity<FacilityConfigController.ConfigDto> r = api.config(null);
        assertEquals(HttpStatus.OK, r.getStatusCode());
        assertEquals("ok", r.getBody().state());
        assertEquals("G", r.getBody().config().groups().get(0).title());
        assertEquals("setting", r.getBody().source());
        String etag = r.getHeaders().getETag();
        assertNotNull(etag);

        ResponseEntity<FacilityConfigController.ConfigDto> again = api.config(etag);
        assertEquals(HttpStatus.NOT_MODIFIED, again.getStatusCode());
        assertNull(again.getBody());

        // 内容が変わると ETag も変わり、200 に戻る
        Files.writeString(f, "{\"schemaVersion\":1,\"groups\":[{\"id\":\"g\",\"title\":\"H\"}]}");
        Files.setLastModifiedTime(f, FileTime.fromMillis(10_000));
        watch.tick();
        watch.tick();
        ResponseEntity<FacilityConfigController.ConfigDto> changed = api.config(etag);
        assertEquals(HttpStatus.OK, changed.getStatusCode());
        assertEquals("H", changed.getBody().config().groups().get(0).title());
    }

    @Test
    void 壊れた設定では_状態に理由が出て_直前の内容を返す() throws IOException {
        Path f = tmp.resolve("c.json");
        FacilityConfigWatchService watch = new FacilityConfigWatchService(() -> Map.of(FacilityConfigWatchService.KEY_PATH, f.toString()), Clock.systemUTC(), "", true, false);
        FacilityConfigController api = new FacilityConfigController(watch);
        Files.writeString(f, "{\"schemaVersion\":1,\"groups\":[{\"id\":\"g\",\"title\":\"G\"}]}");
        Files.setLastModifiedTime(f, FileTime.fromMillis(5_000));
        watch.tick();
        watch.tick();
        Files.writeString(f, "{ broken");
        Files.setLastModifiedTime(f, FileTime.fromMillis(9_000));
        watch.tick();
        watch.tick();
        FacilityConfigController.ConfigDto d = api.config(null).getBody();
        assertEquals("error", d.state());
        assertEquals("parse", d.error());
        assertEquals("G", d.config().groups().get(0).title());
    }
}

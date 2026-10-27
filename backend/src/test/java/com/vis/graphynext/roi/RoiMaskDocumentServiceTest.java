/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.roi;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 塗り ROI（マスク）の永続化。主眼は {@link RoiDocumentServiceTest} と同じく**上書き事故を構造で防げているか**と、
 * **一覧が画素を読まない**こと（患者のマスクが増えても一覧が重くならない）。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:roimask;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class RoiMaskDocumentServiceTest {

    @Autowired
    RoiMaskDocumentService service;

    private static final String META = "{\"label\":\"ROI 1\",\"segments\":[1]}";

    private static byte[] bytes(int n, int seed) {
        byte[] b = new byte[n];
        for (int i = 0; i < n; i++) {
            b[i] = (byte) (i * 31 + seed);
        }
        return b;
    }

    private static HttpStatus statusOf(ResponseStatusException e) {
        return HttpStatus.valueOf(e.getStatusCode().value());
    }

    @Test
    void saveThenListAndFrames_roundTripsBinaryVerbatim() {
        byte[] frames = bytes(1000, 7);
        RoiMaskSummary saved = service.save("m-1", "PAT-A", "1.2.3", META, frames, 4, null);
        assertTrue(saved.version() != null);
        assertEquals(1000, saved.bytes());

        List<RoiMaskSummary> list = service.list("PAT-A");
        assertEquals(1, list.size());
        assertEquals("m-1", list.get(0).maskUid());
        assertEquals("1.2.3", list.get(0).seriesUid());
        assertEquals(META, list.get(0).meta());
        assertEquals(4, list.get(0).frameCount());
        assertEquals(1000, list.get(0).bytes());
        assertEquals(saved.version(), list.get(0).version());
        // backend は中身を解釈しない＝入れたバイトがそのまま返る。
        assertArrayEquals(frames, service.frames("m-1"));
    }

    @Test
    void list_isPerPatient() {
        service.save("m-p1", "PAT-X", "s1", META, bytes(10, 1), 1, null);
        service.save("m-p2", "PAT-Y", "s1", META, bytes(10, 2), 1, null);
        assertEquals(List.of("m-p1"), service.list("PAT-X").stream().map(RoiMaskSummary::maskUid).toList());
        assertTrue(service.list("PAT-NONE").isEmpty());
    }

    @Test
    void save_withCorrectVersion_updatesAndBumpsVersion() {
        RoiMaskSummary v0 = service.save("m-2", "PAT-B", "s1", META, bytes(10, 1), 1, null);
        RoiMaskSummary v1 = service.save("m-2", "PAT-B", "s1", META, bytes(20, 2), 2, v0.version());
        assertNotEquals(v0.version(), v1.version());
        assertEquals(20, v1.bytes());
        assertArrayEquals(bytes(20, 2), service.frames("m-2"));
    }

    @Test
    void save_withStaleVersion_conflictsAndKeepsNewerContent() {
        RoiMaskSummary v0 = service.save("m-3", "PAT-C", "s1", META, bytes(10, 1), 1, null);
        service.save("m-3", "PAT-C", "s1", META, bytes(30, 3), 3, v0.version());
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("m-3", "PAT-C", "s1", META, bytes(5, 9), 1, v0.version()));
        assertEquals(HttpStatus.CONFLICT, statusOf(e));
        assertArrayEquals(bytes(30, 3), service.frames("m-3"));
    }

    @Test
    void save_withoutVersion_whenAlreadyExists_conflicts() {
        service.save("m-4", "PAT-D", "s1", META, bytes(10, 1), 1, null);
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("m-4", "PAT-D", "s1", META, bytes(10, 2), 1, null));
        assertEquals(HttpStatus.CONFLICT, statusOf(e));
        assertArrayEquals(bytes(10, 1), service.frames("m-4"));
    }

    @Test
    void save_withVersion_whenDeleted_conflictsInsteadOfRecreating() {
        RoiMaskSummary v0 = service.save("m-5", "PAT-E", "s1", META, bytes(10, 1), 1, null);
        service.delete("m-5", "PAT-E");
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("m-5", "PAT-E", "s1", META, bytes(10, 1), 1, v0.version()));
        assertEquals(HttpStatus.CONFLICT, statusOf(e));
        assertTrue(service.list("PAT-E").isEmpty());
    }

    @Test
    void save_rejectsOtherPatientsMaskUid() {
        service.save("m-6", "PAT-F", "s1", META, bytes(10, 1), 1, null);
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("m-6", "PAT-OTHER", "s1", META, bytes(10, 2), 1, 1L));
        assertEquals(HttpStatus.BAD_REQUEST, statusOf(e));
        assertArrayEquals(bytes(10, 1), service.frames("m-6"));
    }

    @Test
    void delete_isIdempotentAndPatientChecked() {
        service.save("m-7", "PAT-G", "s1", META, bytes(10, 1), 1, null);
        // 別患者の鍵では消せない（消えていないこと）。
        assertThrows(ResponseStatusException.class, () -> service.delete("m-7", "PAT-OTHER"));
        assertEquals(1, service.list("PAT-G").size());
        service.delete("m-7", "PAT-G");
        assertTrue(service.list("PAT-G").isEmpty());
        service.delete("m-7", "PAT-G"); // 2 回目も成功（冪等）
    }

    @Test
    void frames_whenMissing_is404() {
        ResponseStatusException e = assertThrows(ResponseStatusException.class, () -> service.frames("no-such"));
        assertEquals(HttpStatus.NOT_FOUND, statusOf(e));
    }

    @Test
    void save_rejectsBadInputs() {
        assertEquals(HttpStatus.BAD_REQUEST, statusOf(assertThrows(ResponseStatusException.class,
                () -> service.save("m-8", "PAT-H", "s1", META, new byte[0], 1, null))));
        assertEquals(HttpStatus.BAD_REQUEST, statusOf(assertThrows(ResponseStatusException.class,
                () -> service.save("m-8", "PAT-H", "s1", "not json", bytes(5, 1), 1, null))));
        assertEquals(HttpStatus.BAD_REQUEST, statusOf(assertThrows(ResponseStatusException.class,
                () -> service.save("m-8", "PAT-H", "s1", "[1]", bytes(5, 1), 1, null))));
        assertEquals(HttpStatus.BAD_REQUEST, statusOf(assertThrows(ResponseStatusException.class,
                () -> service.save("m-8", "PAT-H", "s1", META, bytes(5, 1), 0, null))));
        assertEquals(HttpStatus.BAD_REQUEST, statusOf(assertThrows(ResponseStatusException.class,
                () -> service.save("m-8", " ", "s1", META, bytes(5, 1), 1, null))));
        assertEquals(HttpStatus.BAD_REQUEST, statusOf(assertThrows(ResponseStatusException.class,
                () -> service.save("m-8", "PAT-H", "", META, bytes(5, 1), 1, null))));
        // どれも保存されていない。
        assertFalse(service.list("PAT-H").stream().anyMatch(s -> s.maskUid().equals("m-8")));
    }

    @Test
    void save_rejectsOversizedFrames() {
        byte[] big = new byte[RoiMaskDocumentService.MAX_FRAMES_BYTES + 1];
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("m-9", "PAT-I", "s1", META, big, 1, null));
        assertEquals(HttpStatus.PAYLOAD_TOO_LARGE, statusOf(e));
        assertTrue(service.list("PAT-I").isEmpty());
    }
}

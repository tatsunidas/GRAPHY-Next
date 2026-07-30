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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ROI（幾何注釈）永続化を検証する（`fw/roi-manager-design.md` M5）。
 *
 * <p>ここでの主眼は**上書き事故を構造で防げているか**。RECIST のような数か月〜数年の計測を
 * 別ウィンドウの保存が黙って消すと取り返しがつかないため、版チェックの経路を重点的に見る。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:roidoc;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class RoiDocumentServiceTest {

    @Autowired
    RoiDocumentService service;

    @Autowired
    RoiDocumentRepository repo;

    private static String json(int n) {
        StringBuilder sb = new StringBuilder("{\"schema\":1,\"rois\":[");
        for (int i = 0; i < n; i++) {
            if (i > 0) {
                sb.append(",");
            }
            sb.append("{\"roiUid\":\"uid-").append(i).append("\",\"tool\":\"Bidirectional\"}");
        }
        return sb.append("]}").toString();
    }

    private static HttpStatus statusOf(ResponseStatusException e) {
        return HttpStatus.valueOf(e.getStatusCode().value());
    }

    @Test
    void get_whenNothingSaved_returnsEmptyEnvelopeNotError() {
        // 「まだ無い」は正常。フロントに 404 の分岐を書かせない。
        RoiDocumentDto dto = service.get("PAT-EMPTY");
        assertEquals("PAT-EMPTY", dto.patientKey());
        assertNull(dto.json());
        assertEquals(0, dto.roiCount());
        assertNull(dto.version());
        assertNull(dto.updatedAt());
    }

    @Test
    void saveThenGet_roundTripsJsonVerbatim() {
        String body = json(3);
        RoiDocumentDto saved = service.save("PAT-1", new SaveRoiDocumentRequest(body, 3, null));
        assertEquals(3, saved.roiCount());
        assertTrue(saved.version() != null);

        RoiDocumentDto read = service.get("PAT-1");
        // backend は中身を解釈しない＝入れたものがそのまま返る（スキーマの正本はフロント）。
        assertEquals(body, read.json());
        assertEquals(3, read.roiCount());
        assertEquals(saved.version(), read.version());
        assertTrue(read.updatedAt() != null);
    }

    @Test
    void save_withCorrectVersion_updatesAndBumpsVersion() {
        RoiDocumentDto v0 = service.save("PAT-2", new SaveRoiDocumentRequest(json(1), 1, null));
        RoiDocumentDto v1 = service.save("PAT-2", new SaveRoiDocumentRequest(json(2), 2, v0.version()));
        assertEquals(2, v1.roiCount());
        assertTrue(!v1.version().equals(v0.version()), "保存すると版が上がる");
    }

    @Test
    void save_withStaleVersion_conflictsInsteadOfClobbering() {
        RoiDocumentDto v0 = service.save("PAT-3", new SaveRoiDocumentRequest(json(5), 5, null));
        service.save("PAT-3", new SaveRoiDocumentRequest(json(6), 6, v0.version()));

        // 古い版で保存しようとする（別ウィンドウが先に保存した状況）。
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("PAT-3", new SaveRoiDocumentRequest(json(1), 1, v0.version())));
        assertEquals(HttpStatus.CONFLICT, statusOf(e));
        // 先に保存された内容が残っていること（＝消えていない）。
        assertEquals(6, service.get("PAT-3").roiCount());
    }

    @Test
    void save_withoutVersion_whenAlreadyExists_conflicts() {
        service.save("PAT-4", new SaveRoiDocumentRequest(json(4), 4, null));
        // 読まずに上書きしようとするのは拒否する（長期の計測を消し得るため）。
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("PAT-4", new SaveRoiDocumentRequest(json(1), 1, null)));
        assertEquals(HttpStatus.CONFLICT, statusOf(e));
        assertEquals(4, service.get("PAT-4").roiCount());
    }

    @Test
    void save_withVersion_whenDocumentWasDeleted_conflictsInsteadOfRecreating() {
        RoiDocumentDto v0 = service.save("PAT-5", new SaveRoiDocumentRequest(json(2), 2, null));
        service.delete("PAT-5");
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("PAT-5", new SaveRoiDocumentRequest(json(2), 2, v0.version())));
        assertEquals(HttpStatus.CONFLICT, statusOf(e));
    }

    @Test
    void save_rejectsCountMismatch() {
        // 件数はメタなので、JSON と食い違ったら受け付けない（一覧の件数だけ嘘になるのを防ぐ）。
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("PAT-6", new SaveRoiDocumentRequest(json(2), 5, null)));
        assertEquals(HttpStatus.BAD_REQUEST, statusOf(e));
    }

    @Test
    void save_rejectsBrokenJson() {
        // 壊れた JSON を保管して、次の読み込みで初めて気付く事故を防ぐ。
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("PAT-7", new SaveRoiDocumentRequest("{\"rois\":[", 0, null)));
        assertEquals(HttpStatus.BAD_REQUEST, statusOf(e));
    }

    @Test
    void save_rejectsJsonWithoutRoisArray() {
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("PAT-8", new SaveRoiDocumentRequest("{\"schema\":1}", 0, null)));
        assertEquals(HttpStatus.BAD_REQUEST, statusOf(e));
    }

    @Test
    void save_rejectsEmptyBody() {
        assertEquals(HttpStatus.BAD_REQUEST,
                statusOf(assertThrows(ResponseStatusException.class,
                        () -> service.save("PAT-9", new SaveRoiDocumentRequest("", 0, null)))));
        assertEquals(HttpStatus.BAD_REQUEST,
                statusOf(assertThrows(ResponseStatusException.class,
                        () -> service.save("PAT-9", new SaveRoiDocumentRequest(null, 0, null)))));
    }

    @Test
    void save_rejectsOversizedJson() {
        String big = "{\"schema\":1,\"rois\":[]}".repeat(1);
        StringBuilder sb = new StringBuilder("{\"schema\":1,\"rois\":[");
        while (sb.length() < RoiDocumentService.MAX_JSON_CHARS + 16) {
            sb.append("{\"roiUid\":\"").append("x".repeat(200)).append("\"},");
        }
        sb.append("{\"roiUid\":\"last\"}]}");
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("PAT-10", new SaveRoiDocumentRequest(sb.toString(), 1, null)));
        assertEquals(HttpStatus.PAYLOAD_TOO_LARGE, statusOf(e));
        assertTrue(big.length() > 0);
    }

    @Test
    void requiresPatientKey() {
        assertEquals(HttpStatus.BAD_REQUEST,
                statusOf(assertThrows(ResponseStatusException.class, () -> service.get("  "))));
        assertEquals(HttpStatus.BAD_REQUEST,
                statusOf(assertThrows(ResponseStatusException.class,
                        () -> service.save(null, new SaveRoiDocumentRequest(json(1), 1, null)))));
    }

    @Test
    void delete_removesDocument_andIsIdempotent() {
        service.save("PAT-11", new SaveRoiDocumentRequest(json(1), 1, null));
        service.delete("PAT-11");
        assertNull(service.get("PAT-11").json());
        // 2 回目でも落ちない（既に無い状態の削除を例外にしない）。
        service.delete("PAT-11");
        assertEquals(0, service.get("PAT-11").roiCount());
    }

    @Test
    void patientKeys_areIndependent() {
        service.save("PAT-A", new SaveRoiDocumentRequest(json(1), 1, null));
        service.save("PAT-B", new SaveRoiDocumentRequest(json(7), 7, null));
        assertEquals(1, service.get("PAT-A").roiCount());
        assertEquals(7, service.get("PAT-B").roiCount());
    }

    @Test
    void save_acceptsEmptyRoiList_forDeletingAllRois() {
        // 最後の ROI を消した状態も「保存」でなければならない（消したのに復元されるのを防ぐ）。
        RoiDocumentDto v0 = service.save("PAT-12", new SaveRoiDocumentRequest(json(2), 2, null));
        RoiDocumentDto v1 = service.save("PAT-12", new SaveRoiDocumentRequest(json(0), 0, v0.version()));
        assertEquals(0, v1.roiCount());
        assertEquals(0, service.get("PAT-12").roiCount());
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.store;

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
 * プラグイン保存領域（H8）を検証する。
 *
 * <p>主眼は 2 つ:
 * ① <b>プラグイン同士・患者同士が混ざらない</b>（別プラグインの保存を上書きしない）
 * ② <b>上書き事故を版で防ぐ</b>（数か月分の評価記録を、読まずに保存した誰かが消せない）
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:plugindoc;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class PluginDocumentServiceTest {

    @Autowired
    PluginDocumentService service;

    private static String json(String marker) {
        return "{\"schema\":1,\"marker\":\"" + marker + "\"}";
    }

    @Test
    void 未保存でも空の器を返す() {
        PluginDocumentDto dto = service.get("lesion-evanesco", "PAT-EMPTY");
        assertNull(dto.json());
        assertNull(dto.version());
        assertEquals("PAT-EMPTY", dto.patientKey());
        assertEquals("lesion-evanesco", dto.pluginId());
    }

    @Test
    void 初回保存は版なしで受け付け版を返す() {
        PluginDocumentDto saved = service.save("p1", "PAT-1", new SavePluginDocumentRequest(json("a"), null));
        assertEquals(json("a"), saved.json());
        assertEquals(0L, saved.version());
        assertEquals(json("a"), service.get("p1", "PAT-1").json());
    }

    @Test
    void 版を添えれば更新できる() {
        PluginDocumentDto first = service.save("p2", "PAT-1", new SavePluginDocumentRequest(json("a"), null));
        PluginDocumentDto second =
                service.save("p2", "PAT-1", new SavePluginDocumentRequest(json("b"), first.version()));
        assertEquals(json("b"), second.json());
        assertTrue(second.version() > first.version());
    }

    @Test
    void 既存があるのに版なしの保存は拒否する() {
        service.save("p3", "PAT-1", new SavePluginDocumentRequest(json("a"), null));
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("p3", "PAT-1", new SavePluginDocumentRequest(json("b"), null)));
        assertEquals(HttpStatus.CONFLICT, e.getStatusCode());
        // 元の内容が残っていること（拒否したのに書き換わっていた、が最悪）。
        assertEquals(json("a"), service.get("p3", "PAT-1").json());
    }

    @Test
    void 古い版での保存は拒否する() {
        PluginDocumentDto first = service.save("p4", "PAT-1", new SavePluginDocumentRequest(json("a"), null));
        service.save("p4", "PAT-1", new SavePluginDocumentRequest(json("b"), first.version()));
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("p4", "PAT-1", new SavePluginDocumentRequest(json("c"), first.version())));
        assertEquals(HttpStatus.CONFLICT, e.getStatusCode());
        assertEquals(json("b"), service.get("p4", "PAT-1").json());
    }

    @Test
    void 削除後に版つきで保存しても黙って作り直さない() {
        PluginDocumentDto saved = service.save("p5", "PAT-1", new SavePluginDocumentRequest(json("a"), null));
        service.delete("p5", "PAT-1");
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("p5", "PAT-1", new SavePluginDocumentRequest(json("b"), saved.version())));
        assertEquals(HttpStatus.CONFLICT, e.getStatusCode());
    }

    @Test
    void プラグインが違えば別の保存になる() {
        service.save("plugin-a", "PAT-SHARED", new SavePluginDocumentRequest(json("a"), null));
        service.save("plugin-b", "PAT-SHARED", new SavePluginDocumentRequest(json("b"), null));
        assertEquals(json("a"), service.get("plugin-a", "PAT-SHARED").json());
        assertEquals(json("b"), service.get("plugin-b", "PAT-SHARED").json());
    }

    @Test
    void 患者が違えば別の保存になる() {
        service.save("p6", "PAT-X", new SavePluginDocumentRequest(json("x"), null));
        service.save("p6", "PAT-Y", new SavePluginDocumentRequest(json("y"), null));
        assertEquals(json("x"), service.get("p6", "PAT-X").json());
        assertEquals(json("y"), service.get("p6", "PAT-Y").json());
    }

    @Test
    void 削除しても他プラグインの保存は残る() {
        service.save("plugin-c", "PAT-DEL", new SavePluginDocumentRequest(json("c"), null));
        service.save("plugin-d", "PAT-DEL", new SavePluginDocumentRequest(json("d"), null));
        service.delete("plugin-c", "PAT-DEL");
        assertNull(service.get("plugin-c", "PAT-DEL").json());
        assertEquals(json("d"), service.get("plugin-d", "PAT-DEL").json());
    }

    @Test
    void 壊れたJSONは拒否する() {
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("p7", "PAT-1", new SavePluginDocumentRequest("{\"a\":", null)));
        assertEquals(HttpStatus.BAD_REQUEST, e.getStatusCode());
    }

    @Test
    void 空のJSONは拒否する() {
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> service.save("p8", "PAT-1", new SavePluginDocumentRequest("  ", null))).getStatusCode());
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> service.save("p8", "PAT-1", new SavePluginDocumentRequest(null, null))).getStatusCode());
    }

    @Test
    void 大きすぎるJSONは拒否する() {
        String big = "{\"a\":\"" + "x".repeat(PluginDocumentService.MAX_JSON_CHARS) + "\"}";
        ResponseStatusException e = assertThrows(ResponseStatusException.class,
                () -> service.save("p9", "PAT-1", new SavePluginDocumentRequest(big, null)));
        assertEquals(HttpStatus.PAYLOAD_TOO_LARGE, e.getStatusCode());
    }

    @Test
    void プラグインidと患者キーの妥当性を見る() {
        for (String bad : new String[] {"", "a/b", "../etc", "x".repeat(65), "日本語"}) {
            assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                    () -> service.get(bad, "PAT-1")).getStatusCode(), "pluginId=" + bad);
        }
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> service.get("p10", " ")).getStatusCode());
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> service.get("p10", "k".repeat(257))).getStatusCode());
    }

    @Test
    void 患者キーに記号が入っても保存できる() {
        // PatientID は自由文字列なので `/` や `^` が入り得る。
        String key = "PAT/1 2:3^4";
        service.save("p11", key, new SavePluginDocumentRequest(json("s"), null));
        assertEquals(json("s"), service.get("p11", key).json());
    }
}

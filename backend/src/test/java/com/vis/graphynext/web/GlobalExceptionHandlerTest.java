/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * REST の例外 → HTTP ステータスの対応を固定する。
 *
 * <p>とくに {@link ResponseStatusException} の扱い。これが素通りすると
 * <b>呼び出し側が宣言した 400 / 404 が一律 500 になり</b>、クライアントからは
 * 「入力が悪い」のか「サーバが壊れた」のか区別できない。本文にも
 * {@code 400 BAD_REQUEST "…"} という文字列がそのまま入る。
 * リポジトリ全体で 57 箇所が {@code ResponseStatusException} を投げており、
 * 実際にその全部が 500 として返っていた。
 */
class GlobalExceptionHandlerTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();

    private static HttpServletRequest request() {
        MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/series/derived");
        return req;
    }

    @Test
    void responseStatusExceptionKeepsItsStatus() {
        ResponseEntity<GlobalExceptionHandler.ErrorResponse> res = handler.statusException(
                new ResponseStatusException(HttpStatus.BAD_REQUEST, "入力が不正です"), request());

        assertEquals(HttpStatus.BAD_REQUEST, res.getStatusCode());
        assertNotNull(res.getBody());
        assertEquals(400, res.getBody().status());
        // getMessage() ではなく getReason() を返す（前者は `400 BAD_REQUEST "…"` になる）。
        assertEquals("入力が不正です", res.getBody().message());
    }

    @Test
    void notFoundKeepsItsStatus() {
        ResponseEntity<GlobalExceptionHandler.ErrorResponse> res = handler.statusException(
                new ResponseStatusException(HttpStatus.NOT_FOUND, "見つかりません"), request());
        assertEquals(HttpStatus.NOT_FOUND, res.getStatusCode());
        assertEquals(404, res.getBody().status());
    }

    @Test
    void causeClassNameIsReportedSoTheClientCanTellThemApart() {
        // 原因が分かると、UI 側で「入力の直し方」を出し分けられる。
        ResponseEntity<GlobalExceptionHandler.ErrorResponse> res = handler.statusException(
                new ResponseStatusException(HttpStatus.BAD_REQUEST, "だめ",
                        new IllegalArgumentException("元の理由")), request());
        assertEquals("IllegalArgumentException", res.getBody().error());
    }

    @Test
    void serverSideStatusIsStillFiveHundred() {
        ResponseEntity<GlobalExceptionHandler.ErrorResponse> res = handler.statusException(
                new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "保存に失敗"), request());
        assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, res.getStatusCode());
    }

    @Test
    void illegalArgumentIsBadRequest() {
        ResponseEntity<GlobalExceptionHandler.ErrorResponse> res =
                handler.badRequest(new IllegalArgumentException("不正"), request());
        assertEquals(HttpStatus.BAD_REQUEST, res.getStatusCode());
        assertEquals("不正", res.getBody().message());
    }

    @Test
    void ioExceptionIsServerError() {
        ResponseEntity<GlobalExceptionHandler.ErrorResponse> res =
                handler.serverError(new IOException("ディスクが読めない"), request());
        assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, res.getStatusCode());
    }

    @Test
    void unexpectedExceptionIsServerErrorAndKeepsTheMessage() {
        ResponseEntity<GlobalExceptionHandler.ErrorResponse> res =
                handler.unexpected(new RuntimeException("想定外"), request());
        assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, res.getStatusCode());
        assertTrue(res.getBody().message().contains("想定外"));
    }
}

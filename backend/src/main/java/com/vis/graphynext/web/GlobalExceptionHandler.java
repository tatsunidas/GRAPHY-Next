/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.io.IOException;

/**
 * 全 REST の例外を一元処理し、一貫した JSON エラーとログを返す。
 *
 * <p>方針: クライアント起因(4xx)は WARN、サーバ/外部起因(5xx)はスタックトレース付き ERROR。
 * 想定外は必ずログに残す（未検証・エラーが起こりやすい箇所の追跡用）。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    public record ErrorResponse(int status, String error, String message, String path) {
    }

    /** 不正入力など（クライアント起因）。 */
    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ErrorResponse> badRequest(IllegalArgumentException e, HttpServletRequest req) {
        log.warn("Bad request {} {}: {}", req.getMethod(), req.getRequestURI(), e.getMessage());
        return build(HttpStatus.BAD_REQUEST, e, req);
    }

    /** I/O・状態異常（外部ツール/PACS/ファイル等。エラーが起こりやすい箇所）。 */
    @ExceptionHandler({IOException.class, IllegalStateException.class})
    public ResponseEntity<ErrorResponse> serverError(Exception e, HttpServletRequest req) {
        log.error("Error handling {} {}", req.getMethod(), req.getRequestURI(), e);
        return build(HttpStatus.INTERNAL_SERVER_ERROR, e, req);
    }

    /** 想定外。必ずスタックトレースを残す。 */
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> unexpected(Exception e, HttpServletRequest req) {
        log.error("Unexpected error {} {}", req.getMethod(), req.getRequestURI(), e);
        return build(HttpStatus.INTERNAL_SERVER_ERROR, e, req);
    }

    private static ResponseEntity<ErrorResponse> build(HttpStatus status, Exception e, HttpServletRequest req) {
        String message = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
        return ResponseEntity.status(status)
                .body(new ErrorResponse(status.value(), e.getClass().getSimpleName(), message, req.getRequestURI()));
    }
}

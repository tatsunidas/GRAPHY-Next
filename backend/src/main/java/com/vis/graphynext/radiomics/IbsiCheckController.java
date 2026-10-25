/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

/** IBSI 照合のエンドポイント。web モードは Radiomics と同じく 403。 */
@RestController
@RequestMapping("/api/radiomics/ibsi-check")
public class IbsiCheckController {

    private final IbsiCheckService service;

    public IbsiCheckController(IbsiCheckService service) {
        this.service = service;
    }

    @GetMapping
    public IbsiCheckService.Result run(@RequestParam(defaultValue = "false") boolean refresh) {
        try {
            return service.run(refresh);
        } catch (IllegalStateException e) {
            // web モードでの呼び出し、または照合の失敗（データが無い等）。モードの断りだけ 403 にする。
            HttpStatus status = e.getMessage() != null && e.getMessage().contains("standalone モード専用")
                    ? HttpStatus.FORBIDDEN : HttpStatus.INTERNAL_SERVER_ERROR;
            throw new ResponseStatusException(status, e.getMessage(), e);
        }
    }

    @GetMapping("/records")
    public List<JsonNode> records() {
        try {
            return service.records();
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, e.getMessage(), e);
        }
    }
}

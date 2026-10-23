/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.anonymize.ReceiveAnonymizer;
import com.vis.graphynext.settings.SettingsService;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.util.Map;

/**
 * 受信時の匿名化の設定と状態。受信（SCP）は standalone だけなので、この口も standalone だけ。
 * 設定は Settings(H2) に保存し、受信のたびに読まれる（再起動は要らない）。
 */
@RestController
@RequestMapping("/api/dicom/receive-anonymize")
@Profile("standalone")
public class ReceiveAnonymizeController {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final ReceiveAnonymizer anonymizer;
    private final SettingsService settings;

    public ReceiveAnonymizeController(ReceiveAnonymizer anonymizer, SettingsService settings) {
        this.anonymizer = anonymizer;
        this.settings = settings;
    }

    public record Body(boolean enabled, ReceiveAnonymizer.Profile profile) {
    }

    public record View(boolean enabled, ReceiveAnonymizer.Profile profile, ReceiveAnonymizer.Status status) {
    }

    @GetMapping
    public View get() throws IOException {
        String json = settings.getAll().get(ReceiveAnonymizer.PROFILE_KEY);
        ReceiveAnonymizer.Profile profile;
        try {
            profile = anonymizer.readProfile(json);
        } catch (IOException e) {
            profile = null; // 読めない設定。status.profileValid=false で画面に伝える
        }
        return new View(anonymizer.enabled(), profile, anonymizer.status());
    }

    @PutMapping
    public View put(@RequestBody Body body) throws IOException {
        if (body.profile() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "profile が必要です");
        }
        String json;
        try {
            json = MAPPER.writeValueAsString(body.profile());
            // 保存の前に検査する（未知のオプション・日付の排他違反は 400。壊れた設定を保存して受信を止めない）。
            anonymizer.validate(json);
            if (body.profile().patientIdPrefix() != null && body.profile().patientIdPrefix().length() > 54) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "患者 ID の接頭辞が長すぎます（最大 54 文字）");
            }
        } catch (JsonProcessingException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "profile を読めません");
        }
        settings.putAll(Map.of(
                ReceiveAnonymizer.ENABLED_KEY, Boolean.toString(body.enabled()),
                ReceiveAnonymizer.PROFILE_KEY, json));
        return get();
    }

    /** 検査の失敗（未知のオプション等）は 400 で返す。 */
    @org.springframework.web.bind.annotation.ExceptionHandler(ResponseStatusException.class)
    ResponseEntity<Map<String, String>> status(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("error", String.valueOf(e.getReason())));
    }
}

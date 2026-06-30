/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.util.ArrayList;
import java.util.List;

/**
 * Anonymizer REST（PS3.15）。属性匿名化＋Pixel 焼き込みで ZIP/フォルダ出力、焼き込みマスク登録。
 */
@RestController
@RequestMapping("/api/anonymizer")
public class AnonymizeController {

    private final AnonymizeService service;
    private final AnonymizeMaskStore maskStore;

    public AnonymizeController(AnonymizeService service, AnonymizeMaskStore maskStore) {
        this.service = service;
        this.maskStore = maskStore;
    }

    /** リクエスト本文。 */
    public record AnonRequest(List<String> studyUids, List<String> options, String replacePatientName,
                              String replacePatientId, Long randomSeed, List<String> manualRetainTags,
                              java.util.Map<String, String> customReplacements, boolean burnIn, String destination) {
    }

    public record ProfileDto(String name, List<String> options) {
    }

    /** 既定プロファイル雛形。 */
    @GetMapping("/profiles")
    public List<ProfileDto> profiles() {
        return List.of(
                new ProfileDto("basic", List.of()),
                new ProfileDto("retainUIDs", List.of("RetainUIDs")),
                new ProfileDto("research", List.of("RetainPatientCharacteristics",
                        "RetainLongitudinalTemporalInformationModifiedDates", "CleanDescriptors", "RetainSafePrivate")),
                new ProfileDto("cleanPixel", List.of("CleanPixelData")));
    }

    @PostMapping("/zip")
    public ResponseEntity<StreamingResponseBody> zip(@RequestBody AnonRequest req) {
        requireStandalone();
        validate(req);
        AnonymizeConfig cfg = toConfig(req);
        StreamingResponseBody body = out -> {
            try {
                service.anonymizeToZip(req.studyUids(), cfg, req.burnIn(), out);
            } catch (Exception e) {
                throw new java.io.IOException(e);
            }
        };
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("application/zip"))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"anonymized.zip\"")
                .body(body);
    }

    @PostMapping("/copy")
    public AnonymizeService.Result copy(@RequestBody AnonRequest req) {
        requireStandalone();
        validate(req);
        if (req.destination() == null || req.destination().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "destination が空です");
        }
        try {
            return service.anonymizeToFolder(req.studyUids(), toConfig(req), req.burnIn(), req.destination());
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, e.getMessage());
        }
    }

    // ── 焼き込みマスク（2D viewer から登録、Anonymizer が参照） ──
    @PostMapping("/masks")
    public void registerMask(@RequestBody AnonymizeMaskStore.SeriesMask mask) {
        if (mask == null || mask.seriesUid() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "seriesUid が必要です");
        }
        maskStore.put(mask);
    }

    @GetMapping("/masks")
    public List<AnonymizeMaskStore.SeriesMask> masks(@RequestParam String seriesUids) {
        List<String> ids = new ArrayList<>();
        for (String s : seriesUids.split(",")) {
            if (!s.isBlank()) {
                ids.add(s.trim());
            }
        }
        return maskStore.get(ids);
    }

    @DeleteMapping("/masks")
    public void clearMask(@RequestParam(required = false) String seriesUid) {
        if (seriesUid == null || seriesUid.isBlank()) {
            maskStore.clear();
        } else {
            maskStore.remove(seriesUid);
        }
    }

    private void requireStandalone() {
        if (service.isWeb()) {
            throw new ResponseStatusException(HttpStatus.NOT_IMPLEMENTED,
                    "web モードの匿名化（WADO 取得）は未対応です。standalone をご利用ください。");
        }
    }

    private static void validate(AnonRequest req) {
        if (req.studyUids() == null || req.studyUids().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "studyUids が空です");
        }
    }

    private static AnonymizeConfig toConfig(AnonRequest req) {
        AnonymizeConfig cfg = new AnonymizeConfig();
        if (req.options() != null) {
            for (String o : req.options()) {
                try {
                    cfg.addOption(AnonymizeConfig.Option.valueOf(o));
                } catch (IllegalArgumentException ignore) {
                    // 未知オプションは無視
                }
            }
        }
        if (req.replacePatientName() != null) {
            cfg.setReplacePatientName(req.replacePatientName());
        }
        if (req.replacePatientId() != null) {
            cfg.setReplacePatientId(req.replacePatientId());
        }
        cfg.setRandomSeed(req.randomSeed());
        if (req.manualRetainTags() != null) {
            for (String hex : req.manualRetainTags()) {
                Integer tag = parseTag(hex);
                if (tag != null) {
                    cfg.getManualRetainTags().add(tag);
                }
            }
        }
        if (req.customReplacements() != null) {
            req.customReplacements().forEach((hex, val) -> {
                Integer tag = parseTag(hex);
                if (tag != null) {
                    cfg.getCustomTagReplacements().put(tag, val);
                }
            });
        }
        return cfg;
    }

    private static Integer parseTag(String hex) {
        if (hex == null) {
            return null;
        }
        String h = hex.replaceAll("[^0-9A-Fa-f]", "");
        if (h.length() != 8) {
            return null;
        }
        try {
            return (int) Long.parseLong(h, 16);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}

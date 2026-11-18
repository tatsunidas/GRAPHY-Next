/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.facility;

import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Objects;

/**
 * 施設の資料パネルの内容と状態。未設定なら 204（画面は節を出さない）。内容は<b>検証を通した構造だけ</b>で、ファイルの生の内容は返さない。
 * {@code ETag} で、変わっていないときは 304 を返す（画面が数秒ごとに問い合わせても転送が小さい）。
 */
@RestController
@RequestMapping("/api/facility")
public class FacilityConfigController {

    public record ConfigDto(String state, String error, String errorPath, Long lastReadAt, int rev, String source,
                            FacilityConfig config) {
    }

    private final FacilityConfigWatchService watch;

    public FacilityConfigController(FacilityConfigWatchService watch) {
        this.watch = watch;
    }

    @GetMapping("/config")
    public ResponseEntity<ConfigDto> config(@RequestHeader(value = HttpHeaders.IF_NONE_MATCH, required = false) String ifNoneMatch) {
        FacilityConfigWatchService.State s = watch.state();
        if ("unconfigured".equals(s.state())) {
            return ResponseEntity.noContent().cacheControl(CacheControl.noCache()).build();
        }
        String etag = "W/\"" + s.rev() + "-" + Objects.hash(s.state(), s.error(), s.errorPath(), s.source()) + "\"";
        if (etag.equals(ifNoneMatch)) {
            return ResponseEntity.status(HttpStatus.NOT_MODIFIED).eTag(etag).cacheControl(CacheControl.noCache()).build();
        }
        ConfigDto dto = new ConfigDto(s.state(), s.error(), s.errorPath(), s.lastReadAt(), s.rev(), s.source(), watch.config());
        return ResponseEntity.ok().eTag(etag).cacheControl(CacheControl.noCache()).body(dto);
    }
}

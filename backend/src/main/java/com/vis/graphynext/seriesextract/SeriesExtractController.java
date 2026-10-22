/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.seriesextract;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * SeriesExtractor REST: 条件一致シリーズの検証・コピー・ZIP。
 *
 * <ul>
 *   <li>{@code POST /api/series-extract/verify} → 一致プレビュー（VerifyResult）。</li>
 *   <li>{@code POST /api/series-extract/copy} → standalone でフォルダコピー（CopyResult）。</li>
 *   <li>{@code POST /api/series-extract/zip} → standalone のローカルファイルを ZIP で返す。</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/series-extract")
public class SeriesExtractController {

    private final SeriesExtractService service;
    private final SeriesExtractJobService jobs;

    public SeriesExtractController(SeriesExtractService service, SeriesExtractJobService jobs) {
        this.service = service;
        this.jobs = jobs;
    }

    /**
     * リクエスト本文。対象は studyUids の明示か filters（サーバーで解決）。destination/sequentialRename は copy/zip 用。
     * verifyJobId を渡すと、その検証ジョブの結果を再探索せずに使う（copy・datasheet）。
     */
    public record ExtractReq(List<String> studyUids, List<SearchCondition> conditions, List<String> planes,
                             String destination, boolean sequentialRename,
                             com.vis.graphynext.dicom.StudySearch filters, String verifyJobId) {
    }

    /** 対象の規模（スタディ・シリーズ・枚数）。ファイルは読まない。 */
    @PostMapping("/scope")
    public SeriesExtractService.ScopeCounts scope(@RequestBody ExtractReq req) {
        return service.scope(scopeOf(req));
    }

    @PostMapping("/verify")
    public SeriesExtractService.VerifyResult verify(@RequestBody ExtractReq req) {
        checkDuplicates(req);
        return service.verify(resolve(req), conds(req), req.planes());
    }

    /** 進捗付きの探索（検証）。{@code GET /jobs/{id}} をポーリングし、DONE で一致一覧が入る。 */
    @PostMapping("/jobs")
    public SeriesExtractJobService.Status submitVerify(@RequestBody ExtractReq req) {
        checkDuplicates(req);
        return jobs.submitVerify(resolve(req), conds(req), req.planes());
    }

    /** 進捗付きのフォルダコピー（standalone のみ）。 */
    @PostMapping("/jobs/copy")
    public SeriesExtractJobService.Status submitCopy(@RequestBody ExtractReq req) {
        if (service.isWeb()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "フォルダコピーは standalone 専用です（web は ZIP を使用）。");
        }
        if (req.destination() == null || req.destination().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "出力先フォルダが指定されていません。");
        }
        if (req.verifyJobId() != null && !req.verifyJobId().isBlank()) {
            try {
                return jobs.submitCopyVerified(req.verifyJobId(), req.destination(), req.sequentialRename());
            } catch (SeriesExtractJobService.StaleJobException e) {
                throw new ResponseStatusException(HttpStatus.GONE, e.getMessage());
            }
        }
        checkDuplicates(req);
        return jobs.submitCopy(resolve(req), conds(req), req.planes(), req.destination(), req.sequentialRename());
    }

    /** 検証済みの一覧からデータシートを作る（GET でも取れるようにしておく）。 */
    @GetMapping("/jobs/{id}/datasheet")
    public ResponseEntity<byte[]> jobDatasheet(@PathVariable String id) {
        return datasheet(new ExtractReq(null, null, null, null, false, null, id));
    }

    @GetMapping("/jobs/{id}")
    public SeriesExtractJobService.Status job(@PathVariable String id) {
        SeriesExtractJobService.Status st = jobs.get(id);
        if (st == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "ジョブが見つかりません");
        }
        return st;
    }

    @PostMapping("/jobs/{id}/cancel")
    public SeriesExtractJobService.Status cancelJob(@PathVariable String id) {
        SeriesExtractJobService.Status st = jobs.cancel(id);
        if (st == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "ジョブが見つかりません");
        }
        return st;
    }

    /** データシート CSV（患者 ID・Study 日付・StudyUID・SeriesUID ＋ 条件タグの実測値）。 */
    @PostMapping("/datasheet")
    public ResponseEntity<byte[]> datasheet(@RequestBody ExtractReq req) {
        String csv;
        if (req.verifyJobId() != null && !req.verifyJobId().isBlank()) {
            // 検証済みの一覧から作る（再探索しない）。
            try {
                csv = jobs.datasheet(req.verifyJobId());
            } catch (SeriesExtractJobService.StaleJobException e) {
                throw new ResponseStatusException(HttpStatus.GONE, e.getMessage());
            }
        } else {
            checkDuplicates(req);
            SeriesExtractService.VerifyResult vr = service.verify(resolve(req), conds(req), req.planes());
            if (vr.matched().isEmpty()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "条件に一致するシリーズがありません");
            }
            csv = SeriesExtractService.datasheetCsv(vr.matched(), conds(req));
        }
        byte[] body = csv.getBytes(StandardCharsets.UTF_8);
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("text/csv; charset=UTF-8"))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"series_datasheet.csv\"")
                .body(body);
    }

    @PostMapping("/copy")
    public ResponseEntity<SeriesExtractService.CopyResult> copy(@RequestBody ExtractReq req) {
        checkDuplicates(req);
        try {
            return ResponseEntity.ok(service.copyToFolder(
                    resolve(req), conds(req), req.planes(), req.destination(), req.sequentialRename()));
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, e.getMessage());
        }
    }

    @PostMapping("/zip")
    public ResponseEntity<StreamingResponseBody> zip(@RequestBody ExtractReq req) {
        if (service.isWeb()) {
            // web の ZIP は WADO-RS 取得が必要（未実装）。
            throw new ResponseStatusException(HttpStatus.NOT_IMPLEMENTED,
                    "web モードの ZIP（WADO-RS 取得）は未対応です。standalone をご利用ください。");
        }
        checkDuplicates(req);
        // ストリーミングは失敗しても HTTP 200 になるので、書く前に件数を数えて 0 件は 409 で弾く。
        List<String> uids = resolve(req);
        if (service.countMatched(uids, conds(req), req.planes()) == 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "条件に一致するシリーズがありません");
        }
        StreamingResponseBody body = out -> {
            try {
                service.zipLocal(uids, conds(req), req.planes(), req.sequentialRename(), out);
            } catch (Exception e) {
                throw new java.io.IOException(e);
            }
        };
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("application/zip"))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"series-extract.zip\"")
                .body(body);
    }

    private static SeriesExtractService.ScopeReq scopeOf(ExtractReq req) {
        return new SeriesExtractService.ScopeReq(req.studyUids(), req.filters());
    }

    /** 対象のスタディ UID（明示か、絞り込み条件のサーバー解決）。0 件は 400。 */
    private List<String> resolve(ExtractReq req) {
        List<String> uids;
        try {
            uids = service.resolveStudies(scopeOf(req));
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
        if (uids.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "対象のスタディがありません");
        }
        return uids;
    }

    /** 全く同じタグ経路の条件は重複として 400（画面でも弾くが、API 直叩きも守る）。 */
    static void checkDuplicates(ExtractReq req) {
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (SearchCondition c : conds(req)) {
            StringBuilder key = new StringBuilder();
            for (var seg : c.segments()) {
                key.append(seg.tag() == null ? "" : seg.tag().toUpperCase())
                        .append('{').append(seg.creator() == null ? "" : seg.creator()).append("}>");
            }
            if (!seen.add(key.toString())) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "同じタグ経路の条件が重複しています: " + key);
            }
        }
    }

    private static List<SearchCondition> conds(ExtractReq req) {
        return req.conditions() == null ? List.of() : req.conditions();
    }
}

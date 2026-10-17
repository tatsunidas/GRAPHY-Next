/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

/**
 * Raw データ（ヘッダの無い画素配列）の取り込み（fw/nifti-import.md「Raw データ」）。NIfTI と同じ変換に、
 * 利用者の入力から作ったヘッダを渡す。ローカル FS のパス指定なので standalone だけ。
 *
 * <ul>
 *   <li>{@code POST /api/raw/import} … 変換して保管庫へ取り込む。画素がファイルに足りなければ 400</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/raw")
@Profile("standalone")
public class RawImportController {

    private final NiftiImportService service;

    public RawImportController(NiftiImportService service) {
        this.service = service;
    }

    public record ImportRequest(
            String path,
            RawSpec spec,
            String modality,
            String patientId,
            String patientName,
            String patientBirthDate,
            String patientSex,
            String studyDate,
            String studyDescription,
            String seriesDescription,
            Integer seriesNumber,
            String studyInstanceUid,
            String valueUnit) {
    }

    /**
     * @param requiredBytes 画素を読むのに要るバイト数
     * @param fileBytes     ファイルの大きさ
     * @param trailingBytes 読まずに残るバイト数（申告の誤りの手がかり。0 なら過不足なし）
     */
    public record ImportResponse(NiftiImportService.Result result, long requiredBytes, long fileBytes,
                                 long trailingBytes, String error) {
    }

    @PostMapping("/import")
    public ResponseEntity<ImportResponse> importRaw(@RequestBody ImportRequest req) {
        Path file = req == null || req.path() == null || req.path().isBlank() ? null : Path.of(req.path());
        if (file == null || !Files.isRegularFile(file)) {
            return ResponseEntity.badRequest().body(new ImportResponse(null, 0, 0, 0, "ファイルが見つかりません"));
        }
        if (req.spec() == null) {
            return ResponseEntity.badRequest().body(new ImportResponse(null, 0, 0, 0, "読み方の指定がありません"));
        }
        if (!NiftiToDicom.validUnit(req.valueUnit())) {
            return ResponseEntity.badRequest().body(new ImportResponse(null, 0, 0, 0,
                    "単位のコードが長すぎるか、使えない文字を含みます（UCUM・16 文字以内）: " + req.valueUnit()));
        }
        long required;
        NiftiHeader header;
        long size;
        try {
            required = req.spec().requiredBytes();
            header = req.spec().toHeader();
            size = Files.size(file);
        } catch (RawSpec.InvalidSpec e) {
            return ResponseEntity.badRequest().body(new ImportResponse(null, 0, 0, 0, e.getMessage()));
        } catch (IOException e) {
            return ResponseEntity.badRequest().body(new ImportResponse(null, 0, 0, 0, "ファイルを読めません: " + e.getMessage()));
        }
        if (required > size) {
            return ResponseEntity.badRequest().body(new ImportResponse(null, required, size, 0,
                    "画素がファイルに足りません（必要 " + required + " バイト・ファイル " + size + " バイト）"));
        }
        NiftiToDicom.Options opts = new NiftiToDicom.Options(
                req.modality() == null || req.modality().isBlank() ? "MR" : req.modality(),
                req.patientId(), req.patientName(), req.patientBirthDate(), req.patientSex(),
                req.studyDate(), req.studyDescription(), req.seriesDescription(),
                req.seriesNumber() == null ? 1 : req.seriesNumber(),
                req.studyInstanceUid(), null, Map.of(), req.valueUnit());
        NiftiImportService.Result result = service.importRaw(file, header, opts);
        ImportResponse body = new ImportResponse(result, required, size, size - required, result.error());
        return result.error() == null ? ResponseEntity.ok(body) : ResponseEntity.badRequest().body(body);
    }
}

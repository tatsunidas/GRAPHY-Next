/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.registration;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.Optional;

/**
 * 位置合わせ記録の保管（{@code RoiDocumentService} と同じ作法）。
 *
 * <p>backend は中身を解釈しない。スキーマの正本はフロントの {@code registrationRecord.ts} で、
 * ここが担うのは保管・件数・版管理だけ。変換モデルが増えるたびに backend を改修しなくてよい
 * 形にしてある。
 */
@Service
public class RegistrationDocumentService {

    /**
     * JSON 本文の上限。
     *
     * <p>ROI（8 MB）より大きくしてある。<b>非剛体の変位場</b>を Base64 で含むため。
     * 制御格子は粗い（既定 12mm）ので頭部で数十 KB・全身で数百 KB だが、
     * 細かい設定と多数の組み合わせを保存すると積み上がる。無制限にはしない。
     */
    static final int MAX_JSON_CHARS = 32 * 1024 * 1024;

    private final RegistrationDocumentRepository repository;
    private final ObjectMapper mapper = new ObjectMapper();

    public RegistrationDocumentService(RegistrationDocumentRepository repository) {
        this.repository = repository;
    }

    @Transactional(readOnly = true)
    public RegistrationDocumentDto get(String patientKey) {
        String key = requireKey(patientKey);
        Optional<RegistrationDocument> found = repository.findById(key);
        if (found.isEmpty()) {
            // 「まだ無い」は正常。空の器を返してフロントに分岐を書かせない（404 にしない）。
            return new RegistrationDocumentDto(key, null, 0, null, null);
        }
        return toDto(found.get());
    }

    @Transactional
    public RegistrationDocumentDto save(String patientKey, SaveRegistrationDocumentRequest req) {
        String key = requireKey(patientKey);
        if (req == null || req.json() == null || req.json().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "json が空です");
        }
        if (req.json().length() > MAX_JSON_CHARS) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                    "json が大きすぎます（上限 " + MAX_JSON_CHARS + " 文字）");
        }
        int counted = countRecords(req.json());
        if (counted != req.recordCount()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "recordCount(" + req.recordCount() + ") が json の件数(" + counted + ") と一致しません");
        }

        Optional<RegistrationDocument> existing = repository.findById(key);
        try {
            if (existing.isEmpty()) {
                if (req.version() != null) {
                    // 版を持っているのに実体が無い＝別ウィンドウが削除した後。黙って作り直さない。
                    throw new ResponseStatusException(HttpStatus.CONFLICT,
                            "保存先が存在しません（別のウィンドウが削除した可能性があります）。読み直してください");
                }
                return toDto(repository.save(new RegistrationDocument(key, req.json(), counted)));
            }
            RegistrationDocument d = existing.get();
            if (req.version() == null) {
                // 読まずに上書きしようとしている。別ウィンドウで作った位置合わせを消し得るので拒否する。
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "既に保存があります。読み直して version を添えてください");
            }
            if (!req.version().equals(d.getVersion())) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "版が古いです（保存済み=" + d.getVersion() + " 要求=" + req.version() + "）。読み直してください");
            }
            d.update(req.json(), counted);
            return toDto(repository.saveAndFlush(d));
        } catch (ObjectOptimisticLockingFailureException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "同時に保存されました。読み直してください", e);
        }
    }

    @Transactional
    public void delete(String patientKey) {
        repository.deleteById(requireKey(patientKey));
    }

    private RegistrationDocumentDto toDto(RegistrationDocument d) {
        return new RegistrationDocumentDto(
                d.getPatientKey(),
                d.getJson(),
                d.getRecordCount(),
                d.getUpdatedAt() == null ? null : d.getUpdatedAt().toString(),
                d.getVersion());
    }

    private String requireKey(String patientKey) {
        if (patientKey == null || patientKey.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "patientKey が必要です");
        }
        return patientKey;
    }

    /**
     * {@code records} 配列の件数を数える。**構文検査も兼ねる**
     * （壊れた JSON を保管して、次に開いたときに初めて気付く事故を防ぐ）。
     */
    private int countRecords(String json) {
        try {
            JsonNode root = mapper.readTree(json);
            JsonNode records = root.get("records");
            if (records == null || !records.isArray()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "json に records 配列がありません");
            }
            return records.size();
        } catch (ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "json を解析できません", e);
        }
    }
}

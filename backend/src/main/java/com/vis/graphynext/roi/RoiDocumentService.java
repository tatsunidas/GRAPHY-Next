/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.roi;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.Optional;

/**
 * ROI（幾何注釈）の永続化（`fw/roi-manager-design.md` M5・アプリ内 JSON）。
 *
 * <p>backend は**中身を解釈しない**（スキーマの正本はフロント）。ここでやるのは
 * ①患者単位の保管 ②楽観ロックによる上書き事故の防止 ③明らかに壊れた入力の拒否 の 3 つだけ。
 */
@Service
public class RoiDocumentService {

    /**
     * JSON 本文の上限（バイト数相当の文字数）。自由曲線 ROI はハンドルが数千点になり得るため
     * 余裕を持たせつつ、無制限にはしない（1 患者の ROI が DB を埋めるのを防ぐ）。
     */
    static final int MAX_JSON_CHARS = 8 * 1024 * 1024;

    private final RoiDocumentRepository repository;
    private final ObjectMapper mapper = new ObjectMapper();

    public RoiDocumentService(RoiDocumentRepository repository) {
        this.repository = repository;
    }

    @Transactional(readOnly = true)
    public RoiDocumentDto get(String patientKey) {
        String key = requireKey(patientKey);
        Optional<RoiDocument> found = repository.findById(key);
        if (found.isEmpty()) {
            // 「まだ無い」は正常。空の器を返してフロントに分岐を書かせない（404 にしない）。
            return new RoiDocumentDto(key, null, 0, null, null);
        }
        RoiDocument d = found.get();
        return toDto(d);
    }

    @Transactional
    public RoiDocumentDto save(String patientKey, SaveRoiDocumentRequest req) {
        String key = requireKey(patientKey);
        if (req == null || req.json() == null || req.json().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "json が空です");
        }
        if (req.json().length() > MAX_JSON_CHARS) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                    "json が大きすぎます（上限 " + MAX_JSON_CHARS + " 文字）");
        }
        int counted = countRois(req.json());
        if (counted != req.roiCount()) {
            // 件数はメタなので JSON と食い違ったら受け付けない（一覧の件数だけ嘘になるのを防ぐ）。
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "roiCount(" + req.roiCount() + ") が json の件数(" + counted + ") と一致しません");
        }

        Optional<RoiDocument> existing = repository.findById(key);
        try {
            if (existing.isEmpty()) {
                if (req.version() != null) {
                    // 版を持っているのに実体が無い＝別ウィンドウが削除した後。黙って作り直さない。
                    throw new ResponseStatusException(HttpStatus.CONFLICT,
                            "保存先が存在しません（別のウィンドウが削除した可能性があります）。読み直してください");
                }
                return toDto(repository.save(new RoiDocument(key, req.json(), counted)));
            }
            RoiDocument d = existing.get();
            if (req.version() == null) {
                // 読まずに上書きしようとしている。RECIST のような長期の計測を消し得るので拒否する。
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
            // 同時保存が版チェックをすり抜けた場合（同一トランザクション外の競合）。
            throw new ResponseStatusException(HttpStatus.CONFLICT, "同時に保存されました。読み直してください", e);
        }
    }

    @Transactional
    public void delete(String patientKey) {
        repository.deleteById(requireKey(patientKey));
    }

    private RoiDocumentDto toDto(RoiDocument d) {
        return new RoiDocumentDto(
                d.getPatientKey(),
                d.getJson(),
                d.getRoiCount(),
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
     * JSON の {@code rois} 配列の件数を数える。**構文検査も兼ねる**（壊れた JSON を保管して
     * 次回の読み込みで初めて気付く、という事故を防ぐ）。
     */
    private int countRois(String json) {
        try {
            JsonNode root = mapper.readTree(json);
            JsonNode rois = root.get("rois");
            if (rois == null || !rois.isArray()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "json に rois 配列がありません");
            }
            return rois.size();
        } catch (ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "json を解析できません", e);
        }
    }
}

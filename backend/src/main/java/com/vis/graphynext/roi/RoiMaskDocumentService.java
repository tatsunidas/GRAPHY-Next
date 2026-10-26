/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.roi;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Optional;

/**
 * 塗り ROI（マスク）の永続化。{@link RoiDocumentService} と同じく**中身を解釈しない**。
 * やるのは ①マスク 1 件 1 行の保管 ②楽観ロック ③壊れた入力・過大な入力の拒否 の 3 つだけ。
 */
@Service
public class RoiMaskDocumentService {

    /** 圧縮後の画素の上限。疎なマスクは小さく縮むので、これを超えるのは異常な入力か巨大な塗り。 */
    static final int MAX_FRAMES_BYTES = 64 * 1024 * 1024;

    private final RoiMaskDocumentRepository repository;
    private final ObjectMapper mapper = new ObjectMapper();

    public RoiMaskDocumentService(RoiMaskDocumentRepository repository) {
        this.repository = repository;
    }

    @Transactional(readOnly = true)
    public List<RoiMaskSummary> list(String patientKey) {
        return repository.findSummariesByPatientKey(requireText(patientKey, "patientKey"));
    }

    /** 画素。無ければ 404（一覧で見えたものが消えた＝別ウィンドウが削除した）。 */
    @Transactional(readOnly = true)
    public byte[] frames(String maskUid) {
        return repository.findById(requireText(maskUid, "maskUid"))
                .map(RoiMaskDocument::getFrames)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "マスクがありません"));
    }

    @Transactional
    public RoiMaskSummary save(String maskUid, String patientKey, String seriesUid, String meta, byte[] frames,
            int frameCount, Long version) {
        String uid = requireText(maskUid, "maskUid");
        String pk = requireText(patientKey, "patientKey");
        String series = requireText(seriesUid, "seriesUid");
        if (frames == null || frames.length == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "frames が空です");
        }
        if (frames.length > MAX_FRAMES_BYTES) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                    "frames が大きすぎます（上限 " + MAX_FRAMES_BYTES + " バイト）");
        }
        if (frameCount < 1) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "frameCount は 1 以上です");
        }
        requireJsonObject(meta);

        Optional<RoiMaskDocument> existing = repository.findById(uid);
        try {
            if (existing.isEmpty()) {
                if (version != null) {
                    // 版を持っているのに実体が無い＝別ウィンドウが削除した後。黙って作り直さない。
                    throw new ResponseStatusException(HttpStatus.CONFLICT,
                            "保存先が存在しません（別のウィンドウが削除した可能性があります）。読み直してください");
                }
                return summary(repository.saveAndFlush(new RoiMaskDocument(uid, pk, series, meta, frames, frameCount)));
            }
            RoiMaskDocument d = existing.get();
            if (!d.getPatientKey().equals(pk)) {
                // maskUid は UUID なので衝突しない。別患者の行を上書きしようとしているのは異常。
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "maskUid が別の患者のマスクと衝突しています");
            }
            if (version == null) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "既に保存があります。読み直して version を添えてください");
            }
            if (!version.equals(d.getVersion())) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "版が古いです（保存済み=" + d.getVersion() + " 要求=" + version + "）。読み直してください");
            }
            d.update(series, meta, frames, frameCount);
            return summary(repository.saveAndFlush(d));
        } catch (ObjectOptimisticLockingFailureException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "同時に保存されました。読み直してください", e);
        }
    }

    /** 無くても成功（削除は冪等。別ウィンドウが先に消していても利用者に見せる失敗ではない）。 */
    @Transactional
    public void delete(String maskUid, String patientKey) {
        String pk = requireText(patientKey, "patientKey");
        repository.findById(requireText(maskUid, "maskUid")).ifPresent(d -> {
            if (!d.getPatientKey().equals(pk)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "maskUid が別の患者のマスクです");
            }
            repository.delete(d);
        });
    }

    private RoiMaskSummary summary(RoiMaskDocument d) {
        return new RoiMaskSummary(d.getMaskUid(), d.getSeriesUid(), d.getMeta(), d.getFrameCount(),
                d.getFrameBytes(), d.getVersion(), d.getUpdatedAt());
    }

    private static String requireText(String v, String name) {
        if (v == null || v.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, name + " が必要です");
        }
        return v;
    }

    /** {@code meta} が JSON オブジェクトか（壊れた JSON を保管して次回の復元で初めて気付く事故を防ぐ）。 */
    private void requireJsonObject(String meta) {
        if (meta == null || meta.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "meta が空です");
        }
        try {
            if (!mapper.readTree(meta).isObject()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "meta は JSON オブジェクトです");
            }
        } catch (ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "meta を解析できません", e);
        }
    }
}

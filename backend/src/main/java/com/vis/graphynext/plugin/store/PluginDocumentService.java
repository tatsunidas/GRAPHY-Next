/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.store;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.Optional;
import java.util.regex.Pattern;

/**
 * プラグイン保存領域（H8）の永続化。
 *
 * <p>backend は**中身を解釈しない**。やるのは ①プラグイン×患者単位の保管
 * ②楽観ロックによる上書き事故の防止 ③壊れた JSON・巨大な入力の拒否 の 3 つだけ。
 *
 * <p><b>プラグイン id はフロントの host が入れる</b>（プラグインが自分で名乗るのではない）。
 * ただしプラグインは本体と同じ権限で動くため、REST を直接叩けば他プラグインの領域にも
 * 到達できる。**これは多層防御の 1 枚であって隔離ではない**
 * （サンドボックスは `fw/plugin-manager-design.md` §8 の P3 で未実装）。
 */
@Service
public class PluginDocumentService {

    /**
     * JSON 本文の上限。RECIST プラグインは ROI のクロップ画像（PNG を base64）を持つため
     * 1 患者で 1〜2MB になり得る。余裕を見つつ無制限にはしない。
     */
    static final int MAX_JSON_CHARS = 8 * 1024 * 1024;

    /** プラグイン id に許す形（マニフェストの id と同じ字種。経路に混ぜるので厳しめにする）。 */
    private static final Pattern PLUGIN_ID = Pattern.compile("[A-Za-z0-9._-]{1,64}");

    private final PluginDocumentRepository repository;
    private final ObjectMapper mapper = new ObjectMapper();

    public PluginDocumentService(PluginDocumentRepository repository) {
        this.repository = repository;
    }

    @Transactional(readOnly = true)
    public PluginDocumentDto get(String pluginId, String patientKey) {
        String p = requirePluginId(pluginId);
        String k = requirePatientKey(patientKey);
        Optional<PluginDocument> found = repository.findById(new PluginDocumentId(p, k));
        // 「まだ無い」は正常。空の器を返す（404 にしない）。
        return found.map(this::toDto).orElseGet(() -> new PluginDocumentDto(p, k, null, null, null));
    }

    @Transactional
    public PluginDocumentDto save(String pluginId, String patientKey, SavePluginDocumentRequest req) {
        String p = requirePluginId(pluginId);
        String k = requirePatientKey(patientKey);
        if (req == null || req.json() == null || req.json().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "json が空です");
        }
        if (req.json().length() > MAX_JSON_CHARS) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                    "json が大きすぎます（上限 " + MAX_JSON_CHARS + " 文字）");
        }
        requireParsable(req.json());

        PluginDocumentId id = new PluginDocumentId(p, k);
        Optional<PluginDocument> existing = repository.findById(id);
        try {
            if (existing.isEmpty()) {
                if (req.version() != null) {
                    // 版を持っているのに実体が無い＝別の誰かが削除した後。黙って作り直さない。
                    throw new ResponseStatusException(HttpStatus.CONFLICT,
                            "保存先が存在しません（削除された可能性があります）。読み直してください");
                }
                return toDto(repository.save(new PluginDocument(p, k, req.json())));
            }
            PluginDocument d = existing.get();
            if (req.version() == null) {
                // 読まずに上書きしようとしている。数か月分の評価記録を消し得るので拒否する。
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "既に保存があります。読み直して version を添えてください");
            }
            if (!req.version().equals(d.getVersion())) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "版が古いです（保存済み=" + d.getVersion() + " 要求=" + req.version() + "）。読み直してください");
            }
            d.update(req.json());
            return toDto(repository.saveAndFlush(d));
        } catch (ObjectOptimisticLockingFailureException e) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "同時に保存されました。読み直してください", e);
        }
    }

    @Transactional
    public void delete(String pluginId, String patientKey) {
        repository.deleteById(new PluginDocumentId(requirePluginId(pluginId), requirePatientKey(patientKey)));
    }

    private PluginDocumentDto toDto(PluginDocument d) {
        return new PluginDocumentDto(
                d.getId().getPluginId(),
                d.getId().getPatientKey(),
                d.getJson(),
                d.getUpdatedAt() == null ? null : d.getUpdatedAt().toString(),
                d.getVersion());
    }

    private String requirePluginId(String pluginId) {
        if (pluginId == null || !PLUGIN_ID.matcher(pluginId).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "pluginId が不正です");
        }
        return pluginId;
    }

    private String requirePatientKey(String patientKey) {
        if (patientKey == null || patientKey.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "patientKey が必要です");
        }
        if (patientKey.length() > 256) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "patientKey が長すぎます");
        }
        return patientKey;
    }

    /**
     * 構文検査だけ行う（中身は見ない）。**壊れた JSON を保管して、次に開いたときに初めて
     * 気付く**という事故を防ぐ。
     */
    private void requireParsable(String json) {
        try {
            mapper.readTree(json);
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "json を解析できません", e);
        }
    }
}

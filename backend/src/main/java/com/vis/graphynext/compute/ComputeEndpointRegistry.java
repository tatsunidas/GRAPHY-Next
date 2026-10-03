/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * 接続先の登録簿。<b>中身は Electron main が {@code /api/internal/compute/endpoints} で丸ごと入れる。</b>
 *
 * <p>🔴 <b>メモリにだけ持つ。</b> トークンをディスク・ログ・{@code /api/settings} に書かない
 * （正本は main の safeStorage）。backend が再起動したら main が入れ直す。
 *
 * <p>ここに無い宛先へは外向きの接続をしない（fw/remote-compute-design.md §4.3）——
 * 接続はすべて {@link #client} を通して作る。
 */
@Component
public class ComputeEndpointRegistry {

    /** {@code desktop/aiProviders.js} の {@code ID_RE} と同じ形。 */
    static final Pattern ID_RE = Pattern.compile("[a-z0-9-]{1,32}");
    static final int MAX_ENDPOINTS = 16;

    /** 1 件の接続先。{@code toString} にトークンは出ない（{@link JupyterEndpoint#toString()}）。 */
    public record Entry(String id, String label, JupyterEndpoint endpoint) {
    }

    /**
     * main から届く形。{@code kind} は {@code jupyter}（既定）か {@code colab}（確保済みのランタイム。
     * {@code url} と {@code token} は GetRuntime の connectionInfo）。
     */
    public record Incoming(String id, String label, String url, String token, String kind) {
        public Incoming(String id, String label, String url, String token) {
            this(id, label, url, token, null);
        }
    }

    private volatile Map<String, Entry> entries = Map.of();

    /**
     * 丸ごと入れ替える。1 件でも不正なら<b>何も変えずに</b>理由を返す（半端な状態を作らない）。
     *
     * @return 問題の一覧（空なら成功）
     */
    public List<String> replaceAll(List<Incoming> incoming) {
        List<String> problems = new ArrayList<>();
        Map<String, Entry> next = new LinkedHashMap<>();
        if (incoming == null) {
            incoming = List.of();
        }
        if (incoming.size() > MAX_ENDPOINTS) {
            return List.of("too-many-endpoints");
        }
        for (Incoming in : incoming) {
            if (in == null || in.id() == null || !ID_RE.matcher(in.id()).matches()) {
                problems.add("bad-id:" + (in == null ? null : in.id()));
                continue;
            }
            if (next.containsKey(in.id())) {
                problems.add("duplicate-id:" + in.id());
                continue;
            }
            try {
                JupyterEndpoint.Auth auth = "colab".equals(in.kind()) ? JupyterEndpoint.Auth.COLAB
                        : JupyterEndpoint.Auth.JUPYTER;
                if (in.kind() != null && !in.kind().equals("colab") && !in.kind().equals("jupyter")) {
                    throw new IllegalArgumentException("unknown kind " + in.kind());
                }
                JupyterEndpoint ep = JupyterEndpoint.of(in.url() == null ? "" : in.url(), in.token(), auth);
                String label = in.label() == null || in.label().isBlank() ? in.id() : in.label().strip();
                next.put(in.id(), new Entry(in.id(), label.length() > 64 ? label.substring(0, 64) : label, ep));
            } catch (IllegalArgumentException e) {
                problems.add("bad-url:" + in.id() + ":" + e.getMessage());
            }
        }
        if (problems.isEmpty()) {
            entries = Map.copyOf(next);
        }
        return problems;
    }

    public Optional<Entry> get(String id) {
        return Optional.ofNullable(id == null ? null : entries.get(id));
    }

    /** 登録順を保たないので、表示には main の一覧を使う（ここは backend 内部の参照用）。 */
    public List<Entry> all() {
        return List.copyOf(entries.values());
    }

    /** 登録済みの接続先へのクライアント。無ければ空。 */
    public Optional<JupyterServerClient> client(String id, com.fasterxml.jackson.databind.ObjectMapper mapper) {
        return get(id).map(e -> new JupyterServerClient(e.endpoint(), mapper));
    }
}

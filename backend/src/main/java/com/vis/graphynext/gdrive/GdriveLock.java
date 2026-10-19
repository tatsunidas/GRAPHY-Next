/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * 1 つの Drive バックアップを同時に使う端末を 1 台にする（排他）。
 *
 * <p>Drive には原子的な「作成できたら勝ち」が無い。そこで端末ごとに `lock-&lt;deviceId&gt;.json` を置き、
 * 置いたあとにもう一度一覧を見て、期限内の他端末のロックが先に（startedAt, deviceId の順で）あれば自分が降りる。
 * 同時に置いたときも順序が決まっているので、どちらか片方だけが残る。1 台ずつの運用を守るための best-effort で、
 * 強い排他ではない（端末の時計のずれはリース長に比べて小さい前提）。
 */
class GdriveLock {

    private static final ObjectMapper JSON = new ObjectMapper();
    static final String PREFIX = "lock-";

    /** 他端末のロック。 */
    record Holder(String deviceId, String host, long startedAt, long heartbeatAt, boolean live, String fileId) {
    }

    private final DriveClient client;
    private final Clock clock;
    private final long leaseMs;
    private final String parent;
    private final String deviceId;
    private final String host;
    private long startedAt;
    private String ownFileId;
    private long lastHeartbeat;

    GdriveLock(DriveClient client, Clock clock, long leaseMs, String parent, String deviceId, String host) {
        this.client = client;
        this.clock = clock;
        this.leaseMs = leaseMs;
        this.parent = parent;
        this.deviceId = deviceId;
        this.host = host == null ? "" : host;
    }

    private String ownName() {
        return PREFIX + deviceId + ".json";
    }

    /** 自分のロックを置けたら null。他端末が使っていれば、その端末。 */
    Holder acquire(boolean takeover) throws GdriveException {
        if (takeover) {
            for (Holder h : others()) {
                client.trash(h.fileId());
            }
        } else {
            Optional<Holder> live = others().stream().filter(Holder::live).min(ORDER);
            if (live.isPresent()) {
                return live.get();
            }
        }
        startedAt = clock.millis();
        write();
        if (!takeover) {
            // 同時に置いた相手がいないか。順序で先の相手がいれば自分が降りる
            for (Holder h : others()) {
                if (h.live() && ORDER.compare(h, self()) < 0) {
                    client.trash(ownFileId);
                    ownFileId = null;
                    return h;
                }
            }
        }
        return null;
    }

    /**
     * 期限が近づいたら更新する。自分のロックが消えていた（他端末に奪われた）ときは false。
     * 更新の前に必ず一覧で自分のロックの存在を確かめる。
     */
    boolean heartbeatIfDue() throws GdriveException {
        if (clock.millis() - lastHeartbeat < leaseMs / 3) {
            return true;
        }
        boolean present = client.listFiles(parent).stream().anyMatch(f -> f.name().equals(ownName()));
        if (!present) {
            ownFileId = null;
            return false;
        }
        for (Holder h : others()) {
            if (h.live() && ORDER.compare(h, self()) < 0) {
                return false;
            }
        }
        write();
        return true;
    }

    /** 終了時。失敗しても構わない（リースが切れれば他端末が使える）。 */
    void release() {
        try {
            if (ownFileId == null) {
                ownFileId = client.findByName(parent, ownName(), false).map(DriveClient.RemoteFile::id).orElse(null);
            }
            if (ownFileId != null) {
                client.trash(ownFileId);
                ownFileId = null;
            }
        } catch (GdriveException ignore) {
            // リース切れを待ってもらう
        }
    }

    private static final java.util.Comparator<Holder> ORDER = java.util.Comparator
            .comparingLong(Holder::startedAt).thenComparing(Holder::deviceId);

    private Holder self() {
        return new Holder(deviceId, host, startedAt, lastHeartbeat, true, ownFileId);
    }

    private List<Holder> others() throws GdriveException {
        List<Holder> out = new ArrayList<>();
        for (DriveClient.RemoteFile f : client.listFiles(parent)) {
            if (!f.name().startsWith(PREFIX) || !f.name().endsWith(".json") || f.name().equals(ownName())) {
                continue;
            }
            long hb = 0;
            long st = 0;
            String dev = f.name().substring(PREFIX.length(), f.name().length() - 5);
            String h = "";
            try {
                JsonNode n = JSON.readTree(client.readSmall(f.id()));
                hb = n.path("heartbeatAt").asLong(0);
                st = n.path("startedAt").asLong(0);
                h = n.path("host").asText("");
            } catch (IOException | GdriveException e) {
                // 読めないロックは期限切れ扱い（誰も止めない）
            }
            out.add(new Holder(dev, h, st, hb, hb + leaseMs > clock.millis(), f.id()));
        }
        return out;
    }

    private void write() throws GdriveException {
        lastHeartbeat = clock.millis();
        String body = JSON.createObjectNode().put("deviceId", deviceId).put("host", host).put("startedAt", startedAt)
                .put("heartbeatAt", lastHeartbeat).put("leaseMs", leaseMs).toString();
        try {
            Path tmp = Files.createTempFile("gdrive-lock", ".json");
            try {
                Files.writeString(tmp, body, StandardCharsets.UTF_8);
                if (ownFileId == null) {
                    ownFileId = client.findByName(parent, ownName(), false).map(DriveClient.RemoteFile::id).orElse(null);
                }
                ownFileId = client.upload(tmp, ownName(), parent, ownFileId, null, s -> { }).id();
            } finally {
                Files.deleteIfExists(tmp);
            }
        } catch (IOException e) {
            throw new GdriveException(GdriveException.Kind.FATAL, "lock-temp", e);
        }
    }
}

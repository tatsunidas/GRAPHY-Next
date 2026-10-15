/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * 索引（H2）のスナップショットを Drive の `index-snapshots/` へ置く。DICOM 本体は reconcile が送るので、
 * ここで守るのは索引だけ。索引を失っても DICOM から作り直せるが、レポートや ROI などの付随データは索引にしか無い。
 */
class GdriveSnapshots {

    /** 実行中の DB から 1 つの zip を作る（H2 の BACKUP TO）。 */
    interface IndexBackup {
        void backupTo(Path zip) throws Exception;
    }

    static final String FOLDER = "index-snapshots";
    static final String PREFIX = "graphy-index-";
    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'")
            .withZone(ZoneOffset.UTC);

    private final DriveClient client;
    private final IndexBackup backup;
    private final Clock clock;
    private final String parent;
    private final int keep;
    private String folderId;

    GdriveSnapshots(DriveClient client, IndexBackup backup, Clock clock, String parent, int keep) {
        this.client = client;
        this.backup = backup;
        this.clock = clock;
        this.parent = parent;
        this.keep = Math.max(1, keep);
    }

    private String folder() throws GdriveException {
        if (folderId == null) {
            folderId = client.ensureFolder(parent, FOLDER);
        }
        return folderId;
    }

    static String nameFor(long epochMs) {
        return PREFIX + STAMP.format(Instant.ofEpochMilli(epochMs)) + ".zip";
    }

    /** 名前から時刻を読む。形が違えば empty。 */
    static Optional<Long> timeOf(String name) {
        if (!name.startsWith(PREFIX) || !name.endsWith(".zip")) {
            return Optional.empty();
        }
        try {
            String s = name.substring(PREFIX.length(), name.length() - 4);
            return Optional.of(java.time.LocalDateTime.parse(s, DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'"))
                    .toInstant(ZoneOffset.UTC).toEpochMilli());
        } catch (java.time.format.DateTimeParseException e) {
            return Optional.empty();
        }
    }

    /** Drive にある一番新しいスナップショットの時刻。無ければ 0。 */
    long latestAt() throws GdriveException {
        return client.listFiles(folder()).stream().map(f -> timeOf(f.name())).flatMap(Optional::stream)
                .max(Long::compare).orElse(0L);
    }

    /** 作って送り、古い世代をゴミ箱へ移す。送った時刻を返す。 */
    long createAndUpload() throws GdriveException {
        long at = clock.millis();
        String name = nameFor(at);
        Path tmp = null;
        try {
            tmp = Files.createTempFile("gdrive-index", ".zip");
            Files.deleteIfExists(tmp); // BACKUP TO は既存ファイルを嫌う
            backup.backupTo(tmp);
            DriveClient.RemoteFile done = client.upload(tmp, name, folder(), null, null, s -> { });
            if (done.md5() == null || !done.md5().equalsIgnoreCase(GdriveSyncService.md5(tmp))) {
                client.trash(done.id());
                throw new GdriveException(GdriveException.Kind.RETRY, 0, "snapshot-md5-mismatch");
            }
        } catch (GdriveException e) {
            throw e;
        } catch (Exception e) {
            throw new GdriveException(GdriveException.Kind.FATAL, "snapshot-failed", e);
        } finally {
            try {
                if (tmp != null) {
                    Files.deleteIfExists(tmp);
                }
            } catch (IOException ignore) {
                // 一時ファイル
            }
        }
        prune();
        return at;
    }

    private void prune() throws GdriveException {
        List<DriveClient.RemoteFile> all = client.listFiles(folder()).stream()
                .filter(f -> timeOf(f.name()).isPresent())
                .sorted(Comparator.comparing((DriveClient.RemoteFile f) -> timeOf(f.name()).orElse(0L)).reversed())
                .toList();
        for (int i = keep; i < all.size(); i++) {
            client.trash(all.get(i).id()); // 完全削除はしない
        }
    }
}

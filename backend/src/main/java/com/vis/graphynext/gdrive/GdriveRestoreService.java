/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.net.http.HttpClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Clock;
import java.time.Duration;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Drive のバックアップから、<b>別の空の DB フォルダ</b>へ DICOM と索引を取り戻す。
 * 実行中の DB（H2）は開かない・触らない。終わったら main が通常の切替フローでそのフォルダを開く。
 *
 * <p>途中で止まっても、同じ操作をやり直せば続きから進む（md5 が合う既存ファイルは取り直さない）。
 * 取得したファイルは Drive が返す md5 と一致したときだけ置く。
 */
@Service
@Profile("standalone")
public class GdriveRestoreService {

    private static final Logger log = LoggerFactory.getLogger(GdriveRestoreService.class);
    /** 相対パスとして受け付ける形（{@code <study>/<series>/<sop>.dcm}）。名前の {@code ~} を {@code /} に戻す。 */
    private static final Pattern REL = Pattern.compile("[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\\.dcm");
    static final String MARKER = "graphy-db.json";

    public enum Phase { IDLE, RUNNING, DONE, FAILED }

    public record Progress(Phase phase, long total, long done, long skipped, boolean snapshotRestored, String error) {
    }

    private final String apiBase;
    private final String tokenUrl;
    private final Clock clock = Clock.systemUTC();
    private final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
            .connectTimeout(Duration.ofSeconds(15)).build();
    private final AtomicReference<Progress> progress = new AtomicReference<>(new Progress(Phase.IDLE, 0, 0, 0, false, null));
    private Thread worker;

    public GdriveRestoreService(@Value("${graphy.gdrive.api-base:https://www.googleapis.com}") String apiBase,
                                @Value("${graphy.gdrive.token-url:https://oauth2.googleapis.com/token}") String tokenUrl) {
        this.apiBase = apiBase;
        this.tokenUrl = tokenUrl;
    }

    public Progress progress() {
        return progress.get();
    }

    /** 空の DB フォルダ（目印だけ可）か。問題があれば理由、無ければ null。 */
    static String checkDest(Path dest) {
        if (dest == null || !dest.isAbsolute()) {
            return "dest-not-absolute";
        }
        if (!Files.isDirectory(dest)) {
            return "dest-not-found";
        }
        try (var s = Files.list(dest)) {
            if (s.anyMatch(p -> !p.getFileName().toString().equals(MARKER))) {
                return "dest-not-empty";
            }
        } catch (IOException e) {
            return "dest-unreadable";
        }
        return null;
    }

    /** 開始する。受け付けられなければ理由を返す（実行中・空でない・形の誤り）。成功は null。 */
    public synchronized String start(GdriveConfig source, Path dest) {
        return start(source, dest, false);
    }

    /**
     * {@code indexOnly}（モード A）: 索引のスナップショットだけを取り、DICOM は取らない（必要なときに取り寄せる）。
     * スナップショットが無ければ失敗（DICOM を取らないので、索引が無いと開ける物が無い）。
     */
    public synchronized String start(GdriveConfig source, Path dest, boolean indexOnly) {
        if (progress.get().phase() == Phase.RUNNING) {
            return "already-running";
        }
        String p = source.problem();
        if (p != null) {
            return p;
        }
        String d = checkDest(dest);
        if (d != null && !(d.equals("dest-not-empty") && resumable(dest))) {
            return d;
        }
        progress.set(new Progress(Phase.RUNNING, 0, 0, 0, false, null));
        worker = new Thread(() -> run(source, dest, indexOnly), "gdrive-restore");
        worker.setDaemon(true);
        worker.start();
        return null;
    }

    /** 前回の復元が途中で止まったフォルダ（dicom/ だけがある）なら、続きを許す。索引があれば許さない。 */
    private static boolean resumable(Path dest) {
        try (var s = Files.list(dest)) {
            return s.allMatch(p -> {
                String n = p.getFileName().toString();
                return n.equals(MARKER) || n.equals("dicom");
            });
        } catch (IOException e) {
            return false;
        }
    }

    /** テストから同期的に呼ぶ。 */
    void runSync(GdriveConfig source, Path dest) {
        runSync(source, dest, false);
    }

    void runSync(GdriveConfig source, Path dest, boolean indexOnly) {
        progress.set(new Progress(Phase.RUNNING, 0, 0, 0, false, null));
        run(source, dest, indexOnly);
    }

    private void run(GdriveConfig source, Path dest, boolean indexOnly) {
        try {
            GdriveTokenSource tokens = new GdriveTokenSource(http, tokenUrl, () -> source, clock);
            DriveClient client = new DriveClient(http, apiBase, tokens);
            Path dicomRoot = dest.resolve("dicom");
            Optional<DriveClient.RemoteFile> folder = client.findByName(source.folderId(), GdriveSyncService.DICOM_FOLDER, true);
            if (folder.isEmpty() && client.findByName(source.folderId(), GdriveSnapshots.FOLDER, true).isEmpty()) {
                // 親フォルダなど、バックアップでない所を選んだ。空の「完了」にしない
                throw new GdriveException(GdriveException.Kind.FATAL, 0, "not-backup-folder");
            }
            List<DriveClient.RemoteFile> files = folder.isPresent() && !indexOnly ? client.listFiles(folder.get().id()) : List.of();
            long total = files.size();
            long done = 0;
            long skipped = 0;
            update(Phase.RUNNING, total, done, skipped, false, null);
            for (DriveClient.RemoteFile f : files) {
                String rel = f.name().replace('~', '/');
                if (!REL.matcher(rel).matches() || rel.contains("..")) {
                    log.warn("[gdrive-restore] skipped unexpected name");
                    skipped++;
                    update(Phase.RUNNING, total, done, skipped, false, null);
                    continue;
                }
                Path target = dicomRoot.resolve(rel).normalize();
                if (!target.startsWith(dicomRoot)) {
                    skipped++;
                    continue;
                }
                if (Files.isRegularFile(target) && f.md5() != null && f.md5().equalsIgnoreCase(GdriveSyncService.md5(target))) {
                    done++; // 前回までに取得済み
                    update(Phase.RUNNING, total, done, skipped, false, null);
                    continue;
                }
                Path tmp = target.resolveSibling(target.getFileName() + ".verify");
                client.download(f.id(), tmp);
                if (f.md5() == null || !f.md5().equalsIgnoreCase(GdriveSyncService.md5(tmp))) {
                    Files.deleteIfExists(tmp);
                    throw new GdriveException(GdriveException.Kind.RETRY, 0, "md5-mismatch");
                }
                Files.createDirectories(target.getParent());
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
                done++;
                update(Phase.RUNNING, total, done, skipped, false, null);
            }
            boolean snap = restoreSnapshot(client, source.folderId(), dest);
            if (indexOnly && !snap) {
                throw new GdriveException(GdriveException.Kind.FATAL, 0, "no-snapshot");
            }
            update(Phase.DONE, total, done, skipped, snap, null);
        } catch (GdriveException e) {
            log.warn("[gdrive-restore] failed: {}", e.getMessage());
            Progress p = progress.get();
            update(Phase.FAILED, p.total(), p.done(), p.skipped(), false, e.getMessage());
        } catch (IOException | RuntimeException e) {
            log.warn("[gdrive-restore] failed", e);
            Progress p = progress.get();
            update(Phase.FAILED, p.total(), p.done(), p.skipped(), false, "io-error");
        }
    }

    /** 最新のスナップショットを展開する。無ければ false（DICOM だけ戻った状態。索引は取り込みで作り直せる）。 */
    private boolean restoreSnapshot(DriveClient client, String parent, Path dest) throws GdriveException, IOException {
        Optional<DriveClient.RemoteFile> folder = client.findByName(parent, GdriveSnapshots.FOLDER, true);
        if (folder.isEmpty()) {
            return false;
        }
        Optional<DriveClient.RemoteFile> latest = client.listFiles(folder.get().id()).stream()
                .filter(f -> GdriveSnapshots.timeOf(f.name()).isPresent())
                .max(Comparator.comparing(f -> GdriveSnapshots.timeOf(f.name()).orElse(0L)));
        if (latest.isEmpty()) {
            return false;
        }
        Path zip = Files.createTempFile("gdrive-restore", ".zip");
        try {
            client.download(latest.get().id(), zip);
            if (latest.get().md5() == null || !latest.get().md5().equalsIgnoreCase(GdriveSyncService.md5(zip))) {
                throw new GdriveException(GdriveException.Kind.RETRY, 0, "snapshot-md5-mismatch");
            }
            extract(zip, dest);
            return true;
        } finally {
            Files.deleteIfExists(zip);
        }
    }

    /** zip の中身を {@code dest} 直下へ。名前に区切りや {@code ..} を含む項目は受け付けない（zip-slip）。 */
    static void extract(Path zip, Path dest) throws IOException {
        // 先に全項目を検査してから書く（途中まで展開した索引を残さない）
        try (ZipInputStream in = new ZipInputStream(Files.newInputStream(zip))) {
            for (ZipEntry e; (e = in.getNextEntry()) != null; ) {
                String n = e.getName();
                if (!e.isDirectory() && (n.contains("/") || n.contains("\\") || n.contains("..") || n.isEmpty())) {
                    throw new IOException("unsafe-zip-entry");
                }
            }
        }
        try (ZipInputStream in = new ZipInputStream(Files.newInputStream(zip))) {
            for (ZipEntry e; (e = in.getNextEntry()) != null; ) {
                if (e.isDirectory()) {
                    continue;
                }
                Path target = dest.resolve(e.getName()).normalize();
                if (!target.getParent().equals(dest.normalize())) {
                    throw new IOException("unsafe-zip-entry");
                }
                copy(in, target);
            }
        }
    }

    private static void copy(InputStream in, Path target) throws IOException {
        Path part = target.resolveSibling(target.getFileName() + ".part");
        Files.copy(in, part, StandardCopyOption.REPLACE_EXISTING);
        Files.move(part, target, StandardCopyOption.REPLACE_EXISTING);
    }

    private void update(Phase ph, long total, long done, long skipped, boolean snap, String err) {
        progress.set(new Progress(ph, total, done, skipped, snap, err));
    }
}

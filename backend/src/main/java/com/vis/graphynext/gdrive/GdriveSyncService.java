/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.gdrive;

import com.vis.graphynext.dicom.store.StorageLayout;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;
import org.springframework.transaction.event.TransactionalEventListener;

import java.io.IOException;
import java.io.InputStream;
import java.net.http.HttpClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.DoubleSupplier;
import java.util.stream.Stream;

/**
 * 保管庫（{@code dicom/}）の変更を Drive へ増分で送る（モード B: ローカルが正本、Drive はバックアップ）。
 *
 * <p><b>正しさは reconcile が担う</b>（保管庫の全走査と台帳の突き合わせ）。{@link StorageChanged} は
 * 「早く気付く」ための加速で、取りこぼしても次の reconcile が拾う。ローカルのファイルには一切触れない。
 *
 * <p>Drive 上の置き場所: {@code <選ばれた親>/GRAPHY-DB-…/dicom/<study>~<series>~<sop>.dcm}（フラット）。
 * 同じ名前・同じ md5 のファイルが既にあれば、送らずに台帳へ取り込む（索引や台帳を失っても二重にならない）。
 */
@Service
@Profile("standalone")
public class GdriveSyncService {

    private static final Logger log = LoggerFactory.getLogger(GdriveSyncService.class);
    static final String DICOM_FOLDER = "dicom";
    private static final Set<String> SKIP_TOP = Set.of("incoming", ".import", ".cache");
    private static final long BACKOFF_BASE_MS = 5_000;
    private static final long BACKOFF_MAX_MS = 15 * 60_000;

    public enum State { DISABLED, CONNECTED, SYNCING, OFFLINE, NEEDS_LOGIN, NEEDS_ATTENTION }

    public record Status(State state, String reason, long pending, long blocked, long synced, Long lastSyncAt,
                         String lastError) {
    }

    private final GdriveSyncRepository repo;
    private final Path root;
    private final String apiBase;
    private final String tokenUrl;
    private final Clock clock;
    private final DoubleSupplier jitter;
    private final long intervalMs;
    private final long reconcileMs;
    private final boolean autoRun;
    private final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
            .connectTimeout(Duration.ofSeconds(15)).build();

    private final ConcurrentLinkedQueue<String> hints = new ConcurrentLinkedQueue<>();
    private final AtomicBoolean kickQueued = new AtomicBoolean();
    private ScheduledExecutorService executor;

    private volatile GdriveConfig config;
    private DriveClient client;
    private String dicomFolderId;
    private volatile boolean forceReconcile = true;
    private long lastReconcileAt;
    private volatile State state = State.DISABLED;
    private volatile String reason;
    private volatile String lastError;
    private volatile Long lastSyncAt;

    @Autowired
    public GdriveSyncService(GdriveSyncRepository repo, StorageLayout layout,
                             @Value("${graphy.gdrive.api-base:https://www.googleapis.com}") String apiBase,
                             @Value("${graphy.gdrive.token-url:https://oauth2.googleapis.com/token}") String tokenUrl,
                             @Value("${graphy.gdrive.interval-seconds:30}") long intervalSeconds,
                             @Value("${graphy.gdrive.reconcile-minutes:10}") long reconcileMinutes) {
        this(repo, layout.root(), apiBase, tokenUrl, Clock.systemUTC(), Math::random, intervalSeconds * 1000,
                reconcileMinutes * 60_000, true);
    }

    GdriveSyncService(GdriveSyncRepository repo, Path root, String apiBase, String tokenUrl, Clock clock,
                      DoubleSupplier jitter, long intervalMs, long reconcileMs, boolean autoRun) {
        this.repo = repo;
        this.root = root.toAbsolutePath().normalize();
        this.apiBase = apiBase;
        this.tokenUrl = tokenUrl;
        this.clock = clock;
        this.jitter = jitter;
        this.intervalMs = intervalMs;
        this.reconcileMs = reconcileMs;
        this.autoRun = autoRun;
    }

    // ── 設定・状態 ────────────────────────────────────────────────

    /** main から設定が届いた（null なら無効化）。台帳は、同期先のフォルダが変わったときだけ捨てる。 */
    public synchronized void configure(GdriveConfig cfg) {
        this.config = cfg;
        this.client = null;
        this.dicomFolderId = null;
        this.forceReconcile = true;
        this.lastError = null;
        this.reason = null;
        if (cfg == null) {
            state = State.DISABLED;
            return;
        }
        state = State.SYNCING;
        GdriveTokenSource tokens = new GdriveTokenSource(http, tokenUrl, () -> this.config, clock);
        this.client = new DriveClient(http, apiBase, tokens);
        if (autoRun) {
            if (executor == null) {
                executor = Executors.newSingleThreadScheduledExecutor(r -> {
                    Thread t = new Thread(r, "gdrive-sync");
                    t.setDaemon(true);
                    return t;
                });
                executor.scheduleWithFixedDelay(this::cycleSafe, intervalMs, intervalMs, java.util.concurrent.TimeUnit.MILLISECONDS);
            }
            kick();
        }
        log.info("[gdrive] enabled: {}", cfg);
    }

    public Status status() {
        GdriveConfig c = config;
        if (c == null) {
            return new Status(State.DISABLED, null, 0, 0, 0, null, null);
        }
        long pending = repo.countByFolderIdAndState(c.folderId(), GdriveSyncItem.PENDING)
                + repo.countByFolderIdAndState(c.folderId(), GdriveSyncItem.REMOVE);
        return new Status(state, reason, pending, repo.countByFolderIdAndState(c.folderId(), GdriveSyncItem.BLOCKED),
                repo.countByFolderIdAndState(c.folderId(), GdriveSyncItem.SYNCED), lastSyncAt, lastError);
    }

    /** 今すぐ全走査して同期する（止まっている項目も再試行する）。 */
    public void syncNow() {
        forceReconcile = true;
        kick();
    }

    @TransactionalEventListener(fallbackExecution = true)
    public void onStorageChanged(StorageChanged e) {
        if (config == null || e.relPath() == null) {
            return;
        }
        hints.add(e.relPath());
        kick();
    }

    private void kick() {
        if (!autoRun || executor == null || !kickQueued.compareAndSet(false, true)) {
            return;
        }
        executor.execute(() -> {
            kickQueued.set(false);
            cycleSafe();
        });
    }

    @PreDestroy
    void shutdown() {
        if (executor != null) {
            executor.shutdownNow();
        }
    }

    // ── 1 周期 ────────────────────────────────────────────────────

    private void cycleSafe() {
        try {
            cycle();
        } catch (RuntimeException e) {
            // 周期が例外で止まると二度と動かない（scheduleWithFixedDelay は例外で打ち切られる）
            log.warn("[gdrive] cycle failed unexpectedly", e);
            lastError = "internal-error";
        }
    }

    /** テストからも呼ぶ。1 周期ぶん（必要なら reconcile → 送信）を同期的に行う。 */
    synchronized void cycle() {
        GdriveConfig c = config;
        if (c == null || client == null) {
            return;
        }
        String problem = c.problem();
        if (problem != null) {
            state = State.NEEDS_ATTENTION;
            reason = problem;
            return;
        }
        try {
            if (dicomFolderId == null) {
                dicomFolderId = client.ensureFolder(c.folderId(), DICOM_FOLDER);
            }
            repo.deleteOtherFolders(c.folderId());
            long now = clock.millis();
            if (forceReconcile || now - lastReconcileAt >= reconcileMs) {
                reconcile(c.folderId(), forceReconcile);
                forceReconcile = false;
                lastReconcileAt = now;
            }
            applyHints(c.folderId());
            processQueue(c.folderId());
            long blocked = repo.countByFolderIdAndState(c.folderId(), GdriveSyncItem.BLOCKED);
            long pending = repo.countByFolderIdAndState(c.folderId(), GdriveSyncItem.PENDING)
                    + repo.countByFolderIdAndState(c.folderId(), GdriveSyncItem.REMOVE);
            if (blocked > 0) {
                state = State.NEEDS_ATTENTION;
                reason = "blocked-items";
            } else if (pending > 0) {
                state = State.SYNCING;
                reason = null;
            } else {
                state = State.CONNECTED;
                reason = null;
                lastError = null;
                lastSyncAt = clock.millis();
            }
        } catch (GdriveException e) {
            lastError = e.getMessage();
            switch (e.kind()) {
                case OFFLINE, RETRY -> {
                    state = State.OFFLINE;
                    reason = null;
                }
                case RELOGIN -> {
                    state = State.NEEDS_LOGIN;
                    reason = null;
                }
                case QUOTA -> {
                    state = State.NEEDS_ATTENTION;
                    reason = "quota";
                }
                default -> {
                    state = State.NEEDS_ATTENTION;
                    reason = "drive-error";
                    dicomFolderId = null; // 親フォルダが消された等。次の周期で探し直す
                }
            }
            log.info("[gdrive] cycle stopped: {} ({})", state, e.getMessage());
        }
    }

    // ── 台帳の突き合わせ ──────────────────────────────────────────

    private record Local(long size, long mtime) {
    }

    static String encodeName(String rel) {
        return rel.replace('/', '~');
    }

    private Map<String, Local> scan() {
        Map<String, Local> out = new HashMap<>();
        if (!Files.isDirectory(root)) {
            return out;
        }
        try (Stream<Path> s = Files.walk(root)) {
            s.filter(p -> {
                Path rel = root.relativize(p);
                if (rel.getNameCount() == 0) {
                    return false;
                }
                if (SKIP_TOP.contains(rel.getName(0).toString())) {
                    return false;
                }
                for (Path seg : rel) {
                    if (seg.toString().startsWith(".") || seg.toString().contains("~")) {
                        return false;
                    }
                }
                return Files.isRegularFile(p);
            }).forEach(p -> {
                try {
                    out.put(root.relativize(p).toString().replace('\\', '/'),
                            new Local(Files.size(p), Files.getLastModifiedTime(p).toMillis()));
                } catch (IOException ignore) {
                    // 走査中に消えた。次の reconcile で拾う
                }
            });
        } catch (IOException e) {
            throw new java.io.UncheckedIOException(e);
        }
        return out;
    }

    void reconcile(String folderId, boolean retryBlocked) {
        Map<String, Local> local = scan();
        Map<String, GdriveSyncItem> rows = new HashMap<>();
        repo.findByFolderId(folderId).forEach(r -> rows.put(r.getRelPath(), r));
        List<GdriveSyncItem> dirty = new ArrayList<>();
        List<GdriveSyncItem> gone = new ArrayList<>();
        for (Map.Entry<String, Local> e : local.entrySet()) {
            GdriveSyncItem r = rows.get(e.getKey());
            Local l = e.getValue();
            if (r == null) {
                r = new GdriveSyncItem(e.getKey(), folderId, GdriveSyncItem.PENDING);
                r.setSize(l.size());
                r.setMtime(l.mtime());
                dirty.add(r);
            } else if (GdriveSyncItem.REMOVE.equals(r.getState())) {
                requeue(r, l);
                r.setDriveFileId(null); // ゴミ箱へ移す途中か済み。作り直す（まだ生きていれば名前検索で拾う）
                dirty.add(r);
            } else if (r.getSize() != l.size() || r.getMtime() != l.mtime()
                    || (retryBlocked && GdriveSyncItem.BLOCKED.equals(r.getState()))) {
                requeue(r, l);
                dirty.add(r);
            }
        }
        for (GdriveSyncItem r : rows.values()) {
            if (local.containsKey(r.getRelPath()) || GdriveSyncItem.BLOCKED.equals(r.getState())
                    || GdriveSyncItem.REMOVE.equals(r.getState())) {
                continue;
            }
            if (r.getDriveFileId() == null) {
                gone.add(r);
            } else {
                r.setState(GdriveSyncItem.REMOVE);
                r.setAttempts(0);
                r.setNextAttemptAt(0);
                dirty.add(r);
            }
        }
        repo.saveAll(dirty);
        repo.deleteAll(gone);
    }

    private static void requeue(GdriveSyncItem r, Local l) {
        r.setSize(l.size());
        r.setMtime(l.mtime());
        r.setState(GdriveSyncItem.PENDING);
        r.setAttempts(0);
        r.setNextAttemptAt(0);
        r.setSessionUri(null);
        r.setMd5(null);
        r.setLastError(null);
    }

    private void applyHints(String folderId) {
        String polled;
        while ((polled = hints.poll()) != null) {
            final String rel = polled;
            Path f = root.resolve(rel).normalize();
            if (!f.startsWith(root) || rel.contains("~") || rel.startsWith(".")) {
                continue;
            }
            Optional<GdriveSyncItem> existing = repo.findById(rel);
            try {
                if (Files.isRegularFile(f)) {
                    GdriveSyncItem r = existing.orElseGet(() -> new GdriveSyncItem(rel, folderId, GdriveSyncItem.PENDING));
                    if (GdriveSyncItem.REMOVE.equals(r.getState())) {
                        r.setDriveFileId(null);
                    }
                    requeue(r, new Local(Files.size(f), Files.getLastModifiedTime(f).toMillis()));
                    repo.save(r);
                } else if (existing.isPresent() && existing.get().getDriveFileId() != null
                        && !GdriveSyncItem.BLOCKED.equals(existing.get().getState())) {
                    GdriveSyncItem r = existing.get();
                    r.setState(GdriveSyncItem.REMOVE);
                    r.setAttempts(0);
                    r.setNextAttemptAt(0);
                    repo.save(r);
                } else {
                    existing.ifPresent(repo::delete);
                }
            } catch (IOException ignore) {
                // 次の reconcile で拾う
            }
        }
    }

    // ── 送信 ──────────────────────────────────────────────────────

    private void processQueue(String folderId) throws GdriveException {
        for (GdriveSyncItem item : repo.due(folderId, clock.millis())) {
            try {
                if (GdriveSyncItem.REMOVE.equals(item.getState())) {
                    remove(item);
                } else {
                    upload(item);
                }
            } catch (GdriveException e) {
                switch (e.kind()) {
                    case OFFLINE -> {
                        fail(item, e);
                        throw e; // つながらないのに全件叩かない
                    }
                    case RETRY -> fail(item, e);
                    case RELOGIN, QUOTA -> throw e;
                    default -> block(item, e);
                }
            }
        }
    }

    private void upload(GdriveSyncItem item) throws GdriveException {
        Path f = root.resolve(item.getRelPath());
        if (!Files.isRegularFile(f)) {
            if (item.getDriveFileId() == null) {
                repo.delete(item);
            } else {
                item.setState(GdriveSyncItem.REMOVE);
                repo.save(item);
            }
            return;
        }
        long size;
        long mtime;
        try {
            size = Files.size(f);
            mtime = Files.getLastModifiedTime(f).toMillis();
            if (item.getMd5() == null || size != item.getSize() || mtime != item.getMtime()) {
                item.setSize(size);
                item.setMtime(mtime);
                item.setMd5(md5(f));
                item.setSessionUri(null);
            }
        } catch (IOException e) {
            throw new GdriveException(GdriveException.Kind.RETRY, "local-read", e);
        }
        String name = encodeName(item.getRelPath());
        if (item.getDriveFileId() == null) {
            Optional<DriveClient.RemoteFile> ex = client.findByName(dicomFolderId, name, false);
            if (ex.isPresent()) {
                if (item.getMd5().equalsIgnoreCase(ex.get().md5())) {
                    markSynced(item, ex.get().id());
                    return;
                }
                item.setDriveFileId(ex.get().id());
                item.setSessionUri(null);
            }
        }
        DriveClient.RemoteFile done;
        try {
            done = client.upload(f, name, dicomFolderId, item.getDriveFileId(), item.getSessionUri(), s -> {
                item.setSessionUri(s);
                repo.save(item);
            });
        } catch (GdriveException e) {
            if (e.kind() == GdriveException.Kind.NOT_FOUND && item.getDriveFileId() != null) {
                // Drive 側で消された・ゴミ箱へ入れられた。作り直す
                item.setDriveFileId(null);
                item.setSessionUri(null);
                item.setNextAttemptAt(0);
                repo.save(item);
                return;
            }
            throw e;
        }
        if (!item.getMd5().equalsIgnoreCase(done.md5())) {
            item.setSessionUri(null);
            throw new GdriveException(GdriveException.Kind.RETRY, 0, "md5-mismatch");
        }
        try {
            if (Files.size(f) != size || Files.getLastModifiedTime(f).toMillis() != mtime) {
                // 送っている間に変わった。同期済みにせず、次の周期で送り直す
                item.setDriveFileId(done.id());
                item.setMd5(null);
                item.setSessionUri(null);
                repo.save(item);
                return;
            }
        } catch (IOException e) {
            throw new GdriveException(GdriveException.Kind.RETRY, "local-read", e);
        }
        markSynced(item, done.id());
    }

    private void markSynced(GdriveSyncItem item, String driveFileId) {
        item.setDriveFileId(driveFileId);
        item.setState(GdriveSyncItem.SYNCED);
        item.setAttempts(0);
        item.setNextAttemptAt(0);
        item.setSessionUri(null);
        item.setLastError(null);
        repo.save(item);
    }

    private void remove(GdriveSyncItem item) throws GdriveException {
        if (item.getDriveFileId() != null) {
            client.trash(item.getDriveFileId());
        }
        repo.delete(item);
    }

    private void fail(GdriveSyncItem item, GdriveException e) {
        int n = item.getAttempts() + 1;
        item.setAttempts(n);
        long backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS << Math.min(n - 1, 12));
        item.setNextAttemptAt(clock.millis() + (long) (backoff * (0.8 + 0.4 * jitter.getAsDouble())));
        item.setLastError(e.getMessage());
        repo.save(item);
    }

    private void block(GdriveSyncItem item, GdriveException e) {
        item.setState(GdriveSyncItem.BLOCKED);
        item.setLastError(e.getMessage());
        repo.save(item);
        log.warn("[gdrive] blocked {}: {}", item.getRelPath(), e.getMessage());
    }

    static String md5(Path f) throws IOException {
        try (InputStream in = Files.newInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                md.update(buf, 0, n);
            }
            return HexFormat.of().formatHex(md.digest());
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}

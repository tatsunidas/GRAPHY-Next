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
public class GdriveSyncService implements com.vis.graphynext.dicom.store.StorageBackend {

    private static final Logger log = LoggerFactory.getLogger(GdriveSyncService.class);
    static final String DICOM_FOLDER = "dicom";
    private static final Set<String> SKIP_TOP = Set.of("incoming", ".import", ".cache");
    private static final long BACKOFF_BASE_MS = 5_000;
    private static final long BACKOFF_MAX_MS = 15 * 60_000;

    public enum State { DISABLED, CONNECTED, SYNCING, OFFLINE, NEEDS_LOGIN, NEEDS_ATTENTION }

    /** {@code mode}: "backup"（ローカル正本）/ "cache"（Drive 正本）。{@code cache*} と {@code localCount} は cache のときだけ意味がある。 */
    public record Status(State state, String reason, long pending, long blocked, long synced, Long lastSyncAt,
                         String lastError, String lockedBy, Long lastSnapshotAt, String mode, long cacheBytes,
                         long cacheLimitBytes, long localCount, long evictedCount, long adopted, long usableBytes) {
    }

    /** 「すべてローカルに保存」の進み具合。phase: IDLE / RUNNING / DONE / FAILED / CANCELLED。 */
    public record LocalizeProgress(String phase, long total, long done, long failed, long bytesTotal, String error) {
    }

    /** Drive だけにあったファイルを索引へ載せる（取り込み）。テストでは差し替える。 */
    interface Indexer {
        void ingest(Path file) throws IOException;
    }

    /** 全件保存の前に、空きに残しておく余裕（{@code DbTransferService} と同じ値）。 */
    static final long FREE_SPACE_MARGIN = 64L * 1024 * 1024;

    /** 直近にこの時間内に読まれたファイルは追い出さない（返した Path を後で開く経路があるため）。 */
    static final long RECENT_ACCESS_MS = 10 * 60_000;
    private static final int EVICT_BATCH = 2000;

    private final GdriveSyncRepository repo;
    private final Path root;
    private final String apiBase;
    private final String tokenUrl;
    private final Clock clock;
    private final DoubleSupplier jitter;
    private final long intervalMs;
    private final long reconcileMs;
    private final boolean autoRun;
    private final GdriveSnapshots.IndexBackup indexBackup;
    private final long leaseMs;
    private final long snapshotIntervalMs;
    private final int snapshotKeep;
    private final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
            .connectTimeout(Duration.ofSeconds(15)).build();

    private final ConcurrentLinkedQueue<String> hints = new ConcurrentLinkedQueue<>();
    private final AtomicBoolean kickQueued = new AtomicBoolean();
    private ScheduledExecutorService executor;

    private volatile GdriveConfig config;
    private volatile DriveClient client; // 取り寄せ（読み出しのスレッド）からも使う
    private String dicomFolderId;
    private volatile boolean forceReconcile = true;
    private long lastReconcileAt;
    private volatile State state = State.DISABLED;
    private volatile String reason;
    private volatile String lastError;
    private volatile Long lastSyncAt;
    private GdriveLock lock;
    private boolean lockHeld;
    private volatile boolean takeover;
    private volatile String lockedBy;
    private GdriveSnapshots snapshots;
    private volatile long lastSnapshotAt = -1; // -1＝Drive の一覧からまだ読んでいない
    private long lastSnapshotAttemptAt;
    private volatile Indexer indexer;
    private final java.util.concurrent.atomic.AtomicLong adopted = new java.util.concurrent.atomic.AtomicLong();
    private final java.util.concurrent.atomic.AtomicReference<LocalizeProgress> localize =
            new java.util.concurrent.atomic.AtomicReference<>(new LocalizeProgress("IDLE", 0, 0, 0, 0, null));
    /** 全件保存の実行中・完了後は追い出さない（取った端から消えないように）。設定が変わる（切替・解除）か解放するまで続く。 */
    private volatile boolean holdLocal;
    private volatile boolean localizeCancel;
    java.util.function.LongSupplier usableSpace = this::realUsableSpace; // テストで差し替える

    private long realUsableSpace() {
        try {
            return Files.getFileStore(root).getUsableSpace();
        } catch (IOException e) {
            return 0;
        }
    }
    /** 読まれた時刻（周期ごとに台帳へ書く。読み出しのたびに DB を更新しない）。 */
    private final java.util.concurrent.ConcurrentHashMap<String, Long> accessed = new java.util.concurrent.ConcurrentHashMap<>();

    @Autowired
    public GdriveSyncService(GdriveSyncRepository repo, StorageLayout layout, org.springframework.jdbc.core.JdbcTemplate jdbc,
                             @Value("${graphy.gdrive.api-base:https://www.googleapis.com}") String apiBase,
                             @Value("${graphy.gdrive.token-url:https://oauth2.googleapis.com/token}") String tokenUrl,
                             @Value("${graphy.gdrive.interval-seconds:30}") long intervalSeconds,
                             @Value("${graphy.gdrive.reconcile-minutes:10}") long reconcileMinutes,
                             @Value("${graphy.gdrive.lock-lease-minutes:10}") long leaseMinutes,
                             @Value("${graphy.gdrive.snapshot-interval-minutes:60}") long snapshotMinutes,
                             @Value("${graphy.gdrive.snapshot-keep:3}") int snapshotKeep,
                             org.springframework.beans.factory.ObjectProvider<com.vis.graphynext.dicom.store.DicomStorageService> storage) {
        this(repo, layout.root(), apiBase, tokenUrl, Clock.systemUTC(), Math::random, intervalSeconds * 1000,
                reconcileMinutes * 60_000, true, zip -> jdbc.execute("BACKUP TO '" + zip.toString().replace("'", "''") + "'"),
                leaseMinutes * 60_000, snapshotMinutes * 60_000, snapshotKeep);
        this.indexer = file -> storage.getObject().ingest(file);
        layout.setBackend(this); // 読み出し（resolveForRead）が、手元に無いファイルを取り寄せる口として使う
    }

    GdriveSyncService(GdriveSyncRepository repo, Path root, String apiBase, String tokenUrl, Clock clock,
                      DoubleSupplier jitter, long intervalMs, long reconcileMs, boolean autoRun,
                      GdriveSnapshots.IndexBackup indexBackup, long leaseMs, long snapshotIntervalMs, int snapshotKeep) {
        this.indexBackup = indexBackup;
        this.leaseMs = leaseMs;
        this.snapshotIntervalMs = snapshotIntervalMs;
        this.snapshotKeep = snapshotKeep;
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
        if (lock != null && lockHeld) {
            lock.release();
        }
        this.client = null;
        this.lock = null;
        this.lockHeld = false;
        this.lockedBy = null;
        this.takeover = false;
        this.snapshots = null;
        this.lastSnapshotAt = -1;
        this.dicomFolderId = null;
        this.forceReconcile = true;
        this.lastError = null;
        this.reason = null;
        this.holdLocal = false;
        this.localizeCancel = true; // 実行中の全件保存があれば止める（設定が変わったので）
        this.adopted.set(0);
        if (cfg == null) {
            state = State.DISABLED;
            return;
        }
        state = State.SYNCING;
        GdriveTokenSource tokens = new GdriveTokenSource(http, tokenUrl, () -> this.config, clock);
        this.client = new DriveClient(http, apiBase, tokens);
        this.lock = new GdriveLock(client, clock, leaseMs, cfg.folderId(), cfg.deviceId(), cfg.host());
        this.snapshots = new GdriveSnapshots(client, indexBackup, clock, cfg.folderId(), snapshotKeep);
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
            return new Status(State.DISABLED, null, 0, 0, 0, null, null, null, null, null, 0, 0, 0, 0, 0, 0);
        }
        long pending = repo.countByFolderIdAndState(c.folderId(), GdriveSyncItem.PENDING)
                + repo.countByFolderIdAndState(c.folderId(), GdriveSyncItem.REMOVE);
        return new Status(state, reason, pending, repo.countByFolderIdAndState(c.folderId(), GdriveSyncItem.BLOCKED),
                repo.countByFolderIdAndState(c.folderId(), GdriveSyncItem.SYNCED), lastSyncAt, lastError, lockedBy,
                lastSnapshotAt > 0 ? lastSnapshotAt : null, c.cache() ? "cache" : "backup",
                c.cache() ? repo.localBytes(c.folderId()) : 0, c.cache() ? c.cacheLimitBytes() : 0,
                c.cache() ? repo.localCount(c.folderId()) : 0, repo.countByFolderIdAndEvictedTrue(c.folderId()), adopted.get(),
                c.cache() ? usableSpace.getAsLong() : 0);
    }

    @Override
    public boolean cacheMode() {
        GdriveConfig c = config;
        return c != null && c.cache();
    }

    /** ファイルが読まれた（モード A の追い出しの順序に使う）。安い呼び出し。 */
    @Override
    public void touch(String relPath) {
        if (cacheMode() && relPath != null) {
            accessed.put(relPath, clock.millis());
        }
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

    /** 他端末が使用中でも、その端末のロックを外して使い始める（利用者が確認したあとに呼ぶ）。 */
    public void takeOver() {
        takeover = true;
        kick();
    }

    @PreDestroy
    void shutdown() {
        if (executor != null) {
            executor.shutdownNow();
        }
        if (prefetchPool != null) {
            prefetchPool.shutdownNow();
        }
        shutdownWork();
    }

    /** 終了時の後始末（ベストエフォート）: 最後の索引スナップショットとロックの解放。つながらなければ諦める。 */
    synchronized void shutdownWork() {
        if (config == null || !lockHeld) {
            return;
        }
        try {
            if (repo.countByFolderIdAndState(config.folderId(), GdriveSyncItem.PENDING) == 0) {
                lastSnapshotAt = snapshots.createAndUpload();
            }
        } catch (GdriveException | RuntimeException e) {
            log.info("[gdrive] exit snapshot skipped: {}", e.getMessage());
        }
        lock.release();
        lockHeld = false;
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
        if (c.refreshToken() == null || c.refreshToken().isBlank()) {
            state = State.NEEDS_LOGIN;
            reason = null;
            return;
        }
        try {
            if (dicomFolderId == null) {
                dicomFolderId = client.ensureFolder(c.folderId(), DICOM_FOLDER);
            }
            if (!ensureLock()) {
                return;
            }
            repo.deleteOtherFolders(c.folderId());
            long now = clock.millis();
            if (forceReconcile || now - lastReconcileAt >= reconcileMs) {
                reconcile(c.folderId(), forceReconcile);
                if (c.cache()) {
                    adoptRemoteStrays(c.folderId());
                }
                forceReconcile = false;
                lastReconcileAt = now;
            }
            applyHints(c.folderId());
            processQueue(c.folderId());
            if (c.cache()) {
                flushAccess();
                evict(c.folderId(), c.cacheLimitBytes());
            }
            maybeSnapshot(c.folderId());
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

    /** 排他。使える状態なら true。他端末が使用中・奪われたときは状態を立てて false。 */
    private boolean ensureLock() throws GdriveException {
        if (!lockHeld) {
            GdriveLock.Holder h = lock.acquire(takeover);
            takeover = false;
            if (h != null) {
                state = State.NEEDS_ATTENTION;
                reason = "locked-by-other";
                lockedBy = h.host().isBlank() ? h.deviceId() : h.host();
                return false;
            }
            lockHeld = true;
            lockedBy = null;
            return true;
        }
        if (!lock.heartbeatIfDue()) {
            lockHeld = false;
            state = State.NEEDS_ATTENTION;
            reason = "lock-lost";
            return false;
        }
        return true;
    }

    /** 待ちが空で、前回から間が空いていれば索引のスナップショットを送る。失敗しても 5 分は再試行しない。 */
    private void maybeSnapshot(String folderId) throws GdriveException {
        if (repo.countByFolderIdAndState(folderId, GdriveSyncItem.PENDING)
                + repo.countByFolderIdAndState(folderId, GdriveSyncItem.REMOVE) > 0) {
            return; // 索引が、まだ Drive に無いファイルを指す状態のスナップショットは作らない
        }
        long now = clock.millis();
        if (lastSnapshotAt < 0) {
            lastSnapshotAt = snapshots.latestAt();
        }
        if (now - lastSnapshotAt < snapshotIntervalMs || now - lastSnapshotAttemptAt < 300_000) {
            return;
        }
        lastSnapshotAttemptAt = now;
        lastSnapshotAt = snapshots.createAndUpload();
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
            } else if (r.isEvicted()) {
                // 追い出したはずの実体が手元にある（利用者が戻した・取得した）。台帳の印を外す
                r.setEvicted(false);
                if (r.getSize() != l.size() || r.getMtime() != l.mtime()) {
                    requeue(r, l);
                }
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
            if (r.isEvicted()) {
                continue; // 追い出し済み: 手元に無くて正常（Drive が正本）。消された扱いにしない
            }
            if (cacheMode() && r.getDriveFileId() != null) {
                // モード A では、手元に無いことは削除を意味しない（削除は利用者の操作で明示的に伝わる）。
                // Drive に正本があるので、追い出し済みとして扱い、必要なときに取得する
                r.setEvicted(true);
                r.setState(GdriveSyncItem.SYNCED);
                r.setAttempts(0);
                r.setSessionUri(null);
                dirty.add(r);
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
                    r.setEvicted(false);
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
            } else if (cacheMode()) {
                item.setEvicted(true); // 手元に無い。Drive の内容が正本（削除ではない）
                item.setState(GdriveSyncItem.SYNCED);
                item.setSessionUri(null);
                repo.save(item);
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
        item.setEvicted(false);
        item.setLastAccessAt(clock.millis());
        repo.save(item);
    }

    void setIndexer(Indexer indexer) {
        this.indexer = indexer;
    }

    // ── Drive だけにあるファイルの取り込み（モード A） ─────────────────────────────

    /** Drive 上のファイル名（{@code <study>~<series>~<sop>.dcm}）から保管庫の相対パスへ。形が違えば null。 */
    static String decodeName(String name) {
        if (name == null || !name.endsWith(".dcm") || name.indexOf('~') < 0) {
            return null;
        }
        String rel = name.replace('~', '/');
        for (String seg : rel.split("/", -1)) {
            if (seg.isEmpty() || seg.startsWith(".")) {
                return null;
            }
        }
        return rel;
    }

    /**
     * 台帳に無い Drive のファイル（別の PC が最後のスナップショットのあとに足した、または索引を失った）を、
     * 取得して索引へ載せる。索引に載らないファイルが Drive にだけ在る状態を残さない。
     * 取り込みは通常の経路なので、台帳には「手元にある・Drive と md5 が同じ」として載り、送り直しは起きない。
     * 1 件の失敗（壊れたファイルなど）は飛ばして続ける。つながらないときは例外（周期の状態が OFFLINE になる）。
     */
    private void adoptRemoteStrays(String folderId) throws GdriveException {
        Indexer idx = indexer;
        if (idx == null || dicomFolderId == null) {
            return;
        }
        java.util.Set<String> known = new java.util.HashSet<>();
        repo.findByFolderId(folderId).forEach(r -> known.add(r.getRelPath()));
        for (DriveClient.RemoteFile f : client.listFiles(dicomFolderId)) {
            String rel = decodeName(f.name());
            if (rel == null || known.contains(rel) || f.md5() == null) {
                continue;
            }
            Path tmp = null;
            try {
                tmp = Files.createTempFile("gdrive-adopt", ".dcm");
                client.download(f.id(), tmp);
                if (!f.md5().equalsIgnoreCase(md5(tmp))) {
                    log.warn("[gdrive] adopt skipped (md5 mismatch): {}", rel);
                    continue;
                }
                idx.ingest(tmp);
                adopted.incrementAndGet();
            } catch (IOException | RuntimeException e) {
                log.warn("[gdrive] adopt failed: {} ({})", rel, e.toString());
            } finally {
                if (tmp != null) {
                    deleteQuietly(tmp);
                }
            }
        }
    }

    // ── すべてローカルに保存（モード A → 手元を正本にする前の準備） ─────────────────

    public LocalizeProgress localizeProgress() {
        return localize.get();
    }

    /** 全件保存を始める。受け付けられなければ理由（空き容量不足など）。成功は null。 */
    public synchronized String startLocalize() {
        GdriveConfig c = config;
        if (c == null || !c.cache()) {
            return "not-cache-mode";
        }
        if ("RUNNING".equals(localize.get().phase())) {
            return "already-running";
        }
        List<GdriveSyncItem> rows = new ArrayList<>(repo.findByFolderIdAndEvictedTrue(c.folderId()));
        long need = rows.stream().mapToLong(GdriveSyncItem::getSize).sum();
        if (need + FREE_SPACE_MARGIN > usableSpace.getAsLong()) {
            return "not-enough-space"; // 何も取らない
        }
        holdLocal = true;
        localizeCancel = false;
        localize.set(new LocalizeProgress("RUNNING", rows.size(), 0, 0, need, null));
        Thread t = new Thread(() -> runLocalize(rows, need), "gdrive-localize");
        t.setDaemon(true);
        t.start();
        return null;
    }

    /** 取り消し、追い出しの停止も解く。すでに取った分は手元に残る。 */
    public void cancelLocalize() {
        localizeCancel = true;
        holdLocal = false;
    }

    private void runLocalize(List<GdriveSyncItem> rows, long bytes) {
        long done = 0;
        long failed = 0;
        String error = null;
        java.util.concurrent.ExecutorService pool = prefetchPool();
        final int window = 16; // 窓ごとに止める機会を作る（つながらないのに全件を叩かない）
        for (int i = 0; i < rows.size() && !localizeCancel; i += window) {
            List<java.util.concurrent.Future<?>> jobs = new ArrayList<>();
            for (GdriveSyncItem r : rows.subList(i, Math.min(rows.size(), i + window))) {
                jobs.add(pool.submit(() -> ensureLocal(r.getRelPath())));
            }
            boolean stop = false;
            for (java.util.concurrent.Future<?> j : jobs) {
                try {
                    j.get();
                    done++;
                } catch (java.util.concurrent.ExecutionException e) {
                    failed++;
                    String reason = e.getCause() instanceof com.vis.graphynext.dicom.store.StorageUnavailableException su
                            ? su.reason() : com.vis.graphynext.dicom.store.StorageUnavailableException.DRIVE_ERROR;
                    if (error == null) {
                        error = reason;
                    }
                    if (reason.equals(com.vis.graphynext.dicom.store.StorageUnavailableException.OFFLINE)
                            || reason.equals(com.vis.graphynext.dicom.store.StorageUnavailableException.NEEDS_LOGIN)
                            || reason.equals(com.vis.graphynext.dicom.store.StorageUnavailableException.DISABLED)) {
                        stop = true; // 次の窓へ進まない
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    stop = true;
                }
            }
            localize.set(new LocalizeProgress("RUNNING", rows.size(), done, failed, bytes, error));
            if (stop) {
                break;
            }
        }
        String phase = localizeCancel ? "CANCELLED" : (failed > 0 || done < rows.size() ? "FAILED" : "DONE");
        localize.set(new LocalizeProgress(phase, rows.size(), done, failed, bytes, error));
    }

    // ── 取り寄せ（モード A: 読み出しから呼ばれる。cycle() とは別のスレッド） ──────────────

    private final java.util.concurrent.ConcurrentHashMap<String, Object> fetchLocks = new java.util.concurrent.ConcurrentHashMap<>();
    private static final int PREFETCH_THREADS = 4;
    private java.util.concurrent.ExecutorService prefetchPool;

    /**
     * 手元に無ければ Drive から取り寄せる。台帳が「追い出し済み」としているものだけが対象で、それ以外は null。
     * 同じファイルへの同時要求は 1 回だけ取得する。取得したら md5 とサイズを台帳と照合し、
     * mtime を台帳の値に戻す（そうしないと reconcile が「変わった」と取り違えて送り直す）。
     */
    @Override
    public Path ensureLocal(String rel) {
        Path dest = root.resolve(rel).normalize();
        if (!dest.startsWith(root)) {
            return null;
        }
        GdriveSyncItem row = repo.findById(rel).orElse(null);
        if (row == null || !row.isEvicted()) {
            return Files.isRegularFile(dest) ? dest : null;
        }
        Object lock = fetchLocks.computeIfAbsent(rel, k -> new Object());
        try {
            synchronized (lock) {
                row = repo.findById(rel).orElse(null); // 待っている間に別のスレッドが取得したかもしれない
                if (row == null || !row.isEvicted()) {
                    return Files.isRegularFile(dest) ? dest : null;
                }
                fetch(row, dest);
                return dest;
            }
        } finally {
            fetchLocks.remove(rel);
        }
    }

    private void fetch(GdriveSyncItem row, Path dest) {
        GdriveConfig c = config;
        DriveClient cl = client;
        if (c == null || cl == null || !row.getFolderId().equals(c.folderId())) {
            throw new com.vis.graphynext.dicom.store.StorageUnavailableException(
                    com.vis.graphynext.dicom.store.StorageUnavailableException.DISABLED);
        }
        if (row.getDriveFileId() == null) {
            throw new com.vis.graphynext.dicom.store.StorageUnavailableException(
                    com.vis.graphynext.dicom.store.StorageUnavailableException.NOT_ON_DRIVE);
        }
        if (row.getMd5() == null) {
            // 照合できないものは置かない（壊れた内容を黙って画像として返さない）
            throw new com.vis.graphynext.dicom.store.StorageUnavailableException(
                    com.vis.graphynext.dicom.store.StorageUnavailableException.NO_CHECKSUM);
        }
        // 走査（reconcile）に見えない名前（先頭が "."）へ落として検証し、検証済みのものだけを本来の名前へ移す
        Path tmp = dest.resolveSibling("." + dest.getFileName() + ".fetch");
        try {
            cl.download(row.getDriveFileId(), tmp);
            if (Files.size(tmp) != row.getSize() || !row.getMd5().equalsIgnoreCase(md5(tmp))) {
                Files.deleteIfExists(tmp);
                throw new com.vis.graphynext.dicom.store.StorageUnavailableException(
                        com.vis.graphynext.dicom.store.StorageUnavailableException.MD5_MISMATCH);
            }
            Files.setLastModifiedTime(tmp, java.nio.file.attribute.FileTime.fromMillis(row.getMtime()));
            Files.move(tmp, dest, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        } catch (GdriveException e) {
            deleteQuietly(tmp);
            String reason = switch (e.kind()) {
                case OFFLINE, RETRY -> com.vis.graphynext.dicom.store.StorageUnavailableException.OFFLINE;
                case RELOGIN -> com.vis.graphynext.dicom.store.StorageUnavailableException.NEEDS_LOGIN;
                case NOT_FOUND -> com.vis.graphynext.dicom.store.StorageUnavailableException.NOT_ON_DRIVE;
                default -> com.vis.graphynext.dicom.store.StorageUnavailableException.DRIVE_ERROR;
            };
            throw new com.vis.graphynext.dicom.store.StorageUnavailableException(reason, e);
        } catch (IOException e) {
            deleteQuietly(tmp);
            throw new com.vis.graphynext.dicom.store.StorageUnavailableException(
                    com.vis.graphynext.dicom.store.StorageUnavailableException.DRIVE_ERROR, e);
        }
        row.setEvicted(false);
        row.setLastAccessAt(clock.millis());
        repo.save(row);
    }

    private static void deleteQuietly(Path p) {
        try {
            Files.deleteIfExists(p);
        } catch (IOException ignore) {
            // 次の取得で上書きする
        }
    }

    /** 複数を並列（4 本）で先に取り寄せる。1 件でも失敗したら、最初の失敗を投げる。 */
    @Override
    public void prefetch(java.util.Collection<String> rels, java.util.function.BooleanSupplier cancelled) {
        if (rels.isEmpty()) {
            return;
        }
        java.util.concurrent.ExecutorService pool = prefetchPool();
        java.util.List<java.util.concurrent.Future<?>> jobs = new ArrayList<>();
        for (String rel : rels) {
            jobs.add(pool.submit(() -> {
                if (!cancelled.getAsBoolean()) {
                    ensureLocal(rel);
                }
            }));
        }
        RuntimeException first = null;
        for (java.util.concurrent.Future<?> j : jobs) {
            try {
                j.get();
            } catch (java.util.concurrent.ExecutionException e) {
                if (first == null) {
                    first = e.getCause() instanceof RuntimeException re ? re
                            : new com.vis.graphynext.dicom.store.StorageUnavailableException(
                                    com.vis.graphynext.dicom.store.StorageUnavailableException.DRIVE_ERROR, e.getCause());
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new com.vis.graphynext.dicom.store.StorageUnavailableException(
                        com.vis.graphynext.dicom.store.StorageUnavailableException.OFFLINE, e);
            }
        }
        if (first != null) {
            throw first;
        }
    }

    private synchronized java.util.concurrent.ExecutorService prefetchPool() {
        if (prefetchPool == null) {
            prefetchPool = Executors.newFixedThreadPool(PREFETCH_THREADS, r -> {
                Thread t = new Thread(r, "gdrive-fetch");
                t.setDaemon(true);
                return t;
            });
        }
        return prefetchPool;
    }

    private void flushAccess() {
        for (String rel : new ArrayList<>(accessed.keySet())) {
            Long at = accessed.remove(rel);
            if (at == null) {
                continue;
            }
            repo.findById(rel).ifPresent(r -> {
                if (at > r.getLastAccessAt()) {
                    r.setLastAccessAt(at);
                    repo.save(r);
                }
            });
        }
    }

    /**
     * 手元の使用量が上限を超えていたら、Drive に載っている（SYNCED）古いものから手元の実体を消す。
     * 🔴 Drive には触れない。未送信・失敗中・直近に読まれたものは消さない。
     */
    private void evict(String folderId, long limit) {
        if (holdLocal) {
            return;
        }
        long used = repo.localBytes(folderId);
        if (used <= limit) {
            return;
        }
        long cutoff = clock.millis() - RECENT_ACCESS_MS;
        for (GdriveSyncItem item : repo.evictable(folderId, cutoff, org.springframework.data.domain.PageRequest.of(0, EVICT_BATCH))) {
            if (used <= limit) {
                break;
            }
            Path f = root.resolve(item.getRelPath()).normalize();
            if (!f.startsWith(root)) {
                continue;
            }
            try {
                if (Files.isRegularFile(f)) {
                    if (Files.size(f) != item.getSize() || Files.getLastModifiedTime(f).toMillis() != item.getMtime()) {
                        continue; // 同期のあとで変わった。reconcile が送り直す。消さない
                    }
                    Files.delete(f);
                }
                item.setEvicted(true);
                repo.save(item);
                used -= item.getSize();
            } catch (IOException e) {
                log.warn("[gdrive] evict failed: {} ({})", item.getRelPath(), e.toString());
            }
        }
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

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.dbadmin.DbAdminService;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.nifti.NiftiImportService;
import com.vis.graphynext.nifti.NiftiToDicom;
import com.vis.graphynext.settings.SettingsService;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 監視フォルダの定期走査（standalone のみ）。設定したフォルダを一定間隔で走査し、<b>大きさと更新時刻が 2 回続けて
 * 同じ</b>になったファイルだけを既存の {@link ImportService#importPaths} へ渡す（書き込み途中のファイルを拾わない）。
 * 取り込みそのものは新しく書かない。したがって保管庫・索引・Google Drive への増分送信（{@code StorageChanged}）は
 * 手動の取り込みと同じ経路を通り、Drive がオフライン・未ログインでも、取り込みはローカルに対して常に成功する
 * （送信は同期が後で行う）。
 *
 * <p>処理済みは台帳（{@link ImportWatchItem}）で管理し、同じ大きさ・更新時刻なら二度と取り込まない。
 * 原本は読むだけで、移動も削除もしない。設定は走査のたびに読むので、変更は再起動なしで次の走査から効く。
 *
 * <p>Web モードでは Bean を作らない: 設定 API は利用者が書けるので、監視先を任意のパスにされると
 * サーバーのファイルを保管庫へ取り込める経路になる。
 */
@Service
@Profile("standalone")
public class ImportWatchService {

    private static final Logger log = LoggerFactory.getLogger(ImportWatchService.class);

    public static final String KEY_ENABLED = SettingsService.IMPORT_WATCH_PREFIX + "enabled";
    public static final String KEY_FOLDER = SettingsService.IMPORT_WATCH_PREFIX + "folder";
    public static final String KEY_INTERVAL = SettingsService.IMPORT_WATCH_PREFIX + "intervalSec";
    /** 納品フォルダの CSV で、DICOM の患者属性も上書きするか（既定 false。患者の取り違えにつながるため）。 */
    public static final String KEY_CSV_OVERWRITE_DICOM = SettingsService.IMPORT_WATCH_PREFIX + "csvOverwriteDicom";

    /** 画面に出す失敗の件数（表示の上限。台帳には全件残る）。 */
    static final int FAILURES_SHOWN = 20;
    /** 設定が変わったことに気付くまでの周期。走査の間隔そのものは設定の intervalSec。 */
    private static final long TICK_MS = 1_000;

    public record Failure(String path, String error) {
    }

    /**
     * @param error 設定または走査の異常（コード。{@code folder-missing}・{@code folder-not-found}・
     *     {@code folder-not-directory}・{@code folder-overlaps-db}・{@code interval-invalid}・{@code scan-failed}）。
     *     正常なら null。異常でもアプリは動き続ける。
     * @param waiting 見つけたが、大きさ・更新時刻がまだ 2 回続けて同じになっていないファイル数。
     * @param changed 取り込み済みの NIfTI が後から変わったのを検知した数（再取り込みはしない）。
     * @param held 取り込まずに保留しているファイル数（理由は {@code heldItems}。条件が変われば再判定する）。
     */
    public record Status(boolean enabled, String folder, Integer intervalSec, boolean csvOverwriteDicom,
                         boolean scanning, Long lastScanAt,
                         int waiting, long imported, long skipped, long failed, long changed, long held,
                         String error, List<Failure> failures, List<Failure> heldItems) {
    }

    private record Config(boolean enabled, String folder, Integer intervalSec, boolean csvOverwriteDicom) {
    }

    private final ImportService importService;
    private final NiftiImportService niftiImport;
    private final DbAdminService dbAdmin;
    private final DicomInstanceRepository instanceRepo;
    private final ImportWatchRepository repo;
    private final SettingsService settings;
    private final StorageLayout layout;
    private final Clock clock;
    private ScheduledExecutorService executor;

    /** 前回の走査で見た未処理ファイルの（大きさ, 更新時刻）。同じなら今回は「止まった」とみなす。 */
    private Map<String, long[]> seen = new HashMap<>();
    /** 前回の走査でのユニット（納品フォルダ）ごとの中身の署名。同じなら「納品が止まった」とみなす。 */
    private Map<String, String> unitSigs = new HashMap<>();
    private volatile boolean scanning;
    private volatile Long lastScanAt;
    private volatile int waiting;
    private volatile String scanError;

    @Autowired
    public ImportWatchService(ImportService importService, NiftiImportService niftiImport, DbAdminService dbAdmin,
                              DicomInstanceRepository instanceRepo, ImportWatchRepository repo,
                              SettingsService settings, StorageLayout layout,
                              @Value("${graphy.import-watch.auto-run:true}") boolean autoRun) {
        this(importService, niftiImport, dbAdmin, instanceRepo, repo, settings, layout, Clock.systemUTC(), autoRun);
    }

    ImportWatchService(ImportService importService, NiftiImportService niftiImport, DbAdminService dbAdmin,
                       DicomInstanceRepository instanceRepo, ImportWatchRepository repo,
                       SettingsService settings, StorageLayout layout, Clock clock, boolean autoRun) {
        this.importService = importService;
        this.niftiImport = niftiImport;
        this.dbAdmin = dbAdmin;
        this.instanceRepo = instanceRepo;
        this.repo = repo;
        this.settings = settings;
        this.layout = layout;
        this.clock = clock;
        if (autoRun) {
            executor = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "import-watch");
                t.setDaemon(true);
                return t;
            });
            executor.scheduleWithFixedDelay(this::tickSafe, TICK_MS, TICK_MS, TimeUnit.MILLISECONDS);
        }
    }

    @PreDestroy
    void shutdown() {
        if (executor != null) {
            executor.shutdownNow();
        }
    }

    private void tickSafe() {
        try {
            Config cfg = readConfig();
            if (!cfg.enabled() || cfg.intervalSec() == null || cfg.intervalSec() < 1) {
                return;
            }
            Long last = lastScanAt;
            if (last == null || clock.millis() - last >= cfg.intervalSec() * 1000L) {
                scanOnce();
            }
        } catch (RuntimeException e) {
            log.warn("監視取り込みの周期処理に失敗しました（続行）", e);
        }
    }

    private Config readConfig() {
        Map<String, String> all = settings.getAll();
        boolean enabled = Boolean.parseBoolean(all.getOrDefault(KEY_ENABLED, "false"));
        String folder = all.get(KEY_FOLDER);
        Integer interval = null;
        try {
            String v = all.get(KEY_INTERVAL);
            if (v != null && !v.isBlank()) {
                interval = Integer.valueOf(v.trim());
            }
        } catch (NumberFormatException ignore) {
            // 不正な値は interval-invalid として画面に出す
        }
        boolean overwrite = Boolean.parseBoolean(all.getOrDefault(KEY_CSV_OVERWRITE_DICOM, "false"));
        return new Config(enabled, folder == null ? null : folder.trim(), interval, overwrite);
    }

    /** 設定の異常（コード）か、正常なら null。走査のたび・状態の問い合わせのたびに評価する。 */
    private String validate(Config cfg) {
        if (cfg.intervalSec() == null || cfg.intervalSec() < 1) {
            return "interval-invalid";
        }
        if (cfg.folder() == null || cfg.folder().isBlank()) {
            return "folder-missing";
        }
        Path p;
        try {
            p = Path.of(cfg.folder());
        } catch (InvalidPathException e) {
            return "folder-not-found";
        }
        if (!Files.exists(p)) {
            return "folder-not-found";
        }
        if (!Files.isDirectory(p)) {
            return "folder-not-directory";
        }
        // 保管庫を含む DB フォルダの中、または DB フォルダを含む場所を監視すると、取り込んだ物を取り込み直す輪になる
        Path store = realOrAbsolute(layout.root());
        Path parent = store.getParent();
        Path db = parent != null && parent.getNameCount() > 0 ? parent : store;
        Path real = realOrAbsolute(p);
        if (real.startsWith(db) || db.startsWith(real)) {
            return "folder-overlaps-db";
        }
        return null;
    }

    private static Path realOrAbsolute(Path p) {
        try {
            return p.toRealPath();
        } catch (IOException e) {
            return p.toAbsolutePath().normalize();
        }
    }

    public Status status() {
        Config cfg = readConfig();
        String error = null;
        if (cfg.enabled()) {
            error = validate(cfg);
            if (error == null) {
                error = scanError;
            }
        }
        List<Failure> failures = repo.findTop20ByStatusOrderByAtDesc(ImportWatchItem.FAILED).stream()
                .limit(FAILURES_SHOWN).map(i -> new Failure(i.getPath(), i.getError())).toList();
        List<Failure> heldItems = repo.findTop20ByStatusOrderByAtDesc(ImportWatchItem.HELD).stream()
                .limit(FAILURES_SHOWN).map(i -> new Failure(i.getPath(), i.getError())).toList();
        return new Status(cfg.enabled(), cfg.folder(), cfg.intervalSec(), cfg.csvOverwriteDicom(), scanning, lastScanAt,
                waiting,
                repo.countByStatus(ImportWatchItem.IMPORTED), repo.countByStatus(ImportWatchItem.SKIPPED),
                repo.countByStatus(ImportWatchItem.FAILED), repo.countByStatus(ImportWatchItem.CHANGED),
                repo.countByStatus(ImportWatchItem.HELD), error, failures, heldItems);
    }

    /** 1 回走査する。無効なら何もしない（最終走査の時刻も進めない）。テストと「今すぐ走査」から直接呼べる。 */
    public synchronized Status scanOnce() {
        Config cfg = readConfig();
        if (!cfg.enabled()) {
            return status();
        }
        scanning = true;
        try {
            scanError = null;
            if (validate(cfg) == null) {
                scan(Path.of(cfg.folder()).toAbsolutePath().normalize());
            }
        } catch (RuntimeException e) {
            scanError = "scan-failed";
            log.warn("監視フォルダの走査に失敗しました（続行）: {}", e.toString());
        } finally {
            lastScanAt = clock.millis();
            scanning = false;
        }
        return status();
    }

    private record FileInfo(Path path, long size, long mtime) {
    }

    private void scan(Path folder) {
        Map<String, ImportWatchItem> ledger = new HashMap<>();
        for (ImportWatchItem i : repo.findAll()) {
            ledger.put(i.getPath(), i);
        }
        // 1. 走査して、納品の単位（ユニット）ごとに集める。ユニット＝監視フォルダ直下のサブフォルダ（中は再帰）。
        //    監視フォルダ直下のファイルは、そのファイル 1 つが 1 ユニット。
        Map<String, List<FileInfo>> units = new java.util.LinkedHashMap<>();
        try {
            Files.walkFileTree(folder, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    return importService.isSkippedDir(dir) ? FileVisitResult.SKIP_SUBTREE : FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    if (attrs.isRegularFile()) { // リンク等は辿らない
                        Path rel = folder.relativize(file.toAbsolutePath().normalize());
                        String unit = rel.getNameCount() > 1 ? rel.getName(0).toString() : rel.toString();
                        units.computeIfAbsent(unit, k -> new ArrayList<>())
                                .add(new FileInfo(file.toAbsolutePath().normalize(), attrs.size(),
                                        attrs.lastModifiedTime().toMillis()));
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(Path file, IOException e) {
                    record(file.toAbsolutePath().normalize().toString(), -1, 0, ImportWatchItem.FAILED, e.toString(),
                            ledger);
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            scanError = "scan-failed";
            log.warn("監視フォルダを走査できませんでした（続行）: {}", e.toString());
        }
        // 2. ユニットごとに処理する。1 つのファイル・ユニットの異常で、他の処理を止めない。
        Map<String, long[]> nextSeen = new HashMap<>();
        Map<String, String> nextSigs = new HashMap<>();
        Map<String, CachedCsv> nextCsv = new HashMap<>();
        Map<String, Map<String, String>> toApply = new java.util.LinkedHashMap<>();
        boolean overwrite = readConfig().csvOverwriteDicom();
        for (Map.Entry<String, List<FileInfo>> u : units.entrySet()) {
            String sig = signature(u.getValue());
            nextSigs.put(u.getKey(), sig);
            boolean unitStable = sig.equals(unitSigs.get(u.getKey()));
            UnitCsv csv = unitCsv(folder, folder.resolve(u.getKey()), u.getValue(), nextCsv);
            UnitCtx ctx = new UnitCtx(folder, unitStable, csv, overwrite, toApply);
            for (FileInfo f : u.getValue()) {
                try {
                    visit(f, ctx, ledger, nextSeen);
                } catch (RuntimeException e) {
                    record(f.path().toString(), f.size(), f.mtime(), ImportWatchItem.FAILED, e.toString(), ledger);
                }
            }
        }
        applyCsvToStudies(toApply);
        csvCache = nextCsv;
        seen = nextSeen;
        unitSigs = nextSigs;
        waiting = nextSeen.size();
    }

    /** ユニットの中身（相対パス・大きさ・更新時刻）の署名。順序に依らない。 */
    private static String signature(List<FileInfo> files) {
        long h = 1125899906842597L;
        for (FileInfo f : files) {
            long x = (f.path().toString() + '|' + f.size() + '|' + f.mtime()).hashCode();
            h += x * 0x9E3779B97F4A7C15L; // 順序に依らない和
        }
        return files.size() + ":" + h;
    }

    private static boolean isNifti(Path file) {
        String n = file.getFileName().toString().toLowerCase(java.util.Locale.ROOT);
        return n.endsWith(".nii") || n.endsWith(".nii.gz");
    }

    /** {@code a.nii.gz}・{@code a.nii} → {@code a}。 */
    private static String niftiBaseName(Path file) {
        String n = file.getFileName().toString();
        String l = n.toLowerCase(java.util.Locale.ROOT);
        return n.substring(0, n.length() - (l.endsWith(".nii.gz") ? 7 : 4));
    }

    private static Path sidecarOf(Path nifti) {
        return nifti.resolveSibling(niftiBaseName(nifti) + ".json");
    }

    /** 対になる NIfTI がある {@code .json}（サイドカー）か。 */
    private static boolean isSidecar(Path file) {
        String n = file.getFileName().toString();
        if (!n.toLowerCase(java.util.Locale.ROOT).endsWith(".json")) {
            return false;
        }
        String base = n.substring(0, n.length() - 5);
        return Files.isRegularFile(file.resolveSibling(base + ".nii")) || Files.isRegularFile(file.resolveSibling(base + ".nii.gz"));
    }

    /** ユニット（納品フォルダ）の被験者 CSV の状態。 */
    private record UnitCsv(boolean present, Map<String, String> values, String error) {
        static final UnitCsv NONE = new UnitCsv(false, Map.of(), null);
    }

    private record CachedCsv(long size, long mtime, UnitCsv csv) {
    }

    private record UnitCtx(Path root, boolean stable, UnitCsv csv, boolean overwrite,
                           Map<String, Map<String, String>> toApply) {
    }

    private Map<String, CachedCsv> csvCache = new HashMap<>();

    /** ユニット直下の {@code *.csv}。ちょうど 1 つなら読む（大きさ・更新時刻が変わったときだけ読み直す）。 */
    private UnitCsv unitCsv(Path root, Path unitDir, List<FileInfo> files, Map<String, CachedCsv> nextCache) {
        List<FileInfo> csvs = files.stream().filter(f -> isUnitCsv(root, f.path())).toList();
        if (csvs.isEmpty() || !unitDir.getParent().equals(root)) {
            return UnitCsv.NONE;
        }
        if (csvs.size() > 1) {
            return new UnitCsv(true, Map.of(), ImportWatchCsv.ERR_MULTIPLE);
        }
        FileInfo f = csvs.get(0);
        String key = f.path().toString();
        CachedCsv c = csvCache.get(key);
        if (c == null || c.size() != f.size() || c.mtime() != f.mtime()) {
            UnitCsv parsed;
            try {
                ImportWatchCsv.Parsed p = ImportWatchCsv.parse(
                        new String(Files.readAllBytes(f.path()), java.nio.charset.StandardCharsets.UTF_8));
                parsed = new UnitCsv(true, p.values(), p.error());
            } catch (IOException | RuntimeException e) {
                parsed = new UnitCsv(true, Map.of(), ImportWatchCsv.ERR_UNREADABLE);
            }
            c = new CachedCsv(f.size(), f.mtime(), parsed);
        }
        nextCache.put(key, c);
        return c.csv();
    }

    /** 監視フォルダ直下のサブフォルダの直下にある {@code .csv}（被験者 CSV）か。 */
    private static boolean isUnitCsv(Path root, Path file) {
        Path parent = file.getParent();
        return file.getFileName().toString().toLowerCase(java.util.Locale.ROOT).endsWith(".csv")
                && parent != null && parent.getParent() != null && parent.getParent().equals(root);
    }

    private void visit(FileInfo f, UnitCtx ctx, Map<String, ImportWatchItem> ledger,
                       Map<String, long[]> nextSeen) {
        String key = f.path().toString();
        long size = f.size();
        long mtime = f.mtime();
        boolean unitStable = ctx.stable();
        if (isSidecar(f.path()) || isUnitCsv(ctx.root(), f.path())) {
            return; // NIfTI のペアと、納品フォルダの被験者 CSV。台帳にも待機にも数えない
        }
        boolean nifti = isNifti(f.path());
        ImportWatchItem done = ledger.get(key);
        boolean same = done != null && done.getSize() == size && done.getMtime() == mtime;
        if (same && !ImportWatchItem.HELD.equals(done.getStatus())) {
            return; // 処理済み（同じ大きさ・更新時刻）
        }
        if (nifti && done != null && !same && (ImportWatchItem.IMPORTED.equals(done.getStatus())
                || ImportWatchItem.CHANGED.equals(done.getStatus()))) {
            // 取り込み済みの NIfTI が変わった。取り込み直すと新しい UID のシリーズが増えるので、検知だけ記録する
            record(key, size, mtime, ImportWatchItem.CHANGED, null, ledger);
            return;
        }
        boolean held = same; // 保留中のファイルは、ファイル単位の安定は済んでいる
        if (!held) {
            long[] prev = seen.get(key);
            if (prev == null || prev[0] != size || prev[1] != mtime) {
                nextSeen.put(key, new long[] {size, mtime}); // 初見、または書き込み中: 待機
                return;
            }
        }
        // NIfTI と、CSV で DICOM を上書きする設定のときの DICOM は、納品（サイドカー・CSV）が揃うのを待つ
        boolean needsUnit = nifti || ctx.overwrite();
        if (needsUnit && !unitStable) {
            if (!held) {
                nextSeen.put(key, new long[] {size, mtime}); // 納品（サイドカーなど）が揃うのを待つ
            }
            return;
        }
        String status;
        String error = null;
        try {
            if (nifti) {
                ImportOutcome o = importNifti(f.path(), ctx.csv());
                status = o.status();
                error = o.error();
            } else if (ctx.overwrite() && ctx.csv().present() && ctx.csv().error() != null) {
                status = ImportWatchItem.HELD; // CSV が無効なので、上書きできるようになるまで取り込まない
                error = "csv-invalid:" + ctx.csv().error();
            } else {
                ImportService.ImportResult r = importService.importPaths(List.of(key));
                if (r.imported() > 0) {
                    status = ImportWatchItem.IMPORTED;
                    if (ctx.overwrite() && ctx.csv().present() && !ctx.csv().values().isEmpty()) {
                        for (String study : r.studyInstanceUids()) {
                            ctx.toApply().put(study, ctx.csv().values());
                        }
                    }
                } else if (r.failed() > 0) {
                    status = ImportWatchItem.FAILED;
                    error = reason(key, r.errors().isEmpty() ? null : r.errors().get(0));
                } else {
                    status = ImportWatchItem.SKIPPED;
                }
            }
        } catch (RuntimeException e) {
            status = ImportWatchItem.FAILED;
            error = e.toString();
        }
        if (ImportWatchItem.HELD.equals(status)) {
            if (done == null || !ImportWatchItem.HELD.equals(done.getStatus()) || !java.util.Objects.equals(done.getError(), error)
                    || !same) {
                log.warn("取り込みを保留しました（走査は続行）: {} 理由={}", key, error);
                record(key, size, mtime, status, error, ledger);
            }
            return;
        }
        record(key, size, mtime, status, error, ledger);
    }

    private record ImportOutcome(String status, String error) {
    }

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final List<String> PATIENT_KEYS = List.of("PatientID", "PatientName", "PatientBirthDate", "PatientSex");

    /** NIfTI を取り込む。患者情報（ID か名前）が無ければ保留。 */
    private ImportOutcome importNifti(Path file, UnitCsv csv) {
        try {
            NiftiToDicom.readHeader(file); // NIfTI として読めないものは、患者情報の有無より先に失敗にする
        } catch (IOException | RuntimeException e) {
            return new ImportOutcome(ImportWatchItem.FAILED, "not-nifti: " + e.getMessage());
        }
        if (csv.present() && csv.error() != null) {
            // CSV が無効のうちは取り込まない（取り込むと台帳に残り、CSV を直しても値が付かないため）
            return new ImportOutcome(ImportWatchItem.HELD, "csv-invalid:" + csv.error());
        }
        Map<String, Object> sidecar = readSidecar(file);
        // 患者情報は CSV が優先、無ければサイドカー。どちらも検査済みの値だけ使う
        String id = first(csv.values().get("PatientID"),
                PatientFields.ifValid(PatientFields.clean(sidecar.get("PatientID")), PatientFields::validLo));
        String name = first(csv.values().get("PatientName"),
                PatientFields.ifValid(PatientFields.clean(sidecar.get("PatientName")), PatientFields::validPn));
        if (id == null && name == null) {
            return new ImportOutcome(ImportWatchItem.HELD, "no-patient-info");
        }
        String birth = first(csv.values().get("PatientBirthDate"),
                PatientFields.ifValid(PatientFields.clean(sidecar.get("PatientBirthDate")), PatientFields::validDa));
        String sex = first(csv.values().get("PatientSex"),
                PatientFields.ifValid(PatientFields.clean(sidecar.get("PatientSex")), PatientFields::validSex));
        // 患者の 4 項目は検査済みの値だけを Options で渡す。サイドカーの生の値は、変換側が写してしまわないよう外す
        Map<String, Object> meta = new HashMap<>(sidecar);
        for (String k : PATIENT_KEYS) {
            meta.remove(k);
        }
        NiftiToDicom.Options opts = new NiftiToDicom.Options(
                first(csv.values().get("Modality"), "MR"), id, name, birth, sex, null,
                csv.values().get("StudyDescription"), niftiBaseName(file), 1, null, null, meta, null);
        NiftiImportService.Result r = niftiImport.importFile(file, meta, opts);
        if (r.error() != null) {
            return new ImportOutcome(ImportWatchItem.FAILED, r.error());
        }
        if (r.imported() == 0) {
            return new ImportOutcome(ImportWatchItem.FAILED, "import-failed");
        }
        if (r.failed() > 0) {
            return new ImportOutcome(ImportWatchItem.FAILED, "partial: " + r.failed() + " frames failed");
        }
        return new ImportOutcome(ImportWatchItem.IMPORTED, null);
    }

    private static String first(String a, String b) {
        return a != null ? a : b;
    }

    /**
     * 納品の CSV で、取り込んだ DICOM のスタディの患者属性を上書きする（設定が ON のときだけ）。スタディごとに 1 回。
     * CSV に無い列は今の値のまま。失敗しても他の処理は止めず、状態にコードを出す。ログには個人情報を出さない。
     */
    private void applyCsvToStudies(Map<String, Map<String, String>> toApply) {
        int done = 0;
        for (Map.Entry<String, Map<String, String>> e : toApply.entrySet()) {
            try {
                List<DicomInstance> rows = instanceRepo.findByStudyInstanceUid(e.getKey());
                if (rows.isEmpty()) {
                    continue;
                }
                Map<String, String> v = e.getValue();
                String name = v.getOrDefault("PatientName", rows.get(0).getPatientName());
                dbAdmin.updateStudyPatient(e.getKey(), name, v.get("PatientBirthDate"), v.get("PatientSex"),
                        v.get("PatientID"));
                done++;
            } catch (RuntimeException ex) {
                scanError = "csv-apply-failed";
                log.warn("CSV による患者属性の上書きに失敗しました（続行）: {}", ex.toString());
            }
        }
        if (done > 0) {
            log.info("納品フォルダの CSV で患者属性を上書きしました: {} スタディ", done);
        }
    }

    /** サイドカー JSON（無い・壊れていれば空）。 */
    private static Map<String, Object> readSidecar(Path nifti) {
        Path p = sidecarOf(nifti);
        if (!Files.isRegularFile(p)) {
            return Map.of();
        }
        try {
            return JSON.readValue(p.toFile(), new TypeReference<Map<String, Object>>() { });
        } catch (IOException e) {
            log.warn("サイドカー JSON を解釈できません（患者情報なしとして扱います）: {}", p);
            return Map.of();
        }
    }

    /** 取り込みのエラー文（{@code パス: メッセージ}。メッセージが null のことがある）から、パスと null を除いた理由。 */
    static String reason(String key, String raw) {
        String r = raw == null ? "" : raw;
        if (r.startsWith(key)) {
            r = r.substring(key.length());
            if (r.startsWith(":")) {
                r = r.substring(1);
            }
        }
        r = r.trim();
        return r.isEmpty() || r.equals("null") ? "import-failed" : r;
    }

    private void record(String key, long size, long mtime, String status, String error,
                        Map<String, ImportWatchItem> ledger) {
        ImportWatchItem item = new ImportWatchItem(key, size, mtime, status, clock.millis(), error);
        repo.save(item);
        ledger.put(key, item);
    }
}

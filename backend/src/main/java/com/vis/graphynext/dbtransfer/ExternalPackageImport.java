/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbtransfer;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.dbtransfer.TransferManifest.FileEntry;
import com.vis.graphynext.dbtransfer.TransferManifest.MaskItem;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.plugin.PluginRegistry;
import com.vis.graphynext.settings.SettingsService;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.FileStore;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.ToLongFunction;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * 外付けドライブなど、<b>今の DB の外</b>にある荷物を今の DB へ取り込む（standalone のみ）。
 *
 * <p>取り込み元には何も書かない。目録に載ったファイルだけを今の DB の {@code inbox/} へ写して照合し、
 * そのあとは起動時の取り込みと同じ処理（{@link InboxIngestService#ingestOne}）に渡す。受け側のデータは上書きしない。
 *
 * <p>荷物は別の PC から来るので中身を信用しない。起動時の取り込みより厳しく見る:
 * <ul>
 *   <li>目録の id・パス・設定のキーの形が違えば、その荷物は取り込まない。</li>
 *   <li>1 件でも欠け・改ざんがあれば、その荷物は何も取り込まない（移し元に元があるので写し直せる）。</li>
 *   <li>DICOM の中の SOP UID が目録と違えば改ざんとする。重複の判定は目録の UID で行うので、
 *       食い違いを通すと「無い」と判定した画像が、中身の UID で既存の画像を置き換える。</li>
 * </ul>
 */
@Service
@Profile("standalone")
public class ExternalPackageImport {

    private static final Logger log = LoggerFactory.getLogger(ExternalPackageImport.class);
    private static final Pattern ID = Pattern.compile("\\d{8}-\\d{6}-[0-9a-f]{8}");
    private static final Pattern MASK_PATH = Pattern.compile("masks/\\d{5}\\.frames");
    private static final Pattern OWN_PARTIAL = Pattern.compile("\\d{8}-\\d{6}-[0-9a-f]{8}-i[0-9a-f]{8}\\.partial");
    static final long SPACE_MARGIN = 64L << 20;

    /** {@code problem} は null（取り込める）・{@code too-new}・{@code invalid-manifest}。 */
    public record PackageSummary(String name, String createdAt, int studies, int files, long bytes, String problem,
                                 List<PluginVersions.Note> pluginNotes) {
    }

    /** {@code requiredBytes} は取り込みの途中で写しと保管庫の 2 つ分になるぶんを含む。 */
    public record ScanResult(List<PackageSummary> packages, int stalePartials, long requiredBytes, long freeBytes,
                             boolean enoughSpace) {
    }

    /** {@code outcome} は {@code imported}・{@code too-new}・{@code invalid-manifest}・{@code incomplete}・{@code damaged}・{@code failed}。 */
    public record ImportedPackage(String name, String outcome, InboxIngestService.PackageResult result) {
    }

    /** {@code state} は {@code running}・{@code done}・{@code failed}。{@code studyUids} は取り込み後にこの DB にある、荷物の検査。 */
    public record JobStatus(String jobId, String state, String error, List<ImportedPackage> packages,
                            List<String> studyUids) {
    }

    private record Loaded(Path dir, byte[] manifestBytes, TransferManifest manifest, String problem) {
    }

    private record Source(List<Path> packages, int stalePartials) {
    }

    private static final class Rejected extends IOException {
        private final String outcome;

        Rejected(String outcome, String message) {
            super(message);
            this.outcome = outcome;
        }
    }

    private final InboxIngestService ingest;
    private final DbTransferService transfer;
    private final DicomInstanceRepository repo;
    private final PluginRegistry pluginRegistry;
    private final ObjectMapper mapper = new ObjectMapper()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "db-external-import");
        t.setDaemon(true);
        return t;
    });
    private final Map<String, JobStatus> jobs = new ConcurrentHashMap<>();
    private String activeJob;
    /** 空き容量の調べ方（テストで差し替える）。 */
    ToLongFunction<Path> usableSpace = p -> {
        try {
            FileStore s = Files.getFileStore(p);
            return s.getUsableSpace();
        } catch (IOException e) {
            throw new IllegalArgumentException("space-unknown");
        }
    };

    public ExternalPackageImport(InboxIngestService ingest, DbTransferService transfer, DicomInstanceRepository repo,
                                 PluginRegistry pluginRegistry) {
        this.ingest = ingest;
        this.transfer = transfer;
        this.repo = repo;
        this.pluginRegistry = pluginRegistry;
    }

    @PreDestroy
    void shutdown() {
        worker.shutdown();
    }

    public ScanResult scan(String folder) throws IOException {
        Source src = open(folder);
        List<PackageSummary> out = new ArrayList<>();
        long bytes = 0;
        Map<String, String> installed = PluginVersions.installed(pluginRegistry);
        for (Path p : src.packages()) {
            Loaded l = load(p);
            String name = p.getFileName().toString();
            if (l.problem() != null) {
                out.add(new PackageSummary(name, null, 0, 0, 0, l.problem(), List.of()));
                continue;
            }
            long size = size(l.manifest());
            bytes += size;
            out.add(new PackageSummary(name, l.manifest().createdAt(), l.manifest().studyUids().size(),
                    l.manifest().files().size(), size, null, PluginVersions.compare(l.manifest(), installed)));
        }
        long required = required(bytes);
        long free = usableSpace.applyAsLong(transfer.currentFolder());
        return new ScanResult(out, src.stalePartials(), required, free, free >= required);
    }

    /** 取り込みを始める。同時に 1 件だけ。フォルダの誤りと容量不足は、ここで断る（何も写さない）。 */
    public synchronized String start(String folder) throws IOException {
        if (activeJob != null) {
            throw new IllegalArgumentException("busy");
        }
        ScanResult s = scan(folder);
        if (!s.enoughSpace()) {
            throw new IllegalArgumentException("not-enough-space: " + s.requiredBytes() + " / " + s.freeBytes());
        }
        List<Path> packages = open(folder).packages();
        String jobId = UUID.randomUUID().toString();
        jobs.put(jobId, new JobStatus(jobId, "running", null, List.of(), List.of()));
        activeJob = jobId;
        ingest.externalStarted();
        worker.execute(() -> run(jobId, packages));
        return jobId;
    }

    public JobStatus status(String jobId) {
        JobStatus s = jobs.get(jobId);
        if (s == null) {
            throw new IllegalArgumentException("job-not-found");
        }
        return s;
    }

    private void run(String jobId, List<Path> packages) {
        List<ImportedPackage> done = new ArrayList<>();
        Set<String> studies = new LinkedHashSet<>();
        String state = "failed";
        String error = "internal";
        try {
            removeOwnLeftovers();
            for (Path p : packages) {
                done.add(importOne(p, studies));
                jobs.put(jobId, new JobStatus(jobId, "running", null, List.copyOf(done), List.of()));
            }
            state = "done";
            error = null;
        } catch (RuntimeException e) {
            log.error("[db-import] 取り込みが途中で止まりました", e);
        } finally {
            List<String> present = studies.stream().filter(u -> !repo.findByStudyInstanceUid(u).isEmpty()).toList();
            synchronized (this) {
                jobs.put(jobId, new JobStatus(jobId, state, error, List.copyOf(done), present));
                activeJob = null;
            }
            ingest.externalFinished();
        }
    }

    ImportedPackage importOne(Path pkg, Set<String> studies) {
        String name = pkg.getFileName().toString();
        Path staging = null;
        try {
            Loaded l = load(pkg);
            if (l.problem() != null) {
                return new ImportedPackage(name, l.problem(), null);
            }
            TransferManifest m = l.manifest();
            Path inbox = transfer.currentFolder().resolve("inbox");
            String local = m.id() + "-i" + UUID.randomUUID().toString().substring(0, 8);
            staging = inbox.resolve(local + ".partial");
            Files.createDirectories(staging);
            copyVerified(pkg, staging, m);
            // 読んだ目録の中身そのものを書く（写している間に取り込み元が変わっても、照合した中身と食い違わない）
            Files.write(staging.resolve("manifest.json"), l.manifestBytes());
            InboxIngestService.PackageResult r = ingest.ingestStaged(staging, inbox.resolve(local));
            studies.addAll(m.studyUids());
            return new ImportedPackage(name, "imported", r);
        } catch (Rejected e) {
            log.warn("[db-import] {}: {}（何も取り込みません）", name, e.getMessage());
            return new ImportedPackage(name, e.outcome, null);
        } catch (IOException | RuntimeException e) {
            log.error("[db-import] {}: 取り込めません", name, e);
            return new ImportedPackage(name, "failed", null);
        } finally {
            if (staging != null) {
                DbTransferService.deleteTree(staging); // 確定した荷物は名前が変わっているので、残っていれば書きかけ
            }
        }
    }

    private static void copyVerified(Path pkg, Path staging, TransferManifest m) throws IOException {
        Path real = pkg.toRealPath();
        for (FileEntry f : m.files()) {
            Path dest = staging.resolve(f.path()).normalize();
            copyOne(pkg, real, f.path(), dest, f.size(), f.sha256());
            String sop;
            try {
                sop = DbTransferService.sopInstanceUid(dest);
            } catch (IOException e) {
                throw new Rejected("damaged", "DICOM として読めません: " + f.path());
            }
            if (!f.sopUid().equals(sop)) {
                throw new Rejected("damaged", "SOP UID が目録と違います: " + f.path());
            }
        }
        for (MaskItem k : nz(m.related().masks())) {
            copyOne(pkg, real, k.path(), staging.resolve(k.path()).normalize(), k.size(), k.sha256());
        }
    }

    private static void copyOne(Path pkg, Path realPkg, String relative, Path dest, long size, String sha)
            throws IOException {
        Path src = pkg.resolve(relative).normalize();
        if (!Files.isRegularFile(src, LinkOption.NOFOLLOW_LINKS)) {
            throw new Rejected(Files.exists(src, LinkOption.NOFOLLOW_LINKS) ? "damaged" : "incomplete",
                    "ファイルがありません（またはリンクです）: " + relative);
        }
        // 途中のフォルダがリンクで荷物の外を指していないか
        if (!src.toRealPath().startsWith(realPkg)) {
            throw new Rejected("damaged", "荷物の外を指しています: " + relative);
        }
        if (Files.size(src) != size) {
            throw new Rejected("damaged", "サイズが目録と違います: " + relative);
        }
        Files.createDirectories(dest.getParent());
        if (!DbTransferService.copyWithDigest(src, dest).equals(sha)) {
            throw new Rejected("damaged", "sha256 が目録と違います: " + relative);
        }
    }

    /** 選ばれたフォルダが荷物 1 個か、{@code inbox/} を持つ書き出し先かを見分ける。今の DB の中は受けない。 */
    private Source open(String folder) throws IOException {
        if (folder == null || folder.isBlank()) {
            throw new IllegalArgumentException("source-missing");
        }
        Path f = Path.of(folder);
        if (!f.isAbsolute()) {
            throw new IllegalArgumentException("source-not-absolute");
        }
        f = f.toAbsolutePath().normalize();
        if (!Files.isDirectory(f)) {
            throw new IllegalArgumentException("source-not-found");
        }
        Path current = transfer.currentFolder();
        Path realF = f.toRealPath();
        Path realCurrent = Files.exists(current) ? current.toRealPath() : current;
        if (realF.startsWith(realCurrent) || realCurrent.startsWith(realF)) {
            throw new IllegalArgumentException("source-is-current");
        }
        if (Files.isRegularFile(f.resolve("manifest.json"), LinkOption.NOFOLLOW_LINKS)) {
            if (f.getFileName().toString().endsWith(".partial")) {
                return new Source(List.of(), 1);
            }
            return new Source(List.of(f), 0);
        }
        Path inbox = f.resolve("inbox");
        List<Path> packages = new ArrayList<>();
        int stale = 0;
        if (Files.isDirectory(inbox, LinkOption.NOFOLLOW_LINKS)) {
            try (Stream<Path> s = Files.list(inbox)) {
                for (Path p : s.filter(x -> Files.isDirectory(x, LinkOption.NOFOLLOW_LINKS)).sorted().toList()) {
                    String n = p.getFileName().toString();
                    if (n.equals("done") || n.equals("conflicts")) {
                        continue;
                    }
                    if (n.endsWith(".partial")) {
                        stale++;
                    } else {
                        packages.add(p);
                    }
                }
            }
        }
        if (packages.isEmpty() && stale == 0) {
            throw new IllegalArgumentException("no-packages");
        }
        return new Source(packages, stale);
    }

    private Loaded load(Path dir) {
        try {
            Path file = dir.resolve("manifest.json");
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
                return new Loaded(dir, null, null, "invalid-manifest");
            }
            byte[] bytes;
            try (InputStream in = Files.newInputStream(file)) {
                bytes = in.readAllBytes();
            }
            var tree = mapper.readTree(bytes);
            // 新しい版は欄の形が変わっていうるので、版を先に見る
            if (tree.path("formatVersion").asInt(0) > TransferManifest.FORMAT_VERSION) {
                return new Loaded(dir, null, null, "too-new");
            }
            TransferManifest m = mapper.treeToValue(tree, TransferManifest.class);
            return valid(m) ? new Loaded(dir, bytes, m, null) : new Loaded(dir, null, null, "invalid-manifest");
        } catch (IOException | RuntimeException e) {
            log.warn("[db-import] 目録を読めません: {} ({})", dir.getFileName(), e.toString());
            return new Loaded(dir, null, null, "invalid-manifest");
        }
    }

    static boolean valid(TransferManifest m) {
        if (m == null || m.formatVersion() < 1 || m.id() == null || !ID.matcher(m.id()).matches()
                || m.studyUids() == null || m.files() == null || m.related() == null) {
            return false;
        }
        for (FileEntry f : m.files()) {
            if (f == null || f.path() == null || f.sopUid() == null || f.sha256() == null || f.size() < 0
                    || !f.path().startsWith("dicom/") || !safeRelative(f.path())) {
                return false;
            }
        }
        for (MaskItem k : nz(m.related().masks())) {
            if (k == null || k.path() == null || !MASK_PATH.matcher(k.path()).matches()) {
                return false;
            }
        }
        // 校正は設定として保存される。校正以外の設定のキーは受けない
        return m.related().calibrations() == null || m.related().calibrations().keySet().stream()
                .allMatch(k -> k != null && k.startsWith(SettingsService.XA_CALIBRATION_PREFIX));
    }

    private static boolean safeRelative(String path) {
        if (path.indexOf('\\') >= 0 || path.indexOf(':') >= 0 || path.indexOf('\0') >= 0) {
            return false;
        }
        for (String part : path.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) {
                return false;
            }
        }
        return true;
    }

    private static long size(TransferManifest m) {
        return m.files().stream().mapToLong(FileEntry::size).sum()
                + nz(m.related().masks()).stream().mapToLong(MaskItem::size).sum();
    }

    private static long required(long bytes) {
        return bytes * 2 + SPACE_MARGIN;
    }

    /** 前の取り込みがアプリの終了などで残した、この仕組みの書きかけだけを消す。 */
    private void removeOwnLeftovers() {
        Path inbox = transfer.currentFolder().resolve("inbox");
        if (!Files.isDirectory(inbox)) {
            return;
        }
        try (Stream<Path> s = Files.list(inbox)) {
            s.filter(p -> OWN_PARTIAL.matcher(p.getFileName().toString()).matches()).toList()
                    .forEach(DbTransferService::deleteTree);
        } catch (IOException e) {
            log.warn("[db-import] 書きかけの片付けに失敗: {}", e.toString());
        }
    }

    private static <T> List<T> nz(List<T> l) {
        return l == null ? List.of() : l;
    }
}

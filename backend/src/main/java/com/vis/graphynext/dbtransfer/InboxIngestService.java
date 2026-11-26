/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbtransfer;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.vis.graphynext.activity.ActiveWork;
import com.vis.graphynext.dbtransfer.TransferManifest.FileEntry;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.plugin.PluginRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Stream;

/**
 * 他の DB から届いた荷物（{@code <この DB>/inbox/<id>/}）を、この DB の索引へ取り込む（standalone のみ）。
 *
 * <p>起動を待たせないよう、起動完了のあと別スレッドで処理する。
 * <ul>
 *   <li>この DB に同じ SOP があれば取り込まない（上書きしない）。</li>
 *   <li>sha256 か中身の SOP UID が目録と違うファイルは取り込まず、荷物ごと残す。</li>
 *   <li>付随データは {@link RelatedData#apply}。衝突は {@code inbox/conflicts/<id>/} に JSON で残す。</li>
 *   <li>終わったら {@code inbox/done/<id>/} に目録と結果を残す（取り込めなかったファイルがあれば DICOM も残す）。</li>
 *   <li>{@code .partial} は書きかけ（移し元が途中で止まった）なので取り込まず、報告だけする。</li>
 * </ul>
 */
@Service
@Profile("standalone")
public class InboxIngestService implements ActiveWork {

    private static final Logger log = LoggerFactory.getLogger(InboxIngestService.class);

    public record PackageResult(String id, String mode, String sourceDbFolder, String processedAt,
                                int imported, int skippedExisting, int failed, List<String> errors,
                                int relatedInserted, int relatedSame, int conflicts,
                                List<PluginVersions.Note> pluginNotes) {
    }

    public record Status(boolean running, List<PackageResult> results, List<String> stalePartials) {
    }

    private final DicomInstanceRepository repo;
    private final DicomStorageService storage;
    private final RelatedData related;
    private final PluginRegistry pluginRegistry;
    private final Path inbox;
    private final ObjectMapper mapper = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT)
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);

    private volatile boolean running;
    private final java.util.concurrent.atomic.AtomicInteger external = new java.util.concurrent.atomic.AtomicInteger();
    private final List<PackageResult> results = new CopyOnWriteArrayList<>();
    private final List<String> stale = new CopyOnWriteArrayList<>();

    public InboxIngestService(DicomInstanceRepository repo, DicomStorageService storage, RelatedData related,
                              DbTransferService transfer, PluginRegistry pluginRegistry) {
        this.repo = repo;
        this.storage = storage;
        this.related = related;
        this.pluginRegistry = pluginRegistry;
        this.inbox = transfer.currentFolder().resolve("inbox");
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        if (!Files.isDirectory(inbox)) {
            return;
        }
        running = true;
        Thread t = new Thread(() -> {
            try {
                ingestAll();
            } finally {
                running = false;
            }
        }, "db-inbox-ingest");
        t.setDaemon(true);
        t.start();
    }

    public Status status() {
        return new Status(running, List.copyOf(results), List.copyOf(stale));
    }

    synchronized void ingestAll() {
        List<Path> pkgs;
        try (Stream<Path> s = Files.list(inbox)) {
            pkgs = s.filter(Files::isDirectory).sorted().toList();
        } catch (IOException e) {
            log.warn("[db-inbox] 読めません: {} ({})", inbox, e.toString());
            return;
        }
        for (Path p : pkgs) {
            String name = p.getFileName().toString();
            if (name.equals("done") || name.equals("conflicts")) {
                continue;
            }
            if (name.endsWith(".partial")) {
                stale.add(name);
                log.warn("[db-inbox] 書きかけの荷物があります（取り込みません）: {}", p);
                continue;
            }
            try {
                results.add(ingestOne(p));
            } catch (IOException | RuntimeException e) {
                log.error("[db-inbox] 荷物を取り込めません: {}", p, e);
                results.add(new PackageResult(name, null, null, Instant.now().toString(), 0, 0, 0,
                        List.of(String.valueOf(e.getMessage())), 0, 0, 0, List.of()));
            }
        }
    }

    /**
     * 外付けから写した書きかけを確定して取り込む。名前を変えてから取り込み終わるまでを {@link #ingestAll} と
     * 同じロックで通す（確定した瞬間に起動時の取り込みが拾って、二重に処理しないように）。
     */
    synchronized PackageResult ingestStaged(Path partial, Path ready) throws IOException {
        Files.move(partial, ready, StandardCopyOption.ATOMIC_MOVE);
        return ingestOne(ready);
    }

    /** 外付けからの取り込みも「取り込み中」として、終了時の確認に数える。 */
    void externalStarted() {
        external.incrementAndGet();
    }

    void externalFinished() {
        external.decrementAndGet();
    }

    PackageResult ingestOne(Path pkg) throws IOException {
        TransferManifest m = mapper.readValue(pkg.resolve("manifest.json").toFile(), TransferManifest.class);
        if (m.formatVersion() > TransferManifest.FORMAT_VERSION) {
            throw new IOException("新しい版で作られた荷物です（formatVersion=" + m.formatVersion() + "）");
        }
        int imported = 0;
        int skipped = 0;
        List<String> errors = new ArrayList<>();
        for (FileEntry f : m.files()) {
            if (repo.existsById(f.sopUid())) {
                skipped++;
                continue;
            }
            Path p = pkg.resolve(f.path()).normalize();
            try {
                if (!p.startsWith(pkg) || !Files.isRegularFile(p) || Files.size(p) != f.size()
                        || !DbTransferService.sha256(p).equals(f.sha256())) {
                    errors.add("照合に失敗: " + f.path());
                    continue;
                }
                // 重複の判定は目録の UID で行う。中身の UID が違うと、「無い」と判定した画像が既存の画像を置き換える
                if (!f.sopUid().equals(DbTransferService.sopInstanceUid(p))) {
                    errors.add("SOP UID が目録と違います: " + f.path());
                    continue;
                }
                storage.importFromFile(p);
                imported++;
            } catch (IOException | RuntimeException e) {
                errors.add(f.path() + ": " + e.getMessage());
            }
        }
        RelatedData.ApplyResult rel = related.apply(m.related(), pkg);
        errors.addAll(rel.errors());
        if (!rel.conflicts().isEmpty()) {
            // 目録の id はパスに使わない（荷物の中身で書き出し先が決まらないようにする）
            Path dir = inbox.resolve("conflicts").resolve(pkg.getFileName().toString());
            Files.createDirectories(dir);
            int n = 0;
            for (RelatedData.Conflict c : rel.conflicts()) {
                mapper.writeValue(dir.resolve(String.format("%03d-%s.json", ++n, c.kind())).toFile(), c);
            }
            log.warn("[db-inbox] {}: 付随データの衝突 {} 件（上書きせず {} に残しました）", m.id(),
                    rel.conflicts().size(), dir);
        }
        PackageResult r = new PackageResult(m.id(), m.mode(), m.sourceDbFolder(), Instant.now().toString(), imported,
                skipped, errors.size(), errors, rel.inserted(), rel.same(), rel.conflicts().size(),
                PluginVersions.compare(m, PluginVersions.installed(pluginRegistry)));
        mapper.writeValue(pkg.resolve("result.json").toFile(), r);
        if (errors.isEmpty()) {
            DbTransferService.deleteTree(pkg.resolve("dicom"));
            if (rel.conflicts().isEmpty()) {
                DbTransferService.deleteTree(pkg.resolve("masks")); // 衝突の解決用にだけ残す
            }
        }
        Path done = inbox.resolve("done");
        Files.createDirectories(done);
        Files.move(pkg, done.resolve(pkg.getFileName()), StandardCopyOption.ATOMIC_MOVE);
        log.info("[db-inbox] {}: 取り込み {} / 既存で飛ばした {} / 失敗 {} / 付随データ 追加 {}・同一 {}・衝突 {}",
                m.id(), imported, skipped, errors.size(), rel.inserted(), rel.same(), rel.conflicts().size());
        return r;
    }

    @Override
    public String kind() {
        return "dbInbox";
    }

    @Override
    public int activeCount() {
        return running || external.get() > 0 ? 1 : 0;
    }

    @Override
    public void cancelAll() {
        // 取り込みを止める口が無い
    }

    @Override
    public boolean cancellable() {
        return false;
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbtransfer;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.vis.graphynext.dbtransfer.TransferManifest.FileEntry;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Stream;

/**
 * 検査を別の DB フォルダへコピー・移動する（standalone のみ）。
 *
 * <p>移し先の索引（H2）には触れない。{@code <移し先>/inbox/<id>.partial/} に DICOM と目録を書き、
 * 読み直して sha256 を照合してから {@code <id>/} へ名前を変えて確定する。移し先を次に開いたとき
 * {@link InboxIngestService} が取り込む。移動は、確定したあとで移し元から消す（照合に失敗したら消さない）。
 */
@Service
@Profile("standalone")
public class DbTransferService {

    private static final Logger log = LoggerFactory.getLogger(DbTransferService.class);
    static final String MARKER = "graphy-db.json";
    static final String INDEX_FILE = "graphy-index.mv.db";

    public enum Mode { copy, move }

    public record TransferResult(String id, String mode, int studies, int files, long bytes, boolean sourceDeleted) {
    }

    private final DicomInstanceRepository repo;
    private final StorageLayout layout;
    private final RelatedData related;
    private final Path currentFolder;
    private final ObjectMapper mapper = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);

    public DbTransferService(DicomInstanceRepository repo, StorageLayout layout, RelatedData related,
                             @Value("${graphy.db.folder:}") String dbFolder) {
        this.repo = repo;
        this.layout = layout;
        this.related = related;
        this.currentFolder = dbFolder == null || dbFolder.isBlank()
                ? layout.root().getParent() : Path.of(dbFolder).toAbsolutePath().normalize();
    }

    public Path currentFolder() {
        return currentFolder;
    }

    public synchronized TransferResult transfer(List<String> studyUids, String targetFolder, Mode mode)
            throws IOException {
        if (studyUids == null || studyUids.isEmpty()) {
            throw new IllegalArgumentException("no-studies");
        }
        Set<String> studies = new LinkedHashSet<>(studyUids);
        Path target = checkTarget(targetFolder);

        List<DicomInstance> rows = new ArrayList<>();
        for (String s : studies) {
            List<DicomInstance> r = repo.findByStudyInstanceUid(s);
            if (r.isEmpty()) {
                throw new IllegalArgumentException("study-not-found: " + s);
            }
            rows.addAll(r);
        }
        long bytes = 0;
        List<Path> sources = new ArrayList<>();
        for (DicomInstance r : rows) {
            Path src = layout.resolveForRead(r);
            if (src == null) {
                // 1 件でも欠けていたら運ばない（移動で欠けたまま消すと戻せない）
                throw new IOException("DICOM ファイルが見つかりません: " + r.getSopInstanceUid());
            }
            sources.add(src);
            bytes += Files.size(src);
        }
        long free = Files.getFileStore(target).getUsableSpace();
        if (free < bytes + (64L << 20)) {
            throw new IllegalArgumentException("not-enough-space: " + bytes + " / " + free);
        }

        String id = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")) + "-"
                + UUID.randomUUID().toString().substring(0, 8);
        Path inbox = target.resolve("inbox");
        Path partial = inbox.resolve(id + ".partial");
        Path done = inbox.resolve(id);
        StorageLayout pkgLayout = new StorageLayout(partial.resolve("dicom"));
        Files.createDirectories(partial);
        try {
            List<FileEntry> files = new ArrayList<>();
            for (int i = 0; i < rows.size(); i++) {
                DicomInstance r = rows.get(i);
                Path dest = pkgLayout.instancePath(r.getStudyInstanceUid(), r.getSeriesInstanceUid(),
                        r.getSopInstanceUid());
                Files.createDirectories(dest.getParent());
                String sha = copyWithDigest(sources.get(i), dest);
                files.add(new FileEntry("dicom/" + pkgLayout.toStored(dest), r.getStudyInstanceUid(),
                        r.getSeriesInstanceUid(), r.getSopInstanceUid(), Files.size(dest), sha));
            }
            Set<String> series = new LinkedHashSet<>();
            Set<String> patientKeys = new LinkedHashSet<>();
            for (DicomInstance r : rows) {
                series.add(r.getSeriesInstanceUid());
                patientKeys.add(RelatedData.patientKey(r));
            }
            TransferManifest manifest = new TransferManifest(TransferManifest.FORMAT_VERSION, id,
                    Instant.now().toString(), mode.name(), currentFolder.toString(), List.copyOf(studies), files,
                    related.collect(studies, series, patientKeys));
            mapper.writeValue(partial.resolve("manifest.json").toFile(), manifest);

            verify(partial, mapper.readValue(partial.resolve("manifest.json").toFile(), TransferManifest.class));
            Files.move(partial, done, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException | RuntimeException e) {
            deleteTree(partial);
            throw e;
        }
        log.info("[db-transfer] {} {} studies ({} files, {} bytes) -> {}", mode, studies.size(), rows.size(), bytes,
                done);

        boolean deleted = false;
        if (mode == Mode.move) {
            deleteSource(studies, rows);
            deleted = true;
        }
        return new TransferResult(id, mode.name(), studies.size(), rows.size(), bytes, deleted);
    }

    /**
     * 移し先の検査。今の DB でないこと、DB フォルダ（目印か索引がある）か空のフォルダであること。
     * 空なら目印を書いて DB フォルダにする。
     */
    Path checkTarget(String targetFolder) throws IOException {
        if (targetFolder == null || targetFolder.isBlank()) {
            throw new IllegalArgumentException("target-missing");
        }
        Path t = Path.of(targetFolder);
        if (!t.isAbsolute()) {
            throw new IllegalArgumentException("target-not-absolute");
        }
        if (targetFolder.contains(";")) {
            throw new IllegalArgumentException("target-has-semicolon");
        }
        t = t.toAbsolutePath().normalize();
        if (!Files.isDirectory(t)) {
            throw new IllegalArgumentException("target-not-found");
        }
        if (!Files.isWritable(t)) {
            throw new IllegalArgumentException("target-not-writable");
        }
        if (Files.isSameFile(t, currentFolder) || t.startsWith(currentFolder) || currentFolder.startsWith(t)) {
            throw new IllegalArgumentException("target-is-current");
        }
        boolean isDb = Files.exists(t.resolve(MARKER)) || Files.exists(t.resolve(INDEX_FILE));
        if (!isDb) {
            try (Stream<Path> s = Files.list(t)) {
                if (s.anyMatch(p -> !List.of(".DS_Store", "Thumbs.db", "desktop.ini")
                        .contains(p.getFileName().toString()))) {
                    throw new IllegalArgumentException("target-not-db-folder");
                }
            }
            Files.writeString(t.resolve(MARKER), "{\n  \"formatVersion\" : 1,\n  \"dbId\" : \""
                    + UUID.randomUUID() + "\",\n  \"createdAt\" : \"" + Instant.now() + "\"\n}\n");
        }
        return t;
    }

    /** 書いたものを読み直して、件数・サイズ・sha256 を目録と照合する。 */
    static void verify(Path pkg, TransferManifest m) throws IOException {
        for (FileEntry f : m.files()) {
            Path p = pkg.resolve(f.path());
            if (!p.normalize().startsWith(pkg) || !Files.isRegularFile(p) || Files.size(p) != f.size()
                    || !sha256(p).equals(f.sha256())) {
                throw new IOException("照合に失敗しました: " + f.path());
            }
        }
    }

    /** 移動: 確定後に移し元のファイル・索引・付随データを消す（設定の「ファイルも削除」によらず消す）。 */
    private void deleteSource(Set<String> studies, List<DicomInstance> rows) {
        Set<String> series = new LinkedHashSet<>();
        /** 患者キー → PatientID から作ったか（それなら ID で引ける。名前・UID 由来は全件から探す）。 */
        java.util.Map<String, Boolean> patientKeys = new java.util.LinkedHashMap<>();
        for (DicomInstance r : rows) {
            Path f = layout.resolveForWrite(r);
            if (f != null) {
                try {
                    Files.deleteIfExists(f);
                } catch (IOException e) {
                    log.warn("[db-transfer] 移し元のファイルを消せません: {} ({})", f, e.toString());
                }
            }
            series.add(r.getSeriesInstanceUid());
            patientKeys.put(RelatedData.patientKey(r), r.getPatientId() != null && !r.getPatientId().isEmpty());
        }
        repo.deleteAll(rows);
        List<String> gone = new ArrayList<>();
        for (var e : patientKeys.entrySet()) {
            String pk = e.getKey();
            boolean remains = e.getValue()
                    ? !repo.findByPatientId(pk).isEmpty()
                    : repo.findAll().stream().anyMatch(i -> pk.equals(RelatedData.patientKey(i)));
            if (!remains) {
                gone.add(pk);
            }
        }
        related.deleteAfterMove(studies, series, gone);
    }

    static String copyWithDigest(Path src, Path dest) throws IOException {
        MessageDigest md = sha();
        try (InputStream in = new DigestInputStream(Files.newInputStream(src), md);
             OutputStream out = Files.newOutputStream(dest)) {
            in.transferTo(out);
        }
        return HexFormat.of().formatHex(md.digest());
    }

    static String sha256(Path p) throws IOException {
        MessageDigest md = sha();
        try (InputStream in = new DigestInputStream(Files.newInputStream(p), md)) {
            in.transferTo(OutputStream.nullOutputStream());
        }
        return HexFormat.of().formatHex(md.digest());
    }

    private static MessageDigest sha() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static void deleteTree(Path dir) {
        if (!Files.exists(dir)) {
            return;
        }
        try (Stream<Path> s = Files.walk(dir)) {
            s.sorted((a, b) -> b.getNameCount() - a.getNameCount()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException e) {
                    log.warn("[db-transfer] 後片付けに失敗: {} ({})", p, e.toString());
                }
            });
        } catch (IOException e) {
            log.warn("[db-transfer] 後片付けに失敗: {} ({})", dir, e.toString());
        }
    }
}

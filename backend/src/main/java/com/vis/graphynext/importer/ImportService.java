/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.StorageLayout;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * standalone のローカルインポート。指定パス（ファイル/フォルダ）を再帰走査し、
 * DICOM ファイルを索引へ取り込む。原本は保持（{@link DicomStorageService#importFromFile} がコピー）。
 *
 * <p>ZIP は {@link ZipDicomImporter} が 1 エントリずつ展開して取り込む（全展開しない）。
 *
 * <p>DICOMDIR は索引対象外（実体は同フォルダ内にあり走査で拾う）。非 DICOM はスキップ。
 *
 * <p>🔴 走査は {@link Files#walkFileTree} で行う。{@code Files.walk()} は途中で読めない
 * ディレクトリに当たると {@code UncheckedIOException} をストリーム操作から投げ、
 * {@code catch (IOException)} では捕まらない。実測（2026-08-25）では読めないサブフォルダが
 * 1 つ混ざるだけで <b>走査全体が 500 になり、それまでに取り込んだ件数も返らなかった</b>。
 * いまは読めない要素を「その 1 件の失敗」として数え、残りの走査を続ける。
 */
@Service
public class ImportService {

    private static final Logger log = LoggerFactory.getLogger(ImportService.class);

    /** errors に積む上限（読めないツリーを丸ごと渡されたときに応答が肥大するのを防ぐ）。 */
    private static final int MAX_ERRORS = 100;

    /**
     * UI へ返す取り込み結果。
     *
     * @param studiesWithoutDate 取り込んだうち <b>StudyDate が空のスタディ数</b>。
     *     検索の既定条件は「今日」で、SQL の NULL 比較の性質上、日付範囲を指定すると
     *     検査日の無いスタディは必ず除外される（＝取り込めているのに一覧に出ない）。
     *     利用者が「取り込みに失敗した」と誤読するため、件数を返して UI で注意を出す。
     * @param studyInstanceUids 取り込んだ画像のスタディ（重複なし・出会った順）。UI が一覧を
     *     「いま取り込んだ検査」に絞って出すのに使う（既定の検索条件「今日」では、過去の検査は出ない）。
     */
    public record ImportResult(int imported, int skipped, int failed, int studiesWithoutDate, List<String> errors,
            List<String> studyInstanceUids) {
    }

    /**
     * 取り込みジョブの進捗と中止の窓口。取り込みを回すスレッドが書き、状態を返すスレッドが読む。
     * 件数は「1 件の処理が終わるたび」に更新される（ファイル 1 つ、または ZIP のエントリ 1 つが 1 件）。
     */
    public static class Progress {
        static final Progress NONE = new Progress();

        private final java.util.concurrent.atomic.AtomicBoolean cancelled = new java.util.concurrent.atomic.AtomicBoolean();
        private volatile long total = -1;
        private volatile int imported;
        private volatile int skipped;
        private volatile int failed;

        public void cancel() {
            cancelled.set(true);
        }

        public boolean isCancelled() {
            return cancelled.get();
        }

        /** 処理対象の総数。数えていない・数えられなかったときは −1。 */
        public long total() {
            return total;
        }

        public void setTotal(long total) {
            this.total = total;
        }

        public int imported() {
            return imported;
        }

        public int skipped() {
            return skipped;
        }

        public int failed() {
            return failed;
        }

        public long processed() {
            return (long) imported + skipped + failed;
        }
    }

    private final DicomStorageService storage;
    private final ZipDicomImporter zip;
    /**
     * 走査で中に入らないフォルダ（保管庫の作業用と、DB フォルダの受け取り箱）。保管庫や DB フォルダごと
     * 取り込んだとき、受信途中・一時ファイル・キャッシュ・他 DB からの荷物を拾わないため。
     * 保管庫の本体（{@code <study>/<series>/*.dcm}）は取り込める（索引を作り直す用途）。
     */
    private final Set<Path> skipDirs;

    public ImportService(DicomStorageService storage, StorageLayout layout) {
        this.storage = storage;
        this.zip = new ZipDicomImporter(storage);
        Path root = layout.root();
        Set<Path> skip = new java.util.HashSet<>();
        for (String n : List.of("incoming", ".import", ".cache")) {
            skip.add(root.resolve(n).normalize());
        }
        if (root.getParent() != null) {
            skip.add(root.getParent().resolve("inbox").normalize());
        }
        this.skipDirs = Set.copyOf(skip);
    }

    /** 異常終了で {@code .import} に残った一時ファイルを起動時に掃除する（新しいものは取り込み中かもしれないので残す）。 */
    @jakarta.annotation.PostConstruct
    void sweepStaleTemp() {
        int n = storage.sweepImportTemp(java.time.Duration.ofHours(24));
        if (n > 0) {
            log.info("取り込みの一時ファイルを {} 件掃除しました", n);
        }
    }

    /** 取り込みの走査が中に入らないフォルダか（監視の走査も同じ規則で避ける）。 */
    boolean isSkippedDir(Path dir) {
        return skipDirs.contains(dir.toAbsolutePath().normalize());
    }

    public ImportResult importPaths(List<String> paths) {
        return importPaths(paths, Progress.NONE);
    }

    /**
     * 取り込む。{@code progress} が中止されたら、次の 1 件の前で止まる（処理中の 1 件は最後までやる）。
     * 中止までに取り込んだ分はそのまま残り、結果にも数えられる。
     */
    public ImportResult importPaths(List<String> paths, Progress progress) {
        Counter c = new Counter(progress);
        if (paths != null) {
            for (String p : paths) {
                if (c.cancelled()) {
                    break;
                }
                if (p == null || p.isBlank()) {
                    continue;
                }
                Path path = Path.of(p);
                if (Files.isDirectory(path)) {
                    walk(path, c);
                } else if (Files.isRegularFile(path)) {
                    handle(path, c);
                } else {
                    c.skip();
                }
            }
        }
        log.info("インポート完了: 取込={} スキップ={} 失敗={} 検査日なしスタディ={}",
                c.imported, c.skipped, c.failed, c.studiesWithoutDate.size());
        return new ImportResult(c.imported, c.skipped, c.failed, c.studiesWithoutDate.size(), c.errors,
                List.copyOf(c.studies));
    }

    /**
     * 取り込み対象の総数（進捗バーの分母）。フォルダは通常ファイルの数、ZIP はディレクトリを除いたエントリ数。
     * ファイルの中身は読まない。数えている途中で中止されたら、そこまでの数を返す。
     */
    public long countFiles(List<String> paths, Progress progress) {
        long[] n = { 0 };
        if (paths == null) {
            return 0;
        }
        for (String p : paths) {
            if (progress.isCancelled()) {
                break;
            }
            if (p == null || p.isBlank()) {
                continue;
            }
            Path path = Path.of(p);
            if (Files.isDirectory(path)) {
                try {
                    Files.walkFileTree(path, new SimpleFileVisitor<>() {
                        @Override
                        public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                            return skipDirs.contains(dir.toAbsolutePath().normalize())
                                    ? FileVisitResult.SKIP_SUBTREE : FileVisitResult.CONTINUE;
                        }

                        @Override
                        public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                            n[0] += attrs.isRegularFile() ? zipOrOne(file) : 1;
                            return progress.isCancelled() ? FileVisitResult.TERMINATE : FileVisitResult.CONTINUE;
                        }

                        @Override
                        public FileVisitResult visitFileFailed(Path file, IOException e) {
                            return FileVisitResult.CONTINUE;
                        }
                    });
                } catch (IOException e) {
                    log.debug("数えられませんでした: {}", path, e);
                }
            } else {
                n[0] += Files.isRegularFile(path) ? zipOrOne(path) : 1;
            }
        }
        return n[0];
    }

    /** ZIP なら中のファイル数、そうでなければ 1。読めない ZIP は 1（取り込みで失敗 1 件になる）。 */
    private static long zipOrOne(Path file) {
        return ZipDicomImporter.looksZip(file) ? Math.max(1, ZipDicomImporter.countEntries(file)) : 1;
    }

    /** フォルダを再帰走査する。読めない要素は 1 件の失敗として数え、走査は続ける。 */
    private void walk(Path root, Counter c) {
        try {
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    return skipDirs.contains(dir.toAbsolutePath().normalize())
                            ? FileVisitResult.SKIP_SUBTREE : FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    if (c.cancelled()) {
                        return FileVisitResult.TERMINATE;
                    }
                    if (attrs.isRegularFile()) {
                        handle(file, c);
                    } else {
                        // シンボリックリンク等（walkFileTree は既定でリンクを辿らない）。
                        // 無言の「取込 0 / スキップ 0 / 失敗 0」を避けるため、スキップとして数える。
                        c.skip();
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(Path file, IOException e) {
                    c.fail(file, e);
                    log.warn("走査できませんでした（続行）: {}", file, e);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult postVisitDirectory(Path dir, IOException e) {
                    if (e != null) {
                        c.fail(dir, e);
                        log.warn("走査を完了できませんでした（続行）: {}", dir, e);
                    }
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            // 起点そのものが読めない場合のみ（visitFileFailed で拾えなかった分）。
            c.fail(root, e);
        }
    }

    private void handle(Path file, Counter c) {
        if (c.cancelled()) {
            return;
        }
        if (ZipDicomImporter.looksZip(file)) {
            zip.importZip(file, new Sink(c));
            return;
        }
        if (isDicomDir(file) || !looksDicom(file)) {
            c.skip();
            return;
        }
        try {
            DicomInstance saved = storage.importFromFile(file);
            c.imp();
            if (saved != null && saved.getStudyInstanceUid() != null) {
                c.studies.add(saved.getStudyInstanceUid());
            }
            if (saved != null && isBlank(saved.getStudyDate()) && saved.getStudyInstanceUid() != null) {
                c.studiesWithoutDate.add(saved.getStudyInstanceUid());
            }
        } catch (Exception e) {
            c.fail(file, e);
            log.debug("取り込み失敗: {}", file, e);
        }
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    /** DICOM Part-10 のマジック（先頭 128B のあと "DICM"）を確認。 */
    private static boolean looksDicom(Path file) {
        try (InputStream in = Files.newInputStream(file)) {
            byte[] head = in.readNBytes(132);
            if (head.length < 132) {
                return false;
            }
            return head[128] == 'D' && head[129] == 'I' && head[130] == 'C' && head[131] == 'M';
        } catch (IOException e) {
            return false;
        }
    }

    private static boolean isDicomDir(Path file) {
        return file.getFileName().toString().equalsIgnoreCase("DICOMDIR");
    }

    private final class Sink implements ZipDicomImporter.Sink {
        private final Counter c;

        Sink(Counter c) {
            this.c = c;
        }

        @Override
        public boolean cancelled() {
            return c.cancelled();
        }

        @Override
        public void imported(DicomInstance saved) {
            c.imp();
            if (saved != null && saved.getStudyInstanceUid() != null) {
                c.studies.add(saved.getStudyInstanceUid());
                if (isBlank(saved.getStudyDate())) {
                    c.studiesWithoutDate.add(saved.getStudyInstanceUid());
                }
            }
        }

        @Override
        public void skipped() {
            c.skip();
        }

        @Override
        public void failed(String what, Exception e) {
            c.failed(what, e);
        }
    }

    private static final class Counter {
        final Progress p;
        int imported;
        int skipped;
        int failed;
        /** StudyDate が空だったスタディの UID（件数を UI に返すため）。 */
        final Set<String> studiesWithoutDate = new LinkedHashSet<>();
        final Set<String> studies = new LinkedHashSet<>();
        final List<String> errors = new ArrayList<>();

        Counter(Progress p) {
            this.p = p;
        }

        boolean cancelled() {
            return p.isCancelled();
        }

        void imp() {
            p.imported = ++imported;
        }

        void skip() {
            p.skipped = ++skipped;
        }

        void failed(String what, Exception e) {
            p.failed = ++failed;
            if (errors.size() < MAX_ERRORS) {
                errors.add(what + ": " + e.getMessage());
            } else if (errors.size() == MAX_ERRORS) {
                errors.add("… 以降の失敗は省略 / further errors omitted");
            }
        }

        void fail(Path path, Exception e) {
            failed(path.toString(), e);
        }
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomStorageService;
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
     */
    public record ImportResult(int imported, int skipped, int failed, int studiesWithoutDate, List<String> errors) {
    }

    private final DicomStorageService storage;

    public ImportService(DicomStorageService storage) {
        this.storage = storage;
    }

    public ImportResult importPaths(List<String> paths) {
        Counter c = new Counter();
        if (paths != null) {
            for (String p : paths) {
                if (p == null || p.isBlank()) {
                    continue;
                }
                Path path = Path.of(p);
                if (Files.isDirectory(path)) {
                    walk(path, c);
                } else if (Files.isRegularFile(path)) {
                    handle(path, c);
                } else {
                    c.skipped++;
                }
            }
        }
        log.info("インポート完了: 取込={} スキップ={} 失敗={} 検査日なしスタディ={}",
                c.imported, c.skipped, c.failed, c.studiesWithoutDate.size());
        return new ImportResult(c.imported, c.skipped, c.failed, c.studiesWithoutDate.size(), c.errors);
    }

    /** フォルダを再帰走査する。読めない要素は 1 件の失敗として数え、走査は続ける。 */
    private void walk(Path root, Counter c) {
        try {
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    if (attrs.isRegularFile()) {
                        handle(file, c);
                    } else {
                        // シンボリックリンク等（walkFileTree は既定でリンクを辿らない）。
                        // 無言の「取込 0 / スキップ 0 / 失敗 0」を避けるため、スキップとして数える。
                        c.skipped++;
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
        if (isDicomDir(file) || !looksDicom(file)) {
            c.skipped++;
            return;
        }
        try {
            DicomInstance saved = storage.importFromFile(file);
            c.imported++;
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

    private static final class Counter {
        int imported;
        int skipped;
        int failed;
        /** StudyDate が空だったスタディの UID（件数を UI に返すため）。 */
        final Set<String> studiesWithoutDate = new LinkedHashSet<>();
        final List<String> errors = new ArrayList<>();

        void fail(Path path, Exception e) {
            failed++;
            if (errors.size() < MAX_ERRORS) {
                errors.add(path + ": " + e.getMessage());
            } else if (errors.size() == MAX_ERRORS) {
                errors.add("… 以降の失敗は省略 / further errors omitted");
            }
        }
    }
}

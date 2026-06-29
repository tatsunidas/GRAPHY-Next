/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import com.vis.graphynext.dicom.store.DicomStorageService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

/**
 * standalone のローカルインポート。指定パス（ファイル/フォルダ）を再帰走査し、
 * DICOM ファイルを索引へ取り込む。原本は保持（{@link DicomStorageService#importFromFile} がコピー）。
 *
 * <p>DICOMDIR は索引対象外（実体は同フォルダ内にあり走査で拾う）。非 DICOM はスキップ。
 */
@Service
public class ImportService {

    private static final Logger log = LoggerFactory.getLogger(ImportService.class);

    /** UI へ返す取り込み結果。 */
    public record ImportResult(int imported, int skipped, int failed, List<String> errors) {
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
                    try (Stream<Path> walk = Files.walk(path)) {
                        walk.filter(Files::isRegularFile).forEach(f -> handle(f, c));
                    } catch (IOException e) {
                        c.failed++;
                        c.errors.add(p + ": " + e.getMessage());
                    }
                } else if (Files.isRegularFile(path)) {
                    handle(path, c);
                } else {
                    c.skipped++;
                }
            }
        }
        log.info("インポート完了: 取込={} スキップ={} 失敗={}", c.imported, c.skipped, c.failed);
        return new ImportResult(c.imported, c.skipped, c.failed, c.errors);
    }

    private void handle(Path file, Counter c) {
        if (isDicomDir(file) || !looksDicom(file)) {
            c.skipped++;
            return;
        }
        try {
            storage.importFromFile(file);
            c.imported++;
        } catch (Exception e) {
            c.failed++;
            c.errors.add(file + ": " + e.getMessage());
            log.debug("取り込み失敗: {}", file, e);
        }
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
        final List<String> errors = new ArrayList<>();
    }
}

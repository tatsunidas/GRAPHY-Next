/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Enumeration;
import java.util.function.LongSupplier;
import java.util.zip.ZipEntry;
import java.util.zip.ZipException;
import java.util.zip.ZipFile;

/**
 * ZIP の中の DICOM だけを取り込む。ZIP 全体を展開した作業フォルダは作らず、エントリを 1 つずつ
 * 保管庫の {@code .import} へ書き出して {@link DicomStorageService#ingest} に渡す
 * （成功なら正規パスへ移動、失敗なら削除）。ディスクに同時に載る展開物は 1 ファイル分だけで、
 * 元の ZIP は読むだけ（コピーも変更もしない）。
 *
 * <p>書き出す前にエントリ先頭 132B で DICOM かを見て、非 DICOM は書き出さずにスキップする。
 * ファイル名はディスクに使わない（uuid 名の一時ファイル）ので zip-slip は構造的に起きないが、
 * {@code ..}・絶対パス・ドライブ文字を含む名前は失敗として数える。
 * zip 爆弾は、ヘッダの宣言サイズを信用せず<b>実際に書いたバイト数</b>で打ち切る。
 */
class ZipDicomImporter {

    private static final Logger log = LoggerFactory.getLogger(ZipDicomImporter.class);

    /** 受け取り側（{@link ImportService} の集計）。 */
    interface Sink {
        /** 中止が求められているか（エントリ 1 件ごとに見る）。 */
        boolean cancelled();

        void imported(DicomInstance saved);

        void skipped();

        void failed(String what, Exception e);
    }

    /** @param reserveFreeBytes 展開中に空けておく容量（書き込みで満杯にしない）。 */
    record Limits(int maxEntries, long maxEntryBytes, long maxTotalBytes, long reserveFreeBytes) {
        static final Limits DEFAULT = new Limits(200_000, 4L << 30, 200L << 30, 1L << 30);
    }

    private final DicomStorageService storage;
    private final Limits limits;
    private final LongSupplier freeSpace;

    ZipDicomImporter(DicomStorageService storage) {
        this(storage, Limits.DEFAULT, null);
    }

    ZipDicomImporter(DicomStorageService storage, Limits limits, LongSupplier freeSpace) {
        this.storage = storage;
        this.limits = limits;
        this.freeSpace = freeSpace != null ? freeSpace : this::usableSpace;
    }

    static boolean looksZip(Path file) {
        try (InputStream in = Files.newInputStream(file)) {
            byte[] h = in.readNBytes(4);
            return h.length == 4 && h[0] == 'P' && h[1] == 'K' && h[2] == 3 && h[3] == 4;
        } catch (IOException e) {
            return false;
        }
    }

    /** ディレクトリを除いたエントリ数。開けなければ 0。 */
    static long countEntries(Path zip) {
        try (ZipFile zf = open(zip)) {
            long n = 0;
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                if (!en.nextElement().isDirectory()) {
                    n++;
                }
            }
            return n;
        } catch (IOException e) {
            return 0;
        }
    }

    void importZip(Path zip, Sink sink) {
        ZipFile zf;
        try {
            zf = open(zip);
        } catch (IOException e) {
            sink.failed(zip.toString(), e);
            return;
        }
        try (zf) {
            if (zf.size() > limits.maxEntries()) {
                sink.failed(zip.toString(), new IOException("エントリ数が上限を超えています / too many entries: " + zf.size()));
                return;
            }
            long total = 0;
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                if (sink.cancelled()) {
                    return;
                }
                ZipEntry e = en.nextElement();
                if (e.isDirectory()) {
                    continue;
                }
                String label = zip.getFileName() + "!" + e.getName();
                if (unsafeName(e.getName())) {
                    sink.failed(label, new IOException("不正なエントリ名 / unsafe entry name"));
                    continue;
                }
                if (isNoise(e.getName())) {
                    sink.skipped();
                    continue;
                }
                try {
                    long written = importEntry(zf, e, label, sink, limits.maxTotalBytes() - total);
                    total += written;
                } catch (IOException | RuntimeException ex) {
                    sink.failed(label, ex);
                    log.debug("ZIP エントリの取り込み失敗: {}", label, ex);
                    if (ex instanceof TotalLimitException) {
                        return; // 累積上限に達したら残りは読まない
                    }
                }
            }
        } catch (IOException e) {
            sink.failed(zip.toString(), e);
        }
    }

    /** 戻り値は一時ファイルに書いたバイト数（スキップなら 0）。 */
    private long importEntry(ZipFile zf, ZipEntry e, String label, Sink sink, long totalRemaining) throws IOException {
        Path tmp = null;
        boolean ingested = false;
        try (InputStream in = zf.getInputStream(e)) {
            byte[] head = in.readNBytes(132);
            if (!isDicomHead(head)) {
                sink.skipped();
                return 0;
            }
            long declared = e.getSize();
            if (declared > limits.maxEntryBytes()) {
                throw new IOException("エントリが大きすぎます / entry too large: " + declared);
            }
            long need = Math.max(declared, head.length) + limits.reserveFreeBytes();
            if (freeSpace.getAsLong() < need) {
                throw new IOException("空き容量が足りません / not enough free disk space");
            }
            tmp = storage.newImportTempFile();
            long n = head.length;
            long cap = Math.min(limits.maxEntryBytes(), totalRemaining);
            try (OutputStream out = Files.newOutputStream(tmp)) {
                out.write(head);
                byte[] buf = new byte[1 << 16];
                int r;
                while ((r = in.read(buf)) > 0) {
                    n += r;
                    if (n > cap) {
                        throw n > limits.maxEntryBytes()
                                ? new IOException("展開サイズが上限を超えました / entry exceeds size limit")
                                : new TotalLimitException();
                    }
                    out.write(buf, 0, r);
                }
            }
            DicomInstance saved = storage.ingest(tmp); // 成功時 tmp は正規パスへ移動
            ingested = true;
            sink.imported(saved);
            return n;
        } finally {
            if (tmp != null && !ingested) {
                try {
                    Files.deleteIfExists(tmp);
                } catch (IOException ignore) {
                    // ベストエフォート（残っても次回起動時の掃除で消える）
                }
            }
        }
    }

    private static final class TotalLimitException extends IOException {
        TotalLimitException() {
            super("展開の累積サイズが上限を超えました / total extracted size limit exceeded");
        }
    }

    /** 名前が UTF-8 でない ZIP（日本語 Windows の旧い圧縮ソフト等）は MS932 で開き直す。 */
    private static ZipFile open(Path zip) throws IOException {
        try {
            return new ZipFile(zip.toFile());
        } catch (ZipException e) {
            try {
                return new ZipFile(zip.toFile(), Charset.forName("windows-31j"));
            } catch (IOException e2) {
                e.addSuppressed(e2);
                throw e;
            }
        }
    }

    private static boolean isDicomHead(byte[] h) {
        return h.length >= 132 && h[128] == 'D' && h[129] == 'I' && h[130] == 'C' && h[131] == 'M';
    }

    static boolean unsafeName(String name) {
        String n = name.replace('\\', '/');
        if (n.startsWith("/") || n.indexOf(':') >= 0 || n.indexOf('\0') >= 0) {
            return true;
        }
        for (String seg : n.split("/")) {
            if (seg.equals("..")) {
                return true;
            }
        }
        return false;
    }

    /** macOS が ZIP に混ぜるリソースフォークと DICOMDIR（索引対象外）。 */
    private static boolean isNoise(String name) {
        String n = name.replace('\\', '/');
        String base = n.substring(n.lastIndexOf('/') + 1);
        return n.startsWith("__MACOSX/") || base.startsWith("._") || base.equalsIgnoreCase("DICOMDIR");
    }

    private long usableSpace() {
        try {
            Path dir = storage.importTempDir();
            Files.createDirectories(dir);
            return Files.getFileStore(dir).getUsableSpace();
        } catch (IOException e) {
            return Long.MAX_VALUE; // 測れないときは止めない（UrlImportService と同じ）
        }
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.nio.file.AccessDeniedException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryNotEmptyException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileSystemException;
import java.nio.file.FileSystemLoopException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.NotDirectoryException;
import java.nio.file.NotLinkException;
import java.nio.file.Path;
import java.util.Locale;

/**
 * ファイル操作の<b>一時的な失敗</b>だけを、回数と待ちに上限をつけてやり直す。
 *
 * <p>一時的な失敗の例: Windows でウイルス対策・インデクサ・別プロセスが一瞬ファイルを掴んでいる（共有違反・アクセス拒否）。
 * 永続的な失敗（ファイルが無い・DICOM として読めない・容量不足）はやり直しても直らないので、すぐ諦める。
 *
 * <p>回数（3 回）と待ち（250 ms → 750 ms、合計 1 秒前後）は仮の値。一時的な掴みは通常 1 秒未満で解ける想定で、
 * 画面の操作を長く止めないための上限でもある。実測で見直す。
 */
final class FileRetry {

    private static final Logger log = LoggerFactory.getLogger(FileRetry.class);

    static final int MAX_ATTEMPTS = 3;
    static final long[] BACKOFF_MS = {250, 750};

    interface Sleeper {
        void sleep(long ms) throws InterruptedException;
    }

    interface IoOp<T> {
        T run() throws IOException;
    }

    private final Sleeper sleeper;

    FileRetry() {
        this(Thread::sleep);
    }

    FileRetry(Sleeper sleeper) {
        this.sleeper = sleeper;
    }

    /** {@code op} を実行する。一時的な失敗なら上限までやり直し、それでも駄目・永続的な失敗なら最後の例外を投げる。 */
    <T> T run(String what, Path path, IoOp<T> op) throws IOException {
        for (int attempt = 1; ; attempt++) {
            try {
                return op.run();
            } catch (IOException e) {
                if (attempt >= MAX_ATTEMPTS || !isTransient(e, path)) {
                    if (attempt > 1) {
                        log.warn("{} は {} 回試して失敗: {}", what, attempt, e.toString());
                    }
                    throw e;
                }
                log.info("{} が一時的に失敗（{}/{}）。やり直す: {}", what, attempt, MAX_ATTEMPTS, e.toString());
                try {
                    sleeper.sleep(BACKOFF_MS[attempt - 1]);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new InterruptedIOException("interrupted while retrying " + what);
                }
            }
        }
    }

    /** やり直せば直りうる失敗か。 */
    static boolean isTransient(IOException e, Path path) {
        if (e instanceof AccessDeniedException) {
            return true; // Windows の共有違反は AccessDenied として現れることがある
        }
        if (e instanceof NoSuchFileException || e instanceof NotDirectoryException
                || e instanceof FileAlreadyExistsException || e instanceof DirectoryNotEmptyException
                || e instanceof AtomicMoveNotSupportedException || e instanceof FileSystemLoopException
                || e instanceof NotLinkException) {
            return false;
        }
        if (e instanceof FileSystemException fse) {
            String reason = String.valueOf(fse.getReason()).toLowerCase(Locale.ROOT);
            // 容量・クォータは待っても直らない（メッセージは OS により異なるので語で判定する）
            return !(reason.contains("space") || reason.contains("quota") || reason.contains("disk full"));
        }
        // java.io の API（FileInputStream など）は、掴まれているときも FileNotFoundException を投げる。
        // ファイルが実在するのに開けないなら一時的、実在しないなら永続的
        return e instanceof FileNotFoundException && path != null && Files.exists(path);
    }
}

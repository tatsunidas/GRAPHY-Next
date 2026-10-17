/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.cache;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Predicate;

/**
 * 1 フォルダ＝1 名前空間の、ファイル単位の成果物キャッシュ。
 *
 * <p>共通にするのは「作り方」ではなく<b>周りの決まり</b>:
 * <ul>
 *   <li><b>原子的な確定</b> … 生成は一時ファイル（{@link #TMP_PREFIX}）に書き、成功したときだけ最終名へ move する。
 *       途中で例外・kill されても、最終名に不完全なものは現れない。</li>
 *   <li><b>キー（ファイル名）単位の直列化</b> … 同じ名前の同時要求は 1 回だけ生成し、残りは待って結果を共有する。
 *       別の名前は互いに待たない。</li>
 *   <li><b>上限と追い出し</b> … 合計が上限を超えたら、最後に使われたのが古い順に消す。0 は無制限。</li>
 *   <li><b>起動時の掃除</b> … 前回のプロセスが途中で落ちて残した一時ファイルを消す。</li>
 * </ul>
 *
 * <p>版数による無効化は呼び出し側が<b>ファイル名に含める</b>（版が変われば別の名前になり、古いものは上限で消える）。
 * 有効かどうかの判定（元ファイルとの mtime 比較など）も呼び出し側の {@code valid} に任せる。
 *
 * <p>最終アクセス時刻は<b>メモリ上</b>で持ち、ファイルの mtime には触らない
 * （mtime を「元より新しいか」の判定に使う呼び出し側があるため）。再起動後は mtime を初期値にする。
 */
public final class CacheStore {

    private static final Logger log = LoggerFactory.getLogger(CacheStore.class);

    /** 生成中のファイルの接頭辞。起動時に全部消す。最終名には使わせない。 */
    public static final String TMP_PREFIX = ".tmp-";

    /** 一時ファイルに書く処理。例外なら何も確定しない。 */
    @FunctionalInterface
    public interface Producer {
        void produce(Path tmp) throws IOException;
    }

    private final Path dir;
    private final long maxBytes;
    private final Clock clock;
    /** 最終名 → 最終アクセス時刻(ms)。 */
    private final Map<String, Long> lastAccess = new ConcurrentHashMap<>();
    private final Map<String, Object> keyLocks = new ConcurrentHashMap<>();
    private final Object evictLock = new Object();

    /**
     * @param maxBytes 0 以下なら無制限（追い出さない）
     */
    public CacheStore(Path dir, long maxBytes, Clock clock) {
        this.dir = dir;
        this.maxBytes = Math.max(0, maxBytes);
        this.clock = clock;
        rebuild();
    }

    public CacheStore(Path dir, long maxBytes) {
        this(dir, maxBytes, Clock.systemUTC());
    }

    /**
     * あれば（{@code valid} が真なら）それを返し、無ければ作って返す。
     *
     * @param name  最終ファイル名（フォルダ名や区切り文字を含めない）
     * @param valid 既存ファイルをそのまま使えるか。偽なら作り直す
     * @throws IOException producer の失敗、または確定の失敗。最終名には何も残らない
     */
    public Path getOrCreate(String name, Predicate<Path> valid, Producer producer) throws IOException {
        checkName(name);
        Path target = dir.resolve(name);
        if (usable(target, valid)) {
            touch(name);
            return target;
        }
        Object lock = keyLocks.computeIfAbsent(name, k -> new Object());
        synchronized (lock) {
            try {
                if (usable(target, valid)) {
                    touch(name);
                    return target;
                }
                Files.createDirectories(dir);
                // 拡張子は最終名と同じにする（ffmpeg など出力の拡張子で形式を決める道具が、そのまま書けるように）
                int dot = name.lastIndexOf('.');
                Path tmp = Files.createTempFile(dir, TMP_PREFIX, dot > 0 ? name.substring(dot) : ".part");
                try {
                    producer.produce(tmp);
                    if (!Files.exists(tmp) || Files.size(tmp) == 0) {
                        throw new IOException("cache: 生成物が空です (" + name + ")");
                    }
                    move(tmp, target);
                } finally {
                    Files.deleteIfExists(tmp);
                }
                touch(name);
            } finally {
                keyLocks.remove(name, lock);
            }
        }
        evictIfNeeded(name);
        return target;
    }

    /** あれば（{@code valid} が真なら）返す。作らない。 */
    public java.util.Optional<Path> find(String name, Predicate<Path> valid) {
        checkName(name);
        Path target = dir.resolve(name);
        if (usable(target, valid)) {
            touch(name);
            return java.util.Optional.of(target);
        }
        return java.util.Optional.empty();
    }

    /** 1 件消す（無ければ何もしない）。消せなければ false。 */
    public boolean remove(String name) {
        checkName(name);
        try {
            Files.deleteIfExists(dir.resolve(name));
            lastAccess.remove(name);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /** 名前が {@code prefix} で始まる項目をすべて消す。消せたものの数を返す（消せなかったものは残る）。 */
    public int removeByPrefix(String prefix) {
        if (prefix == null || prefix.isEmpty() || prefix.contains("/") || prefix.contains("\\")) {
            throw new IllegalArgumentException("cache: 不正な接頭辞です");
        }
        int removed = 0;
        for (String name : new ArrayList<>(lastAccess.keySet())) {
            if (name.startsWith(prefix) && remove(name)) {
                removed++;
            }
        }
        return removed;
    }

    /** 実ファイルの合計バイト数。 */
    public long totalBytes() {
        long sum = 0;
        for (String name : lastAccess.keySet()) {
            try {
                sum += Files.size(dir.resolve(name));
            } catch (IOException ignored) {
                // 外から消された項目は数えない
            }
        }
        return sum;
    }

    public int entryCount() {
        return lastAccess.size();
    }

    // ── 内部 ──────────────────────────────────────────────────────────────

    private boolean usable(Path target, Predicate<Path> valid) {
        return Files.isRegularFile(target) && valid.test(target);
    }

    private void touch(String name) {
        lastAccess.put(name, clock.millis());
    }

    private void checkName(String name) {
        if (name == null || name.isEmpty() || name.startsWith(TMP_PREFIX)
                || name.contains("/") || name.contains("\\") || name.equals(".") || name.equals("..")) {
            throw new IllegalArgumentException("cache: 不正な名前です: " + name);
        }
    }

    /** 起動時: 一時ファイルを消し、残っている項目から索引を作り直す。 */
    private void rebuild() {
        if (!Files.isDirectory(dir)) {
            return;
        }
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
            for (Path p : ds) {
                String n = p.getFileName().toString();
                if (n.startsWith(TMP_PREFIX)) {
                    try {
                        Files.deleteIfExists(p);
                    } catch (IOException e) {
                        log.warn("cache: 一時ファイルを消せません {}: {}", n, e.toString());
                    }
                } else if (Files.isRegularFile(p)) {
                    try {
                        lastAccess.put(n, Files.getLastModifiedTime(p).toMillis());
                    } catch (IOException ignored) {
                        // 読めない項目は索引に載せない
                    }
                }
            }
        } catch (IOException e) {
            log.warn("cache: 走査に失敗しました {}: {}", dir, e.toString());
        }
    }

    private void evictIfNeeded(String keep) {
        if (maxBytes <= 0) {
            return;
        }
        synchronized (evictLock) {
            record Item(String name, long size, long at) {}
            List<Item> items = new ArrayList<>();
            long total = 0;
            for (Map.Entry<String, Long> e : lastAccess.entrySet()) {
                try {
                    long size = Files.size(dir.resolve(e.getKey()));
                    total += size;
                    items.add(new Item(e.getKey(), size, e.getValue()));
                } catch (IOException gone) {
                    lastAccess.remove(e.getKey()); // 外から消された
                }
            }
            if (total <= maxBytes) {
                return;
            }
            items.sort(Comparator.comparingLong(Item::at));
            for (Item it : items) {
                if (total <= maxBytes) {
                    break;
                }
                if (it.name().equals(keep)) {
                    continue;
                }
                try {
                    Files.deleteIfExists(dir.resolve(it.name()));
                    lastAccess.remove(it.name());
                    total -= it.size();
                } catch (IOException e) {
                    // Windows で配信中など。飛ばして次に古いものへ（例外にも無限ループにもしない）
                    log.debug("cache: 追い出せませんでした {}: {}", it.name(), e.toString());
                }
            }
        }
    }

    private static void move(Path from, Path to) throws IOException {
        try {
            Files.move(from, to, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException atomicFailed) {
            // 原子的 move 非対応の FS（一部 Windows 構成）→ 通常 move。
            Files.move(from, to, StandardCopyOption.REPLACE_EXISTING);
        }
    }
}

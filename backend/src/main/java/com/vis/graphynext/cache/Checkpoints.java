/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.cache;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;

/**
 * 長い計算の途中結果（「N 番目の部分」）を {@link CacheStore} に置く薄い層。
 *
 * <p>同じ入力で再投入されたとき、済んだ部分を読み出して続きから計算するために使う。
 * 入力が同じことの保証は<b>呼び出し側が作る {@code jobKey}</b>（値に効く入力すべてのハッシュ）に任せる。
 *
 * <p>壊れた・長さの合わない項目は<b>無いものとして扱う</b>（読めないことで計算を止めず、再計算に倒す）。
 * 項目は {@code 16 バイトのヘッダ（マジック・版・本体長）＋本体}。
 */
public final class Checkpoints {

    private static final Logger log = LoggerFactory.getLogger(Checkpoints.class);

    private static final int MAGIC = 0x47434b50; // "GCKP"
    private static final int VERSION = 1;
    private static final int HEADER = 16;

    private final CacheStore store;

    public Checkpoints(CacheStore store) {
        this.store = store;
    }

    /** {@code jobKey} は 16 進など、ファイル名に使える文字だけで作ること。 */
    private static String name(String jobKey, int index) {
        if (!jobKey.matches("[0-9A-Za-z_-]{8,128}")) {
            throw new IllegalArgumentException("checkpoint: 不正な jobKey です");
        }
        return jobKey + "." + String.format("%06d", index) + ".ckpt";
    }

    /** 保存する。失敗しても計算は続けられるので例外にせず false を返す。 */
    public boolean save(String jobKey, int index, byte[] payload) {
        try {
            store.getOrCreate(name(jobKey, index), p -> false, tmp -> {
                ByteBuffer head = ByteBuffer.allocate(HEADER);
                head.putInt(MAGIC).putInt(VERSION).putLong(payload.length);
                byte[] all = new byte[HEADER + payload.length];
                System.arraycopy(head.array(), 0, all, 0, HEADER);
                System.arraycopy(payload, 0, all, HEADER, payload.length);
                Files.write(tmp, all);
            });
            return true;
        } catch (IOException e) {
            log.warn("checkpoint: 保存できませんでした index={}: {}", index, e.toString());
            return false;
        }
    }

    /** 読み出す。無い・壊れている・長さが違うときは empty。 */
    public Optional<byte[]> load(String jobKey, int index, int expectedLen) {
        try {
            Optional<Path> p = store.find(name(jobKey, index), f -> valid(f, expectedLen));
            if (p.isEmpty()) {
                return Optional.empty();
            }
            byte[] all = Files.readAllBytes(p.get());
            byte[] out = new byte[expectedLen];
            System.arraycopy(all, HEADER, out, 0, expectedLen);
            return Optional.of(out);
        } catch (IOException e) {
            log.warn("checkpoint: 読み出せませんでした index={}: {}", index, e.toString());
            return Optional.empty();
        }
    }

    /**
     * 長さの決まっていない項目を読み出す。長さはヘッダから取り、ファイルの大きさと食い違えば
     * 壊れているものとして empty。
     */
    public Optional<byte[]> load(String jobKey, int index) {
        try {
            Optional<Path> p = store.find(name(jobKey, index), f -> valid(f, -1));
            if (p.isEmpty()) {
                return Optional.empty();
            }
            byte[] all = Files.readAllBytes(p.get());
            byte[] out = new byte[all.length - HEADER];
            System.arraycopy(all, HEADER, out, 0, out.length);
            return Optional.of(out);
        } catch (IOException e) {
            log.warn("checkpoint: 読み出せませんでした index={}: {}", index, e.toString());
            return Optional.empty();
        }
    }

    /** @param expectedLen 負なら長さを問わない（ヘッダの長さとファイルの大きさが合えばよい） */
    private static boolean valid(Path f, int expectedLen) {
        try {
            long size = Files.size(f);
            if (expectedLen >= 0 ? size != HEADER + (long) expectedLen
                    : size < HEADER || size - HEADER > Integer.MAX_VALUE) {
                return false;
            }
            try (var ch = Files.newByteChannel(f)) {
                ByteBuffer head = ByteBuffer.allocate(HEADER);
                while (head.hasRemaining() && ch.read(head) > 0) {
                    // 読み切る
                }
                head.flip();
                return head.remaining() == HEADER && head.getInt() == MAGIC && head.getInt() == VERSION
                        && head.getLong() == size - HEADER;
            }
        } catch (IOException e) {
            return false;
        }
    }

    /** そのジョブの項目をすべて消す（0 以上 count 未満の添字）。 */
    public void clear(String jobKey, int count) {
        for (int i = 0; i < count; i++) {
            store.remove(name(jobKey, i));
        }
    }
}

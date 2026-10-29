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
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Optional;

/**
 * 長い計算の途中結果（「N 番目の部分」）を {@link CacheStore} に置く薄い層。
 *
 * <p>同じ入力で再投入されたとき、済んだ部分を読み出して続きから計算するために使う。
 * 入力が同じことの保証は<b>呼び出し側が作る {@code jobKey}</b>（値に効く入力すべてのハッシュ）に任せる。
 *
 * <p>壊れた・長さの合わない・<b>中身が変わっている</b>項目は<b>無いものとして扱う</b>（読めないことで計算を止めず、
 * 再計算に倒す）。項目は {@code 16 バイトのヘッダ（マジック・版・本体長）＋本体＋本体の SHA-256（32 バイト）}（版 2）。
 * 版 1（チェックサムなし）は検証できないので無いものとして扱い、同じキーを保存し直すと版 2 に置き換わる。
 *
 * <p>検出するのは保存後の化け・書き込みの欠けで、保存前に既に誤っていた値は検出できない。
 */
public final class Checkpoints {

    private static final Logger log = LoggerFactory.getLogger(Checkpoints.class);

    private static final int MAGIC = 0x47434b50; // "GCKP"
    private static final int VERSION = 2;
    private static final int HEADER = 16;
    /** 本体の SHA-256。 */
    private static final int DIGEST = 32;

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
                byte[] all = new byte[HEADER + payload.length + DIGEST];
                System.arraycopy(head.array(), 0, all, 0, HEADER);
                System.arraycopy(payload, 0, all, HEADER, payload.length);
                System.arraycopy(sha256(payload, 0, payload.length), 0, all, HEADER + payload.length, DIGEST);
                Files.write(tmp, all);
            });
            return true;
        } catch (IOException e) {
            log.warn("checkpoint: 保存できませんでした index={}: {}", index, e.toString());
            return false;
        }
    }

    /** 読み出す。無い・壊れている・長さが違う・中身が変わっているときは empty。 */
    public Optional<byte[]> load(String jobKey, int index, int expectedLen) {
        try {
            String name = name(jobKey, index);
            Optional<Path> p = store.find(name, f -> valid(f, expectedLen));
            if (p.isEmpty()) {
                return Optional.empty();
            }
            return verified(name, jobKey, index, Files.readAllBytes(p.get()), expectedLen);
        } catch (IOException e) {
            log.warn("checkpoint: 読み出せませんでした index={}: {}", index, e.toString());
            return Optional.empty();
        }
    }

    /**
     * 長さの決まっていない項目を読み出す。長さはヘッダから取り、ファイルの大きさと食い違えば
     * 壊れているものとして empty。中身が変わっていても empty。
     */
    public Optional<byte[]> load(String jobKey, int index) {
        try {
            String name = name(jobKey, index);
            Optional<Path> p = store.find(name, f -> valid(f, -1));
            if (p.isEmpty()) {
                return Optional.empty();
            }
            return verified(name, jobKey, index, Files.readAllBytes(p.get()), -1);
        } catch (IOException e) {
            log.warn("checkpoint: 読み出せませんでした index={}: {}", index, e.toString());
            return Optional.empty();
        }
    }

    /**
     * 安い検査（本体は読まない）: 大きさ・マジック・版・本体長。版 1（チェックサムなし）はここで落ちる
     * （検証できないので使わない。ファイルは消さず、保存し直されるまで残る）。
     *
     * @param expectedLen 負なら長さを問わない（ヘッダの長さとファイルの大きさが合えばよい）
     */
    private static boolean valid(Path f, int expectedLen) {
        try {
            long size = Files.size(f);
            long overhead = HEADER + (long) DIGEST;
            if (expectedLen >= 0 ? size != overhead + expectedLen
                    : size < overhead || size - overhead > Integer.MAX_VALUE) {
                return false;
            }
            try (var ch = Files.newByteChannel(f)) {
                ByteBuffer head = ByteBuffer.allocate(HEADER);
                while (head.hasRemaining() && ch.read(head) > 0) {
                    // 読み切る
                }
                head.flip();
                return head.remaining() == HEADER && head.getInt() == MAGIC && head.getInt() == VERSION
                        && head.getLong() == size - overhead;
            }
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * 読んだバイト列そのものを検査して本体を返す（検査と読み出しの間でファイルが置き換わっても取り違えない）。
     * 本体の SHA-256 が末尾と違えば、化けているので警告を出し、<b>そのファイルを消して</b> empty
     * （次の保存で作り直される）。
     */
    private Optional<byte[]> verified(String name, String jobKey, int index, byte[] all, int expectedLen) {
        long bodyLen = (long) all.length - HEADER - DIGEST;
        ByteBuffer head = ByteBuffer.wrap(all, 0, Math.min(all.length, HEADER));
        boolean shape = all.length >= HEADER + DIGEST && head.remaining() == HEADER
                && head.getInt() == MAGIC && head.getInt() == VERSION && head.getLong() == bodyLen
                && (expectedLen < 0 || bodyLen == expectedLen);
        if (!shape) {
            return Optional.empty();
        }
        int len = (int) bodyLen;
        byte[] actual = sha256(all, HEADER, len);
        if (!MessageDigest.isEqual(actual, Arrays.copyOfRange(all, HEADER + len, all.length))) {
            log.warn("checkpoint: 中身が保存時と違うので捨てます（再計算に倒れます） jobKey={}… index={}",
                    jobKey.substring(0, Math.min(8, jobKey.length())), index);
            store.remove(name);
            return Optional.empty();
        }
        return Optional.of(Arrays.copyOfRange(all, HEADER, HEADER + len));
    }

    private static byte[] sha256(byte[] data, int off, int len) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(data, off, len);
            return md.digest();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** そのジョブの項目をすべて消す（0 以上 count 未満の添字）。 */
    public void clear(String jobKey, int count) {
        for (int i = 0; i < count; i++) {
            store.remove(name(jobKey, i));
        }
    }

    /** その jobKey の項目を、添字を問わずすべて消す。消せた数を返す。 */
    public int clearAll(String jobKey) {
        name(jobKey, 0); // jobKey の検査
        return store.removeByPrefix(jobKey + ".");
    }
}

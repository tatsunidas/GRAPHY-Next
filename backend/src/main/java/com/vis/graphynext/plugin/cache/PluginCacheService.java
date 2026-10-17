/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.cache;

import com.vis.graphynext.cache.CacheStore;
import com.vis.graphynext.cache.Checkpoints;
import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.plugin.spi.PluginCache;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Optional;

/**
 * プラグインの「消えてもよい」派生データの置き場（H69）。{@code <storageDir>/.cache/plugins/}、ローカルのみ。
 *
 * <p>名前空間はここで固定する: {@code p<sha256(pluginId) 先頭16桁>-<sha256(種別+鍵) 先頭32桁>}。
 * <b>鍵の文字列はディスク上の名前に出さない</b>（鍵に患者情報などを入れる作者がいても残さない）。
 * 呼び出し側（HTTP・JAR）は URL の id／束縛された id を渡すだけで、別の id の名前は組み立てられない。
 * ただしこれは<b>誤接触の防止</b>で、信頼境界ではない（host API は直接叩ける）。
 *
 * <p>全プラグインが 1 つの {@link CacheStore}（1 つの LRU）を共有する。上限が入ったとき、暴走したプラグインは
 * 他のプラグインの項目を追い出せる。プラグイン別の枠は設けていない。
 */
@Service
public class PluginCacheService {

    /** 鍵（jobKey）の長さの上限（文字数）。 */
    public static final int MAX_KEY_CHARS = 256;
    /** チェックポイントの添字の上限（Checkpoints のファイル名は 6 桁）。 */
    public static final int MAX_INDEX = 999_999;
    /**
     * 1 件の大きさの既定の上限（16 MiB）。実アプリで、画面（renderer）から約 40 MiB 以上を 1 回の fetch で送ると
     * ウィンドウごと落ちることを確認した（32 MiB までは正常）ので、その半分に置く。大きなデータは checkpoint の添字で分割する。
     */
    public static final long DEFAULT_MAX_ITEM_BYTES = 16L * 1024 * 1024;

    public enum Outcome { OK, INVALID_KEY, INVALID_INDEX, TOO_LARGE, WRITE_FAILED }

    private final Checkpoints checkpoints;
    private final long maxItemBytes;

    @Autowired
    public PluginCacheService(DicomProperties props,
                              @Value("${graphy.plugin.cache.max-item-bytes:16777216}") long maxItemBytes) {
        this(new CacheStore(Paths.get(props.getStorageDir(), ".cache", "plugins"), 0), maxItemBytes);
    }

    public PluginCacheService(CacheStore store, long maxItemBytes) {
        this.checkpoints = new Checkpoints(store);
        this.maxItemBytes = maxItemBytes;
    }

    public long maxItemBytes() {
        return maxItemBytes;
    }

    public static boolean validKey(String key) {
        if (key == null || key.isEmpty() || key.length() > MAX_KEY_CHARS) return false;
        for (int i = 0; i < key.length(); i++) {
            if (Character.isISOControl(key.charAt(i))) return false;
        }
        return true;
    }

    // ── 1 件の項目 ────────────────────────────────────────────────────────

    public Outcome put(String pluginId, String key, byte[] data) {
        if (!validKey(key)) return Outcome.INVALID_KEY;
        return save(ns(pluginId, "i", key), 0, data);
    }

    public Optional<byte[]> get(String pluginId, String key) {
        if (!validKey(key)) return Optional.empty();
        return checkpoints.load(ns(pluginId, "i", key), 0);
    }

    public boolean has(String pluginId, String key) {
        return get(pluginId, key).isPresent();
    }

    public void remove(String pluginId, String key) {
        if (validKey(key)) checkpoints.clearAll(ns(pluginId, "i", key));
    }

    // ── チェックポイント ─────────────────────────────────────────────────

    public Outcome saveCheckpoint(String pluginId, String jobKey, int index, byte[] data) {
        if (!validKey(jobKey)) return Outcome.INVALID_KEY;
        if (index < 0 || index > MAX_INDEX) return Outcome.INVALID_INDEX;
        return save(ns(pluginId, "c", jobKey), index, data);
    }

    public Optional<byte[]> loadCheckpoint(String pluginId, String jobKey, int index) {
        if (!validKey(jobKey) || index < 0 || index > MAX_INDEX) return Optional.empty();
        return checkpoints.load(ns(pluginId, "c", jobKey), index);
    }

    public void clearCheckpoints(String pluginId, String jobKey) {
        if (validKey(jobKey)) checkpoints.clearAll(ns(pluginId, "c", jobKey));
    }

    private Outcome save(String jobKey, int index, byte[] data) {
        if (data == null) return Outcome.WRITE_FAILED;
        if (data.length > maxItemBytes) return Outcome.TOO_LARGE;
        return checkpoints.save(jobKey, index, data) ? Outcome.OK : Outcome.WRITE_FAILED;
    }

    // ── 名前 ──────────────────────────────────────────────────────────────

    private static String ns(String pluginId, String kind, String key) {
        return "p" + hex(pluginId, 16) + "-" + hex(kind + "\0" + key, 32);
    }

    private static String hex(String s, int chars) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.substring(0, chars);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // ── JAR 向け ──────────────────────────────────────────────────────────

    /** {@code pluginId} に束縛した JAR 向けの口。 */
    public PluginCache forPlugin(String pluginId) {
        return new PluginCache() {
            @Override public byte[] get(String key) {
                return PluginCacheService.this.get(pluginId, key).orElse(null);
            }
            @Override public boolean put(String key, byte[] data) {
                return PluginCacheService.this.put(pluginId, key, data) == Outcome.OK;
            }
            @Override public boolean has(String key) {
                return PluginCacheService.this.has(pluginId, key);
            }
            @Override public void remove(String key) {
                PluginCacheService.this.remove(pluginId, key);
            }
            @Override public Checkpoint checkpoint(String jobKey) {
                return new Checkpoint() {
                    @Override public boolean save(int index, byte[] data) {
                        return saveCheckpoint(pluginId, jobKey, index, data) == Outcome.OK;
                    }
                    @Override public byte[] load(int index) {
                        return loadCheckpoint(pluginId, jobKey, index).orElse(null);
                    }
                    @Override public void clear() {
                        clearCheckpoints(pluginId, jobKey);
                    }
                };
            }
        };
    }
}

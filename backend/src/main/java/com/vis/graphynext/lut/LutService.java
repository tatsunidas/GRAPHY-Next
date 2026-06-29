/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.lut;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * classpath の luts/ フォルダにある ImageJ .lut ファイルを解析して提供するサービス。
 *
 * <h3>サポートするフォーマット</h3>
 * <ol>
 *   <li><b>ICOL バイナリ</b>: 先頭 4 バイトが {@code "ICOL"} → 32 バイトのヘッダに続き、
 *       R[0..255]、G[0..255]、B[0..255] の各 256 バイトが格納される（合計 800 バイト）。</li>
 *   <li><b>テキスト（タブ区切り）</b>: 1 行に {@code index\tR\tG\tB} 形式で 256 行。</li>
 *   <li><b>生バイナリ</b>: 768 バイト厳密（ヘッダなし R×256 + G×256 + B×256）。</li>
 * </ol>
 */
@Service
public class LutService {

    private static final Logger log = LoggerFactory.getLogger(LutService.class);

    /** ICOL バイナリヘッダサイズ（バイト）。 */
    private static final int ICOL_HEADER = 32;
    /** ICOL マジックバイト。 */
    private static final byte[] ICOL_MAGIC = {'I', 'C', 'O', 'L'};

    /** LUT RGB データ DTO。各配列は 256 要素（0-255）。 */
    public record LutData(String name, int[] r, int[] g, int[] b) {}

    private final PathMatchingResourcePatternResolver resolver =
            new PathMatchingResourcePatternResolver();

    /** classpath:luts/ に存在する LUT 名の一覧（昇順）。 */
    public List<String> listNames() {
        try {
            Resource[] resources = resolver.getResources("classpath:luts/*.lut");
            List<String> names = new ArrayList<>();
            for (Resource res : resources) {
                String filename = res.getFilename();
                if (filename != null && filename.endsWith(".lut")) {
                    names.add(filename.substring(0, filename.length() - 4));
                }
            }
            names.sort(String.CASE_INSENSITIVE_ORDER);
            return names;
        } catch (IOException e) {
            log.warn("LUT 一覧の取得に失敗: {}", e.getMessage());
            return List.of();
        }
    }

    /** 指定名（拡張子なし）の LUT を読み込む。見つからない/解析失敗時は null。 */
    public LutData load(String name) {
        Resource res = resolver.getResource("classpath:luts/" + name + ".lut");
        if (!res.exists()) {
            return null;
        }
        try (InputStream is = res.getInputStream()) {
            byte[] bytes = is.readAllBytes();
            return parse(name, bytes);
        } catch (IOException e) {
            log.warn("LUT 読み込み失敗: {} - {}", name, e.getMessage());
            return null;
        }
    }

    // ── 内部パース ────────────────────────────────────────────────

    private LutData parse(String name, byte[] bytes) {
        // ICOL バイナリ判定
        if (bytes.length >= ICOL_HEADER + 768 && startsWithIcol(bytes)) {
            return parseIcol(name, bytes);
        }
        // 生バイナリ（768 バイト厳密）
        if (bytes.length == 768) {
            return parseRaw(name, bytes);
        }
        // テキスト（タブ区切り）
        return parseText(name, bytes);
    }

    private boolean startsWithIcol(byte[] bytes) {
        for (int i = 0; i < ICOL_MAGIC.length; i++) {
            if (bytes[i] != ICOL_MAGIC[i]) return false;
        }
        return true;
    }

    /** ICOL バイナリ: 32 バイトのヘッダをスキップし、プレーナー R/G/B 各 256 バイトを読む。 */
    private LutData parseIcol(String name, byte[] bytes) {
        int[] r = new int[256];
        int[] g = new int[256];
        int[] b = new int[256];
        for (int i = 0; i < 256; i++) {
            r[i] = bytes[ICOL_HEADER + i] & 0xFF;
            g[i] = bytes[ICOL_HEADER + 256 + i] & 0xFF;
            b[i] = bytes[ICOL_HEADER + 512 + i] & 0xFF;
        }
        return new LutData(name, r, g, b);
    }

    /** 生バイナリ（768 バイト）: プレーナー R/G/B。 */
    private LutData parseRaw(String name, byte[] bytes) {
        int[] r = new int[256];
        int[] g = new int[256];
        int[] b = new int[256];
        for (int i = 0; i < 256; i++) {
            r[i] = bytes[i] & 0xFF;
            g[i] = bytes[256 + i] & 0xFF;
            b[i] = bytes[512 + i] & 0xFF;
        }
        return new LutData(name, r, g, b);
    }

    /**
     * テキスト形式（タブ区切り {@code index\tR\tG\tB}）を解析する。
     * 256 行揃わない場合は最終値を繰り返して補完する。
     */
    private LutData parseText(String name, byte[] bytes) {
        int[] r = new int[256];
        int[] g = new int[256];
        int[] b = new int[256];
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(
                        new java.io.ByteArrayInputStream(bytes), StandardCharsets.UTF_8))) {
            int row = 0;
            String line;
            while ((line = reader.readLine()) != null && row < 256) {
                line = line.strip();
                if (line.isEmpty() || line.startsWith("#")) continue;
                String[] parts = line.split("\\s+");
                if (parts.length >= 4) {
                    // 形式: index R G B
                    int idx = Integer.parseInt(parts[0]);
                    if (idx >= 0 && idx < 256) {
                        r[idx] = Integer.parseInt(parts[1]);
                        g[idx] = Integer.parseInt(parts[2]);
                        b[idx] = Integer.parseInt(parts[3]);
                    }
                } else if (parts.length == 3) {
                    // 形式: R G B（インデックスなし）
                    r[row] = Integer.parseInt(parts[0]);
                    g[row] = Integer.parseInt(parts[1]);
                    b[row] = Integer.parseInt(parts[2]);
                    row++;
                    continue;
                }
                row++;
            }
        } catch (IOException | NumberFormatException e) {
            log.warn("LUT テキスト解析失敗: {} - {}", name, e.getMessage());
            // フォールバック: グレースケール
            for (int i = 0; i < 256; i++) { r[i] = g[i] = b[i] = i; }
        }
        return new LutData(name, r, g, b);
    }
}

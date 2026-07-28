/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.manager;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * {@link Blake2b}: minisign の prehashed 署名で使う BLAKE2b-512。
 *
 * <p>期待値は<b>別実装</b>（{@code openssl dgst -blake2b512}, OpenSSL 3.5）で生成した。
 * 空入力と "abc" は RFC 7693 の公表値とも一致する。127/128/129 バイトはブロック境界
 * （128 バイト）の取りこぼしを検出するために入れている。
 */
class Blake2bTest {

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 0xF, 16)).append(Character.forDigit(x & 0xF, 16));
        return sb.toString();
    }

    /** テストベクタ生成に使ったのと同じ決定的パターン（i mod 251）。 */
    private static byte[] pattern(int n) {
        byte[] b = new byte[n];
        for (int i = 0; i < n; i++) b[i] = (byte) (i % 251);
        return b;
    }

    @Test
    void matchesRfc7693PublishedVectors() {
        assertEquals("786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419"
                        + "d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
                hex(Blake2b.digest512(new byte[0])));
        assertEquals("ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1"
                        + "7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
                hex(Blake2b.digest512("abc".getBytes(StandardCharsets.UTF_8))));
    }

    @Test
    void matchesOpensslAcrossBlockBoundaries() {
        assertEquals("b6292669ccd38d5f01caae96ba272c76a879a45743afa0725d83b9ebb26665b7"
                        + "31f1848c52f11972b6644f554c064fa90780dbbbf3a89d4fc31f67df3e5857ef",
                hex(Blake2b.digest512(pattern(127))));
        assertEquals("2319e3789c47e2daa5fe807f61bec2a1a6537fa03f19ff32e87eecbfd64b7e0e"
                        + "8ccff439ac333b040f19b0c4ddd11a61e24ac1fe0f10a039806c5dcc0da3d115",
                hex(Blake2b.digest512(pattern(128))));
        assertEquals("f59711d44a031d5f97a9413c065d1e614c417ede998590325f49bad2fd444d3e"
                        + "4418be19aec4e11449ac1a57207898bc57d76a1bcf3566292c20c683a5c4648f",
                hex(Blake2b.digest512(pattern(129))));
        assertEquals("93463ac058b6163eb43be3f5bb32b28541498f4e3366f1effe253ad44e1e076e"
                        + "41c3616046027c82a7124f8f4746668ad10b12e8e25a95ac8f3151df01cd5a93",
                hex(Blake2b.digest512(pattern(256))));
        assertEquals("e0544a2083f83329af4c725e0cf8805ce26d686a6bc33bfd2e29d5c1b5f9a889"
                        + "c44f1769e496e3586dae86e56c195908d6aa1d0e2cadad635902a37e812681ca",
                hex(Blake2b.digest512(pattern(5000))));
    }
}

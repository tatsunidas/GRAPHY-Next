/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import com.vis.graphynext.dicom.DicomProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeFalse;

/**
 * 外部ツールの実行。🔴 止まったツール（出力を閉じず、終わらない）は、時間で確実に切る。
 * 以前は、出力を EOF まで読み切ってから待つ作りで、止まったツールには時間切れが効かなかった
 * （修正前は、このテストの「約 2 秒」が、ツールが終わるまで＝30 秒かかる）。
 */
class Dcm4cheToolsTest {

    private Dcm4cheTools tools;

    @BeforeEach
    void setUp() {
        assumeFalse(System.getProperty("os.name").toLowerCase().contains("win"), "sh が無い環境（Windows）ではスキップ");
        tools = new Dcm4cheTools(new DicomProperties());
    }

    private static boolean alive(long pid) {
        return ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false);
    }

    @Test
    void aHangingToolIsCutAtTheTimeout_keepsTheOutputSoFar_andLeavesNoProcess() throws Exception {
        long t0 = System.nanoTime();
        Dcm4cheTools.Result r = tools.run(List.of("sh", "-c", "echo $$; echo line1; sleep 30"), 1500);
        long ms = (System.nanoTime() - t0) / 1_000_000;
        assertTrue(ms < 6000, "時間切れ 1.5 秒のはずが " + ms + " ms かかった（止まったツールに時間切れが効いていない）");
        assertTrue(r.timedOut());
        assertFalse(r.ok());
        assertEquals(-1, r.exitCode());
        assertTrue(r.output().contains("line1"), "それまでの出力が残っている: " + r.output());
        long pid = Long.parseLong(r.output().lines().findFirst().orElseThrow().trim());
        assertFalse(alive(pid), "強制終了したはずのプロセスが残っている");
    }

    @Test
    void descendantsAreKilledToo() throws Exception {
        // 子（孫）が残ると、Windows の .bat → java のような入れ子で、java が残る
        Dcm4cheTools.Result r = tools.run(List.of("sh", "-c", "sleep 30 & echo $!; wait"), 1500);
        assertTrue(r.timedOut());
        long child = Long.parseLong(r.output().lines().findFirst().orElseThrow().trim());
        Thread.sleep(300);
        assertFalse(alive(child), "子プロセスが残っている");
    }

    @Test
    void normalExitKeepsItsCodeAndOutput() throws Exception {
        Dcm4cheTools.Result ok = tools.run(List.of("sh", "-c", "echo hi"), 5000);
        assertTrue(ok.ok());
        assertFalse(ok.timedOut());
        assertEquals("hi", ok.output().trim());
        Dcm4cheTools.Result ng = tools.run(List.of("sh", "-c", "echo oops 1>&2; exit 3"), 5000);
        assertFalse(ng.ok());
        assertFalse(ng.timedOut());
        assertEquals(3, ng.exitCode());
        assertTrue(ng.output().contains("oops"), "標準エラーも結合される");
    }

    @Test
    void longOutputKeepsTheHeadAndTheTail() throws Exception {
        // 先頭（A-ASSOCIATE のダンプ）と末尾（最終の status・例外）の両方が、長い出力のあとも残る
        String script = "echo HEAD-MARK; i=0; while [ $i -lt 4000 ]; do echo 'filler-filler-filler-filler-filler-filler-filler'; i=$((i+1)); done; echo TAIL-MARK";
        Dcm4cheTools.Result r = tools.run(List.of("sh", "-c", script), 20_000);
        assertTrue(r.ok());
        assertTrue(r.output().contains("HEAD-MARK"), "先頭が残っている");
        assertTrue(r.output().contains("TAIL-MARK"), "末尾が残っている");
        assertTrue(r.output().contains("省略"), "間を省略した目印がある");
        assertTrue(r.output().length() < 70_000, "上限を超えて持たない: " + r.output().length());
    }

    @Test
    void boundedOutput_smallInputIsKeptWhole_andOrderIsPreserved() {
        Dcm4cheTools.BoundedOutput b = new Dcm4cheTools.BoundedOutput(Dcm4cheTools.TAIL_CHARS);
        char[] c = "abc\ndef\n".toCharArray();
        b.append(c, 0, c.length);
        assertEquals("abc\ndef\n", b.toString());
        // 先頭を超え、末尾の枠も回り込むほど長い入力: 先頭と末尾の並びが正しい
        Dcm4cheTools.BoundedOutput big = new Dcm4cheTools.BoundedOutput(Dcm4cheTools.TAIL_CHARS);
        StringBuilder sb = new StringBuilder("H");
        for (int i = 0; i < Dcm4cheTools.HEAD_CHARS + Dcm4cheTools.TAIL_CHARS * 2 + 123; i++) {
            sb.append((char) ('a' + (i % 26)));
        }
        sb.append("T");
        char[] all = sb.toString().toCharArray();
        for (int off = 0; off < all.length; off += 4096) {
            big.append(all, off, Math.min(4096, all.length - off));
        }
        String s = big.toString();
        assertTrue(s.startsWith("Ha"));
        assertTrue(s.endsWith("T"));
        // 末尾の部分は、元の文字列の末尾と一致する（回り込みの並びが崩れていない）
        String tail = s.substring(s.length() - 200);
        assertEquals(sb.substring(sb.length() - 200), tail);
    }
}

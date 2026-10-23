package com.vis.graphynext.importer;

import org.junit.jupiter.api.Test;

import java.time.Clock;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 周期処理は、起動完了（ApplicationReadyEvent → start()）まで始まらない。起動中に設定へ入ると main とデッドロックする。 */
class ImportWatchStartTest {

    private static ImportWatchService make(boolean autoRun) {
        return new ImportWatchService(null, null, null, null, null, null, null, Clock.systemUTC(), autoRun);
    }

    @Test
    void コンストラクタでは始まらず_start後に始まる() {
        ImportWatchService w = make(true);
        try {
            assertFalse(w.running(), "生成しただけでは周期処理を始めない");
            w.start();
            assertTrue(w.running());
            w.start(); // 2 回呼んでも増えない
            assertTrue(w.running());
        } finally {
            w.shutdown();
        }
    }

    @Test
    void autoRun無効ではstartしても始まらない() {
        ImportWatchService w = make(false);
        w.start();
        assertFalse(w.running());
        w.shutdown();
    }
}

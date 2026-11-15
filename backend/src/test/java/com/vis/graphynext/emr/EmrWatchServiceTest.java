/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.emr;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/** 監視の動き（tick を直接回す）: 書きかけを読まない・同じ ID では通知しない・基準は通知しない。 */
class EmrWatchServiceTest {

    @TempDir
    Path tmp;

    Map<String, String> settings;
    List<EmrPatientChanged> events;
    EmrWatchService svc;
    Path file;
    long mtime = 1_000_000;

    @BeforeEach
    void setUp() {
        file = tmp.resolve("pid.csv");
        settings = new HashMap<>(Map.of(
                EmrConfig.KEY_ENABLED, "true", EmrConfig.KEY_PATH, tmp.toString(), EmrConfig.KEY_FORMAT, "csv",
                EmrConfig.KEY_CHARSET, "UTF-8", EmrConfig.KEY_CSV_COLUMN, "患者ID", EmrConfig.KEY_CSV_HEADER, "true",
                EmrConfig.KEY_PACS_AE, "PACS", EmrConfig.KEY_RETRIEVE, "move", EmrConfig.KEY_TIMEOUT, "60"));
        events = new ArrayList<>();
        svc = new EmrWatchService(() -> settings, e -> events.add((EmrPatientChanged) e), Clock.systemUTC(), false);
    }

    /** ファイルを書く。更新時刻は、毎回違う値にする（実時間に依らず決定的に）。 */
    private void write(String id) throws IOException {
        Files.writeString(file, "患者ID,氏名\n" + id + ",X\n");
        mtime += 5_000;
        Files.setLastModifiedTime(file, FileTime.fromMillis(mtime));
    }

    /** 2 回見て、安定したとみなされるところまで進める。 */
    private void settle() {
        svc.tick();
        svc.tick();
    }

    @Test
    void firstReadIsABaseline_notANotification() throws IOException {
        write("P1");
        settle();
        assertEquals("P1", svc.patient().id());
        assertEquals(0, svc.patient().seq());
        assertEquals(0, events.size()); // 起動しただけで、前の日の患者を開かない
        assertEquals("ok", svc.file().state());
    }

    @Test
    void changeOfIdNotifiesOnce_sameIdDoesNot() throws IOException {
        write("P1");
        settle();
        write("P2");
        settle();
        assertEquals(1, events.size());
        assertEquals("P2", events.get(0).patientId());
        assertEquals(1, events.get(0).seq());
        // 同じ ID の書き直し（電子カルテが同じ患者でファイルを更新した）は、通知しない
        write("P2");
        settle();
        svc.tick();
        assertEquals(1, events.size());
        write("P3");
        settle();
        assertEquals(2, events.size());
        assertEquals(2, svc.patient().seq());
    }

    @Test
    void doesNotReadWhileTheFileIsStillChanging() throws IOException {
        write("P1");
        settle();
        write("P2");
        svc.tick(); // 変わったのを初めて見た: まだ読まない
        assertEquals("P1", svc.patient().id());
        write("P3"); // 書き続けている（もう 1 回変わった）
        svc.tick(); // また変わった: まだ読まない
        assertEquals("P1", svc.patient().id());
        assertEquals(0, events.size());
        svc.tick(); // 止まった: 読む
        assertEquals("P3", svc.patient().id());
        assertEquals(1, events.size()); // P2 は通知されない（途中の値を拾わない）
    }

    @Test
    void unreadableContent_keepsTheCurrentPatient_andReportsTheReasonOnly() throws IOException {
        write("P1");
        settle();
        Files.writeString(file, "患者ID,氏名\nbad id with spaces,X\n");
        mtime += 5_000;
        Files.setLastModifiedTime(file, FileTime.fromMillis(mtime));
        settle();
        assertEquals("P1", svc.patient().id()); // 読めない内容で、患者を消さない・変えない
        assertEquals("error", svc.file().state());
        assertEquals("id-invalid", svc.file().error());
        assertEquals(0, events.size());
    }

    @Test
    void missingFile_thenItAppears() throws IOException {
        settle();
        assertEquals("missing", svc.file().state());
        assertNull(svc.patient());
        write("P1");
        settle();
        assertEquals("P1", svc.patient().id());
        assertEquals(0, events.size()); // 最初に読めたものは基準
    }

    @Test
    void disabledOrInvalidDoesNothing_andReEnablingBaselinesAgain() throws IOException {
        write("P1");
        settings.put(EmrConfig.KEY_ENABLED, "false");
        settle();
        assertEquals("disabled", svc.file().state());
        assertNull(svc.patient());
        settings.put(EmrConfig.KEY_ENABLED, "true");
        settings.remove(EmrConfig.KEY_PACS_AE);
        settle();
        assertEquals("invalid", svc.file().state());
        assertEquals("pacs-ae-required", svc.file().error());
        settings.put(EmrConfig.KEY_PACS_AE, "PACS");
        settle();
        assertEquals("P1", svc.patient().id());
        assertEquals(0, events.size());
    }

    @Test
    void changingTheReadingSettingReparsesTheSameFile_withoutNotifying() throws IOException {
        Files.writeString(file, "患者ID,氏名\nP1,山田\n");
        settle();
        assertEquals("P1", svc.patient().id());
        settings.put(EmrConfig.KEY_CSV_COLUMN, "氏名"); // 設定を変えると、同じファイルを読み直す
        settle();
        assertEquals("山田", svc.patient().id()); // 読み直した（日本語の名前も、ID の形としては通る）
        assertEquals(0, events.size()); // 設定を触っただけで、患者を開かない（基準として覚えるだけ）
        settings.put(EmrConfig.KEY_CSV_COLUMN, "存在しない列");
        settle();
        assertEquals("error", svc.file().state());
        assertEquals("column-not-found", svc.file().error());
        assertEquals("山田", svc.patient().id()); // 読めなくなっても、いまの患者は変えない
    }

    @Test
    void readNow_readsWithoutWaitingAndWithoutChangingState() throws IOException {
        write("P9");
        EmrFileReader.Result r = svc.readNow();
        assertEquals("P9", r.patientId());
        assertNull(svc.patient()); // 状態は変えない
        settings.put(EmrConfig.KEY_PATH, tmp.resolve("none").toString());
        assertEquals("file-missing", svc.readNow().error());
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.facility;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Clock;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 監視の動き（tick を直接回す）: 書きかけを読まない・壊れたら直前を保つ・パスの決め方（Web は設定を使わない）。 */
class FacilityConfigWatchServiceTest {

    @TempDir
    Path tmp;

    Map<String, String> settings;
    Path file;
    long mtime = 1_000_000;

    @BeforeEach
    void setUp() {
        file = tmp.resolve("facility.json");
        settings = new HashMap<>();
    }

    private FacilityConfigWatchService svc(String serverPath, boolean standalone) {
        return new FacilityConfigWatchService(() -> settings, Clock.systemUTC(), serverPath, standalone, false);
    }

    private void write(String json) throws IOException {
        Files.writeString(file, json);
        mtime += 5_000;
        Files.setLastModifiedTime(file, FileTime.fromMillis(mtime));
    }

    private static String cfg(String groupTitle) {
        return "{\"schemaVersion\":1,\"groups\":[{\"id\":\"g\",\"title\":\"" + groupTitle + "\"}]}";
    }

    private static void settle(FacilityConfigWatchService s) {
        s.tick();
        s.tick();
    }

    @Test
    void 未設定なら_unconfigured() {
        FacilityConfigWatchService s = svc("", true);
        s.tick();
        assertEquals("unconfigured", s.state().state());
        assertNull(s.config());
    }

    @Test
    void 設定のパスのファイルが2回続けて同じになってから読まれ_書き換えは再起動なしで反映される() throws IOException {
        FacilityConfigWatchService s = svc("", true);
        settings.put(FacilityConfigWatchService.KEY_PATH, file.toString());
        write(cfg("A"));
        s.tick(); // 初めて見た
        assertNull(s.config(), "1 回目では読まない（書きかけの恐れ）");
        s.tick();
        assertEquals("ok", s.state().state());
        assertEquals("setting", s.state().source());
        assertEquals("A", s.config().groups().get(0).title());
        int rev = s.state().rev();

        write(cfg("B"));
        s.tick();
        assertEquals("A", s.config().groups().get(0).title(), "変わった直後はまだ読まない");
        s.tick();
        assertEquals("B", s.config().groups().get(0).title());
        assertTrue(s.state().rev() > rev);
    }

    @Test
    void 同じ内容の書き直しでは_revが進まない() throws IOException {
        FacilityConfigWatchService s = svc("", true);
        settings.put(FacilityConfigWatchService.KEY_PATH, file.toString());
        write(cfg("A"));
        settle(s);
        int rev = s.state().rev();
        write(cfg("A")); // 更新時刻だけ変わる
        settle(s);
        assertEquals("ok", s.state().state());
        assertEquals(rev, s.state().rev());
    }

    @Test
    void 壊れたら直前の有効な内容を保ち_理由と場所だけを出し_直ると戻る() throws IOException {
        FacilityConfigWatchService s = svc("", true);
        settings.put(FacilityConfigWatchService.KEY_PATH, file.toString());
        write(cfg("A"));
        settle(s);
        write("{\"schemaVersion\":1,\"groups\":[{\"id\":\"g\",\"title\":\"T\",\"items\":[{\"type\":\"link\",\"title\":\"x\",\"url\":\"javascript:alert(1)\"}]}]}");
        settle(s);
        assertEquals("error", s.state().state());
        assertEquals("url", s.state().error());
        assertEquals("groups[0].items[0].url", s.state().errorPath());
        assertEquals("A", s.config().groups().get(0).title(), "直前の有効な内容が残る");
        write(cfg("C"));
        settle(s);
        assertEquals("ok", s.state().state());
        assertEquals("C", s.config().groups().get(0).title());
    }

    @Test
    void ファイルが無い_消えた_ときの状態() throws IOException {
        FacilityConfigWatchService s = svc("", true);
        settings.put(FacilityConfigWatchService.KEY_PATH, file.toString());
        s.tick();
        assertEquals("missing", s.state().state());
        assertEquals("file-missing", s.state().error());
        write(cfg("A"));
        settle(s);
        Files.delete(file);
        s.tick();
        assertEquals("missing", s.state().state());
        assertNotNull(s.config(), "一時的に消えても、直前の内容は残す");
    }

    @Test
    void パスを変えると_前のファイルの内容は捨てて読み直す() throws IOException {
        FacilityConfigWatchService s = svc("", true);
        settings.put(FacilityConfigWatchService.KEY_PATH, file.toString());
        write(cfg("A"));
        settle(s);
        settings.put(FacilityConfigWatchService.KEY_PATH, tmp.resolve("other.json").toString());
        s.tick();
        assertNull(s.config());
        assertEquals("missing", s.state().state());
        settings.remove(FacilityConfigWatchService.KEY_PATH);
        s.tick();
        assertEquals("unconfigured", s.state().state());
    }

    @Test
    void サーバー側のパスがあれば設定より優先される() throws IOException {
        Path server = tmp.resolve("server.json");
        Files.writeString(server, cfg("SERVER"));
        Files.setLastModifiedTime(server, FileTime.fromMillis(1_000));
        write(cfg("SETTING"));
        settings.put(FacilityConfigWatchService.KEY_PATH, file.toString());
        FacilityConfigWatchService s = svc(server.toString(), true);
        settle(s);
        assertEquals("server", s.state().source());
        assertEquals("SERVER", s.config().groups().get(0).title());
    }

    @Test
    void 負例_Webでは_設定のパスを使わない() throws IOException {
        write(cfg("SETTING"));
        settings.put(FacilityConfigWatchService.KEY_PATH, file.toString()); // 利用者が書き換えられる設定
        FacilityConfigWatchService web = svc("", false); // standalone でない
        settle(web);
        assertEquals("unconfigured", web.state().state());
        assertNull(web.config());
        // 同じ設定でも standalone なら読める（上の負例が意味を持つ）
        FacilityConfigWatchService local = svc("", true);
        settle(local);
        assertEquals("ok", local.state().state());
    }

    @Test
    void 上限超過_拡張子違い_は理由のコード() throws IOException {
        FacilityConfigWatchService s = svc("", true);
        Path txt = tmp.resolve("x.txt");
        Files.writeString(txt, cfg("A"));
        settings.put(FacilityConfigWatchService.KEY_PATH, txt.toString());
        settle(s);
        assertEquals("error", s.state().state());
        assertEquals("extension-not-allowed", s.state().error());
    }
}

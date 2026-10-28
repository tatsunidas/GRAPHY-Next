/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.discovery;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** macOS の {@code dns-sd} の出力の解析。試験データは macOS 26（CI ランナー）で実測した出力そのもの。 */
class DnsSdEngineParseTest {

    private static final String HOST = "sjc20-bb660-65edfc5b-2f35-42c3-ac6a-a58a5ce032ae-8647BB4B8EEA.local.";

    private static final List<String> BROWSE = List.of(
            "Browsing for _dicom._tcp.local",
            "DATE: ---Tue 27 Oct 2026---",
            "11:40:37.917  ...STARTING...",
            "Timestamp     A/R    Flags  if Domain               Service Type         Instance Name",
            "11:40:37.918  Add        3   1 local.               _dicom._tcp.         DIAG AE",
            "11:40:37.918  Add        2   7 local.               _dicom._tcp.         DIAG AE",
            "11:40:38.001  Rmv        0   7 local.               _dicom._tcp.         GONE");

    private static final List<String> LOOKUP = List.of(
            "Lookup DIAG AE._dicom._tcp.local",
            "DATE: ---Tue 27 Oct 2026---",
            "11:40:41.971  ...STARTING...",
            "11:40:41.974  DIAG\\032AE._dicom._tcp.local. can be reached at " + HOST + ":11999 (interface 7) Flags: 1",
            " aet=DIAG\\ AE tls=0 tlsPort=0 app=1.2.3",
            "11:40:41.974  DIAG\\032AE._dicom._tcp.local. can be reached at " + HOST + ":11999 (interface 7)",
            " aet=DIAG\\ AE tls=0 tlsPort=0 app=1.2.3");

    private static final List<String> ADDRESS = List.of(
            "DATE: ---Tue 27 Oct 2026---",
            "11:40:46.029  ...STARTING...",
            "Timestamp     A/R  Flags         IF  Hostname                               Address                                      TTL",
            "11:40:46.031  Add  40000002      -1  " + HOST + " 192.168.64.5                                 1");

    @Test
    void 一覧から_見つかった名前を重複なしで取る_消えた名前は取らない() {
        assertEquals(Set.of("DIAG AE"), DnsSdEngine.parseBrowse(BROWSE), "空白を含む名前・2 つの NIC の重複・Rmv の行");
    }

    @Test
    void 解決から_ホスト_ポート_TXTを取る() {
        DnsSdEngine.Resolved r = DnsSdEngine.parseLookup(LOOKUP);
        assertEquals(HOST, r.host());
        assertEquals(11999, r.port());
        assertEquals("DIAG AE", r.txt().get("aet"), "値の空白のエスケープ（バックスラッシュ＋空白）を戻す");
        assertEquals("0", r.txt().get("tls"));
        assertEquals("0", r.txt().get("tlsPort"));
        assertEquals("1.2.3", r.txt().get("app"));
    }

    @Test
    void アドレスの行から_IPv4を取る() {
        assertEquals("192.168.64.5", DnsSdEngine.parseAddress(ADDRESS));
    }

    @Test
    void 解決できていない出力は_nullを返す() {
        assertNull(DnsSdEngine.parseLookup(List.of("Lookup X._dicom._tcp.local", "11:40:41.971  ...STARTING...")));
        assertNull(DnsSdEngine.parseAddress(List.of("11:40:46.029  ...STARTING...")));
        assertTrue(DnsSdEngine.parseBrowse(List.of()).isEmpty());
    }

    @Test
    void TXTの10進エスケープも戻す() {
        Map<String, String> txt = DnsSdEngine.parseTxt(" aet=A\\032B tls=1");
        assertEquals("A B", txt.get("aet"));
        assertEquals("1", txt.get("tls"));
    }

    @Test
    void 登録完了の行を見分ける() {
        assertTrue(DnsSdEngine.isRegistered("11:40:34.536  Got a reply for service DIAG AE._dicom._tcp.local.: Name now registered and active"));
        assertTrue(!DnsSdEngine.isRegistered("11:40:33.849  ...STARTING..."));
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.discovery;

import com.vis.graphynext.dicom.discovery.DicomDiscoveryService.ScpState;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** エンジンを偽物にして、広告の条件と結果の整形を確かめる（ネットワークに出ない。全 OS で動く）。 */
class DicomDiscoveryServiceEngineTest {

    /** 呼ばれた回数と引数を数えるだけのエンジン。 */
    private static final class FakeEngine implements MdnsEngine {
        final AtomicInteger advertised = new AtomicInteger();
        final AtomicInteger stopped = new AtomicInteger();
        final AtomicInteger browsed = new AtomicInteger();
        String name;
        int port;
        Map<String, String> txt;
        IOException failure;
        List<Peer> peers = new ArrayList<>();

        @Override
        public Advertisement advertise(String name, int port, Map<String, String> txt, List<InetAddress> addresses)
                throws IOException {
            advertised.incrementAndGet();
            if (failure != null) {
                throw failure;
            }
            this.name = name;
            this.port = port;
            this.txt = txt;
            return stopped::incrementAndGet;
        }

        @Override
        public List<Peer> browse(List<InetAddress> addresses) {
            browsed.incrementAndGet();
            return peers;
        }
    }

    private static DicomDiscoveryService service(FakeEngine e, boolean on, boolean running, int tlsPort) {
        return new DicomDiscoveryService(() -> on, () -> new ScpState(running, "MYAE", 11112, tlsPort),
                () -> List.of(InetAddress.getLoopbackAddress()), e, "1.0");
    }

    @Test
    void 設定がオフなら_エンジンを使わない() {
        FakeEngine e = new FakeEngine();
        DicomDiscoveryService s = service(e, false, true, -1);
        s.startAdvertising();
        assertEquals(0, e.advertised.get(), "オフでは JmDNS も dns-sd も起こさない");
        assertFalse(s.status().advertising());
        assertEquals("設定がオフです", s.status().reason());
    }

    @Test
    void SCPが止まっていれば_エンジンを使わない() {
        FakeEngine e = new FakeEngine();
        DicomDiscoveryService s = service(e, true, false, -1);
        s.startAdvertising();
        assertEquals(0, e.advertised.get());
        assertTrue(s.status().reason().contains("SCP"));
    }

    @Test
    void オンでSCPが動いていれば_AE_ポート_TXTを渡して広告する() {
        FakeEngine e = new FakeEngine();
        DicomDiscoveryService s = service(e, true, true, 2762);
        s.startAdvertising();
        assertEquals(1, e.advertised.get());
        assertEquals("MYAE", e.name);
        assertEquals(11112, e.port);
        assertEquals(Set.of("aet", "tls", "tlsPort", "app"), e.txt.keySet());
        assertEquals("1", e.txt.get("tls"));
        assertEquals("2762", e.txt.get("tlsPort"));
        assertTrue(s.status().advertising());
        s.startAdvertising(); // 2 回目は何もしない
        assertEquals(1, e.advertised.get());
        s.shutdown();
        assertEquals(1, e.stopped.get(), "停止でエンジンの広告を止める");
        assertFalse(s.status().advertising());
    }

    @Test
    void エンジンが失敗したら_理由を状態に出し_例外にしない() {
        FakeEngine e = new FakeEngine();
        e.failure = new IOException("Address already in use");
        DicomDiscoveryService s = service(e, true, true, -1);
        s.startAdvertising();
        assertFalse(s.status().advertising());
        assertTrue(s.status().reason().contains("Address already in use"), s.status().reason());
        assertNull(s.status().serviceName());
    }

    @Test
    void 探索の結果は_自局を除き_TXTが無ければ名前をAEに使い_重複をまとめる() throws Exception {
        FakeEngine e = new FakeEngine();
        e.peers = List.of(
                new MdnsEngine.Peer("MYAE", "MYAE", "10.0.0.1", 11112, "0", "0"),        // 自局
                new MdnsEngine.Peer("PEER", "PEERAE", "10.0.0.2", 104, "1", "2762"),
                new MdnsEngine.Peer("PEER", "PEERAE", "10.0.0.2", 104, "1", "2762"),     // 同じ相手の重複
                new MdnsEngine.Peer("NOTXT", null, "10.0.0.3", 11113, null, null),
                new MdnsEngine.Peer("TLS0", "TLS0", "10.0.0.4", 11114, "1", "0"));        // tls=1 でも tlsPort が無ければ TLS なし
        List<DicomDiscoveryService.Found> found = service(e, true, true, -1).scan();
        assertEquals(List.of("NOTXT", "PEER", "TLS0"), found.stream().map(DicomDiscoveryService.Found::name).toList());
        DicomDiscoveryService.Found peer = found.get(1);
        assertEquals("PEERAE", peer.aeTitle());
        assertTrue(peer.tls());
        assertEquals(2762, peer.tlsPort());
        DicomDiscoveryService.Found notxt = found.get(0);
        assertTrue(notxt.aeTitleFromName());
        assertEquals("NOTXT", notxt.aeTitle());
        assertFalse(notxt.tls());
        assertFalse(found.get(2).tls());
    }
}

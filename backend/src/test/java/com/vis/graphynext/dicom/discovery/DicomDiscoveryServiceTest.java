/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.discovery;

import com.vis.graphynext.dicom.discovery.DicomDiscoveryService.Found;
import com.vis.graphynext.dicom.discovery.DicomDiscoveryService.ScpState;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * mDNS の広告・探索を、実際に JmDNS を 2 つ立てて検証する（同じ JVM・同じ NIC。マルチキャストが使える NIC が
 * 無い環境では、合格にせず未達として外す）。サービス名は実行ごとに一意にして、同じ LAN の他の機器と混ざらないようにする。
 */
class DicomDiscoveryServiceTest {

    private List<InetAddress> addrs;
    private final List<DicomDiscoveryService> created = new ArrayList<>();
    private final String tag = UUID.randomUUID().toString().substring(0, 6).toUpperCase();

    /** この環境で mDNS が実際に往復するか（最初の 1 回だけ確かめる）。CI のランナーなどマルチキャストが通らない環境では未達として外す。 */
    private static Boolean mdnsWorks;

    @BeforeEach
    void setUp() throws Exception {
        addrs = DicomDiscoveryService.pickAddresses();
        Assumptions.assumeFalse(addrs.get(0).isLoopbackAddress(), "マルチキャストが使える非ループバックの NIC が無い環境");
        synchronized (DicomDiscoveryServiceTest.class) {
            if (mdnsWorks == null) {
                String probe = "PRB" + tag;
                DicomDiscoveryService a = service(true, true, probe, 11130, -1);
                DicomDiscoveryService b = service(false, true, "PRS" + tag, 11131, -1);
                advertiseAndSettle(a);
                try {
                    mdnsWorks = find(b.scan(), probe) != null;
                } catch (java.io.IOException e) {
                    mdnsWorks = false; // bind できない・dns-sd が無いなど
                }
                a.shutdown();
            }
        }
        Assumptions.assumeTrue(mdnsWorks, "この環境では mDNS（マルチキャスト）が往復しない");
    }

    @AfterEach
    void tearDown() {
        created.forEach(DicomDiscoveryService::shutdown);
    }

    private DicomDiscoveryService service(boolean advertise, boolean running, String ae, int port, int tlsPort) {
        Supplier<Boolean> on = () -> advertise;
        DicomDiscoveryService s = new DicomDiscoveryService(on, () -> new ScpState(running, ae, port, tlsPort), () -> addrs, MdnsEngine.forCurrentOs(), "9.9.9-test");
        created.add(s);
        return s;
    }

    private String ae(String base) {
        return base + tag;
    }

    /**
     * 広告を始め、JmDNS の重複確認（probing）と告知が終わるのを待つ。直後に探索すると、まだ応答できず 0 件になる
     * （実測: 待たないと 0 件、約 2 秒待つと見える）。実際の利用では、探索は広告を始めてからずっと後に押される。
     */
    private void advertiseAndSettle(DicomDiscoveryService s) throws Exception {
        s.startAdvertising();
        Thread.sleep(2500);
    }

    private static Found find(List<Found> list, String aet) {
        return list.stream().filter(f -> f.aeTitle().equals(aet)).findFirst().orElse(null);
    }

    @Test
    void 広告をオンにすると_別のインスタンスから見える_TXTは実際の待受と一致() throws Exception {
        DicomDiscoveryService a = service(true, true, ae("ADV"), 11112, 2762);
        DicomDiscoveryService b = service(false, true, ae("SCN"), 11999, -1);
        advertiseAndSettle(a);
        assertTrue(a.status().advertising(), a.status().reason());

        Found f = find(b.scan(), ae("ADV"));
        assertTrue(f != null, "広告した相手が見つかる");
        assertEquals(11112, f.port());
        assertTrue(f.tls());
        assertEquals(2762, f.tlsPort());
        assertFalse(f.aeTitleFromName(), "TXT の aet を使う");
        assertTrue(addrs.stream().anyMatch(x -> x.getHostAddress().equals(f.host())), "使った NIC のアドレスで見える: " + f.host());
    }

    @Test
    void 平文だけの待受なら_TLSなしで見える() throws Exception {
        DicomDiscoveryService a = service(true, true, ae("PLN"), 11113, -1);
        DicomDiscoveryService b = service(false, true, ae("SCN"), 11999, -1);
        advertiseAndSettle(a);
        Found f = find(b.scan(), ae("PLN"));
        assertTrue(f != null);
        assertFalse(f.tls());
        assertEquals(0, f.tlsPort());
        assertEquals("0", a.status().txt().get("tls"));
    }

    @Test
    void 広告をオフにすると_何も流れず_見つからない() throws Exception {
        DicomDiscoveryService a = service(false, true, ae("OFF"), 11114, -1);
        DicomDiscoveryService control = service(true, true, ae("CTL"), 11120, -1); // 対照: 同じ条件で広告すれば見える
        DicomDiscoveryService b = service(false, true, ae("SCN"), 11999, -1);
        a.startAdvertising();
        advertiseAndSettle(control);
        assertFalse(a.status().advertising());
        assertEquals("設定がオフです", a.status().reason());
        List<Found> seen = b.scan();
        assertTrue(find(seen, ae("CTL")) != null, "前提: 探索が効いている（対照は見える）");
        assertTrue(find(seen, ae("OFF")) == null, "オフでは見つからない");
    }

    @Test
    void SCPが止まっているときは_広告しない() throws Exception {
        DicomDiscoveryService a = service(true, false, ae("STP"), 11115, -1);
        DicomDiscoveryService control = service(true, true, ae("CTL"), 11120, -1);
        DicomDiscoveryService b = service(false, true, ae("SCN"), 11999, -1);
        a.startAdvertising();
        advertiseAndSettle(control);
        assertFalse(a.status().advertising());
        assertTrue(a.status().reason().contains("SCP"), a.status().reason());
        List<Found> seen = b.scan();
        assertTrue(find(seen, ae("CTL")) != null, "前提: 探索が効いている（対照は見える）");
        assertTrue(find(seen, ae("STP")) == null);
    }

    @Test
    void 自分自身は探索の結果に出さない() throws Exception {
        DicomDiscoveryService a = service(true, true, ae("SLF"), 11116, -1);
        DicomDiscoveryService other = service(true, true, ae("OTH"), 11121, -1);
        advertiseAndSettle(a);
        other.startAdvertising();
        Thread.sleep(2500);
        List<Found> seen = a.scan();
        assertTrue(find(seen, ae("OTH")) != null, "前提: 探索が効いている（他者は見える）");
        assertTrue(find(seen, ae("SLF")) == null, "自局は除く");
    }

    @Test
    void TXTには_AEタイトル_ポート_TLS_版しか入らない() {
        DicomDiscoveryService a = service(true, true, ae("TXT"), 11117, 2762);
        a.startAdvertising();
        assertEquals(Set.of("aet", "tls", "tlsPort", "app"), a.status().txt().keySet(), "患者情報などは流さない");
        assertEquals("9.9.9-test", a.status().txt().get("app"));
        assertEquals(ae("TXT"), a.status().txt().get("aet"));
    }

    @Test
    void 停止すると広告が消える() throws Exception {
        DicomDiscoveryService a = service(true, true, ae("DWN"), 11118, -1);
        DicomDiscoveryService b = service(false, true, ae("SCN"), 11999, -1);
        advertiseAndSettle(a);
        assertTrue(find(b.scan(), ae("DWN")) != null, "前提: 広告中は見える");
        a.shutdown();
        assertFalse(a.status().advertising());
        assertTrue(find(b.scan(), ae("DWN")) == null, "停止後は見つからない");
    }
}

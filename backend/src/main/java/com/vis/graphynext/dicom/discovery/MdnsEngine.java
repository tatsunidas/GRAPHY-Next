/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.discovery;

import java.io.IOException;
import java.net.InetAddress;
import java.util.List;
import java.util.Map;

/**
 * mDNS/DNS-SD の実装の差し替え口。OS によって使える部品が違う:
 * Linux・Windows は JmDNS（{@link JmDnsEngine}）、macOS は OS 標準の {@code dns-sd}（{@link DnsSdEngine}）。
 * macOS では mDNSResponder が UDP 5353 を持っていて、JmDNS が NIC のアドレスへ bind できない（CI の実測）。
 */
interface MdnsEngine {

    /** DNS-SD のサービス型（IANA にサービス名 dicom が登録されている）。 */
    String TYPE = "_dicom._tcp.local.";

    /** 探索で見つかった相手（TXT の生の値。整形は呼び出し側）。 */
    record Peer(String name, String txtAet, String host, int port, String txtTls, String txtTlsPort) {
    }

    /** 広告の停止口。 */
    interface Advertisement {
        void stop();
    }

    /**
     * 広告を始める。失敗したら例外（どの NIC で・なぜ失敗したかをメッセージに含める）。
     *
     * @param addresses 使う NIC のアドレス（エンジンによっては無視する）
     */
    Advertisement advertise(String name, int port, Map<String, String> txt, List<InetAddress> addresses) throws IOException;

    /** 約 3 秒探して、見つかった相手を返す。 */
    List<Peer> browse(List<InetAddress> addresses) throws IOException;

    /** 実行中の OS に合うエンジン。 */
    static MdnsEngine forCurrentOs() {
        String os = System.getProperty("os.name", "").toLowerCase();
        return os.contains("mac") || os.contains("darwin") ? new DnsSdEngine() : new JmDnsEngine();
    }
}

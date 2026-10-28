/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.discovery;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.jmdns.JmDNS;
import javax.jmdns.ServiceInfo;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * JmDNS による mDNS（Linux・Windows）。NIC のアドレスごとに JmDNS を 1 つ立てる。
 * ホスト名は固定文字列で、自局のホスト名を正引きしない（名前解決で起動が遅れた前例）。
 */
final class JmDnsEngine implements MdnsEngine {

    private static final Logger log = LoggerFactory.getLogger(JmDnsEngine.class);
    private static final String HOST_NAME = "graphy-next";
    private static final int SCAN_MILLIS = 3000;
    private static final int RESOLVE_MILLIS = 1500;

    @Override
    public Advertisement advertise(String name, int port, Map<String, String> txt, List<InetAddress> addresses)
            throws IOException {
        List<JmDNS> started = new ArrayList<>();
        List<String> failures = new ArrayList<>();
        // 有線・無線など複数の NIC があるとき、どれか 1 つに決めず、使えるすべての NIC で知らせる。
        for (InetAddress a : addresses) {
            try {
                JmDNS j = JmDNS.create(a, HOST_NAME);
                j.registerService(ServiceInfo.create(TYPE, name, port, 0, 0, txt));
                started.add(j);
                log.info("mDNS 広告を開始（JmDNS）: {} {} port={} via {}", TYPE, name, port, a);
            } catch (IOException | RuntimeException e) {
                failures.add(a + ": " + e.getMessage());
                log.warn("mDNS 広告を開始できません（{}）: {}", a, e.toString());
            }
        }
        if (started.isEmpty()) {
            throw new IOException(String.join(" / ", failures));
        }
        return () -> {
            for (JmDNS j : started) {
                try {
                    j.unregisterAllServices();
                } catch (RuntimeException ignore) {
                    // 終了時のベストエフォート
                }
                closeQuietly(j);
            }
        };
    }

    @Override
    public List<Peer> browse(List<InetAddress> addresses) throws IOException {
        // NIC ごとに並行して探す（逐次だと NIC の数だけ待つ）。
        List<List<Peer>> parts = new ArrayList<>();
        List<IOException> errors = new ArrayList<>();
        List<Thread> threads = new ArrayList<>();
        for (InetAddress a : addresses) {
            Thread t = new Thread(() -> {
                try {
                    List<Peer> r = browseOn(a);
                    synchronized (parts) {
                        parts.add(r);
                    }
                } catch (IOException e) {
                    synchronized (errors) {
                        errors.add(e);
                    }
                }
            }, "dicom-discovery-scan");
            t.setDaemon(true);
            threads.add(t);
            t.start();
        }
        for (Thread t : threads) {
            try {
                t.join();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        if (parts.isEmpty() && !errors.isEmpty()) {
            throw errors.get(0);
        }
        List<Peer> out = new ArrayList<>();
        parts.forEach(out::addAll);
        return out;
    }

    private List<Peer> browseOn(InetAddress addr) throws IOException {
        JmDNS j = JmDNS.create(addr, HOST_NAME);
        try {
            List<Peer> out = new ArrayList<>();
            for (ServiceInfo listed : j.list(TYPE, SCAN_MILLIS)) {
                ServiceInfo i = listed;
                if (hostOf(i) == null || i.getPropertyString("aet") == null) {
                    // 一覧の時点で、アドレスや TXT がまだ解決できていない相手は、名前を指定して解決し直す
                    ServiceInfo resolved = j.getServiceInfo(TYPE, listed.getName(), RESOLVE_MILLIS);
                    if (resolved != null) {
                        i = resolved;
                    }
                }
                String host = hostOf(i);
                if (host == null) {
                    continue;
                }
                out.add(new Peer(i.getName(), i.getPropertyString("aet"), host, i.getPort(),
                        i.getPropertyString("tls"), i.getPropertyString("tlsPort")));
            }
            return out;
        } finally {
            closeQuietly(j);
        }
    }

    private static String hostOf(ServiceInfo i) {
        Inet4Address[] v4 = i.getInet4Addresses();
        if (v4 != null && v4.length > 0) {
            return v4[0].getHostAddress();
        }
        String[] any = i.getHostAddresses();
        return any != null && any.length > 0 ? any[0] : null;
    }

    private static void closeQuietly(JmDNS j) {
        try {
            j.close();
        } catch (IOException | RuntimeException ignore) {
            // ベストエフォート
        }
    }
}

package com.vis.graphynext.dicom.discovery;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

import javax.jmdns.JmDNS;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.util.Collections;

/** 一時の診断（マージ前に消す）。macOS の CI で mDNS が bind できない理由を調べる。 */
class MdnsMacDiagTest {

    private static String sh(String... cmd) {
        try {
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            return new String(p.getInputStream().readAllBytes());
        } catch (Exception e) {
            return "ERR " + e;
        }
    }

    @Test
    void diag() throws Exception {
        Assumptions.assumeTrue(System.getProperty("os.name").toLowerCase().contains("mac"));
        System.out.println("DIAG os=" + System.getProperty("os.name") + " " + System.getProperty("os.version") + " java=" + System.getProperty("java.version")
                + " preferIPv4=" + System.getProperty("java.net.preferIPv4Stack"));
        System.out.println("DIAG lsof 5353:\n" + sh("/bin/sh", "-c", "lsof -nP -iUDP:5353 2>&1 | head -20"));
        for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
            System.out.println("DIAG nic " + ni.getName() + " up=" + ni.isUp() + " mc=" + ni.supportsMulticast() + " " + Collections.list(ni.getInetAddresses()));
        }
        InetAddress addr = DicomDiscoveryService.pickAddresses().get(0);
        System.out.println("DIAG addr=" + addr);
        // 1) JmDNS そのまま
        try {
            JmDNS j = JmDNS.create(addr, "graphy-next");
            System.out.println("DIAG jmdns create OK");
            j.close();
        } catch (Exception e) {
            System.out.println("DIAG jmdns create FAIL " + e);
        }
        // 2) 素の MulticastSocket の各種 bind
        String[] variants = {"wildcard+reuse", "wildcard-noreuse", "ipv4wild+reuse", "addr+reuse"};
        for (String v : variants) {
            try (MulticastSocket s = new MulticastSocket(null)) {
                if (v.endsWith("+reuse")) {
                    s.setReuseAddress(true);
                }
                InetSocketAddress sa = switch (v) {
                    case "ipv4wild+reuse" -> new InetSocketAddress(InetAddress.getByName("0.0.0.0"), 5353);
                    case "addr+reuse" -> new InetSocketAddress(addr, 5353);
                    default -> new InetSocketAddress(5353);
                };
                s.bind(sa);
                System.out.println("DIAG bind " + v + " OK local=" + s.getLocalSocketAddress());
            } catch (Exception e) {
                System.out.println("DIAG bind " + v + " FAIL " + e);
            }
        }
    }
}

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

    /** 子プロセスを seconds 秒だけ動かして、出力をそのまま返す。 */
    private static String run(int seconds, String... cmd) throws Exception {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        StringBuilder sb = new StringBuilder();
        Thread t = new Thread(() -> {
            try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(p.getInputStream()))) {
                String line;
                while ((line = r.readLine()) != null) {
                    synchronized (sb) {
                        sb.append(line).append('\n');
                    }
                }
            } catch (Exception ignore) {
                // 終了時
            }
        });
        t.setDaemon(true);
        t.start();
        Thread.sleep(seconds * 1000L);
        p.destroy();
        t.join(2000);
        synchronized (sb) {
            return sb.toString();
        }
    }

    @Test
    void dnsSdFormats() throws Exception {
        Assumptions.assumeTrue(System.getProperty("os.name").toLowerCase().contains("mac"));
        System.out.println("DIAG which dns-sd: " + sh("/bin/sh", "-c", "which dns-sd; ls -la $(which dns-sd)"));
        Process reg = new ProcessBuilder("dns-sd", "-R", "DIAG AE", "_dicom._tcp", "local", "11999",
                "aet=DIAG AE", "tls=0", "tlsPort=0", "app=1.2.3").redirectErrorStream(true).start();
        StringBuilder regOut = new StringBuilder();
        Thread rt = new Thread(() -> {
            try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(reg.getInputStream()))) {
                String line;
                while ((line = r.readLine()) != null) {
                    synchronized (regOut) {
                        regOut.append(line).append('\n');
                    }
                }
            } catch (Exception ignore) {
                // 終了時
            }
        });
        rt.setDaemon(true);
        rt.start();
        try {
            Thread.sleep(4000);
            synchronized (regOut) {
                System.out.println("DIAG -R output:\n" + regOut);
            }
            System.out.println("DIAG -B output:\n" + run(4, "dns-sd", "-B", "_dicom._tcp", "local"));
            System.out.println("DIAG -L output:\n" + run(4, "dns-sd", "-L", "DIAG AE", "_dicom._tcp", "local"));
            System.out.println("DIAG -G v4 localhost-name output:\n" + run(3, "dns-sd", "-G", "v4", java.net.InetAddress.getLocalHost().getHostName()));
            System.out.println("DIAG hostname: " + sh("/bin/sh", "-c", "hostname; scutil --get LocalHostName 2>&1"));
        } finally {
            reg.destroy();
        }
    }
}

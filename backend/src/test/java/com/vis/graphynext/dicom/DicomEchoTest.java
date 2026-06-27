package com.vis.graphynext.dicom;

import org.junit.jupiter.api.Test;

import java.net.ServerSocket;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * C-ECHO 疎通の検証。外部 PACS 非依存：自前 SCP を立てて自前 SCU から echo する。
 */
class DicomEchoTest {

    @Test
    void echo_against_local_scp_succeeds() {
        int port = freePort();
        DicomScpServer scp = new DicomScpServer("GRAPHYTEST", "127.0.0.1", port);
        scp.start();
        try {
            EchoResult r = new DicomEchoScu().echo("127.0.0.1", port, "GRAPHYTEST", "GRAPHYSCU");
            assertTrue(r.success(), () -> "echo should succeed but: " + r.message());
            assertEquals(0, r.status());
        } finally {
            scp.stop();
        }
    }

    @Test
    void echo_to_closed_port_fails_gracefully() {
        int port = freePort(); // 誰も listen していないポート
        EchoResult r = new DicomEchoScu().echo("127.0.0.1", port, "NOBODY", "GRAPHYSCU");
        assertFalse(r.success());
    }

    /** 空きポートを 1 つ確保して返す（取得直後に close するので軽微な競合はあり得る）。 */
    private static int freePort() {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        } catch (Exception e) {
            throw new IllegalStateException("free port を確保できませんでした", e);
        }
    }
}

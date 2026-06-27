package com.vis.graphynext.dicom;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.ServerSocket;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DIMSE TLS（相互TLS）の検証。keytool で自己署名の key-store/trust-store を生成し、
 * TLS リスナーを立てて自前 SCU から TLS 越しに C-ECHO する。外部依存なし。
 */
class DicomTlsTest {

    @TempDir
    Path tmp;

    @Test
    void mutualTls_cEcho_succeeds_andPlaintextToTlsPortFails() throws Exception {
        String pw = "changeit";
        Path key = tmp.resolve("key.p12");
        Path cert = tmp.resolve("graphy.crt");
        Path trust = tmp.resolve("trust.p12");

        // 自局の鍵+証明書
        keytool("-genkeypair", "-alias", "graphy", "-keyalg", "RSA", "-keysize", "2048",
                "-validity", "365", "-dname", "CN=GRAPHYNEXT",
                "-keystore", key.toString(), "-storetype", "PKCS12", "-storepass", pw, "-keypass", pw);
        // 証明書を取り出して trust-store（自己信頼）へ
        keytool("-exportcert", "-alias", "graphy", "-keystore", key.toString(),
                "-storepass", pw, "-file", cert.toString());
        keytool("-importcert", "-noprompt", "-alias", "graphy", "-keystore", trust.toString(),
                "-storetype", "PKCS12", "-storepass", pw, "-file", cert.toString());

        DicomProperties.Tls tls = new DicomProperties.Tls();
        tls.setEnabled(true);
        tls.setPort(freePort());
        tls.setKeyStore(key.toString());
        tls.setKeyStorePassword(pw);
        tls.setTrustStore(trust.toString());
        tls.setTrustStorePassword(pw);
        tls.setNeedClientAuth(true);
        assertTrue(tls.isUsable(), "TLS 設定は usable のはず");

        DicomScpServer scp = new DicomScpServer("GRAPHYTLS", "127.0.0.1", freePort());
        scp.enableTls(tls);
        scp.start();
        try {
            // 相互TLS で C-ECHO
            EchoResult ok = new DicomEchoScu().echo("127.0.0.1", tls.getPort(), "GRAPHYTLS", "SCU", tls);
            assertTrue(ok.success(), () -> "相互TLS C-ECHO は成功すべき: " + ok.message());

            // 平文で TLS ポートに繋ぐと失敗する
            EchoResult plain = new DicomEchoScu().echo("127.0.0.1", tls.getPort(), "GRAPHYTLS", "SCU", null);
            assertFalse(plain.success(), "平文で TLS ポートに繋ぐと失敗するはず");
        } finally {
            scp.stop();
        }
    }

    private static void keytool(String... args) throws Exception {
        List<String> cmd = new ArrayList<>();
        cmd.add(Path.of(System.getProperty("java.home"), "bin", "keytool").toString());
        cmd.addAll(List.of(args));
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).inheritIO().start();
        if (!p.waitFor(30, TimeUnit.SECONDS) || p.exitValue() != 0) {
            throw new IllegalStateException("keytool 失敗: " + String.join(" ", cmd));
        }
    }

    private static int freePort() {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        } catch (Exception e) {
            throw new IllegalStateException("free port を確保できませんでした", e);
        }
    }
}

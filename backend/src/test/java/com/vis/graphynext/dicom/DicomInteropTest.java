/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.store.DicomStoreScp;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.UID;
import org.dcm4che3.net.TransferCapability;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 実機にインストールされた dcm4che ツール（storescu / dcmqrscp）との相互運用テスト。
 * ツールが見つからない環境では各テストをスキップする（CI 非依存）。
 *
 * <ul>
 *   <li>stock {@code storescu} → 自前 SCP → H2 索引（受信側の相互運用）</li>
 *   <li>自前 {@code DicomEchoScu} → stock {@code dcmqrscp}（発信側の相互運用）</li>
 * </ul>
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:interop;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class DicomInteropTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DicomStorageService storage;

    @Autowired
    DicomProperties dicomProps;

    static Path storescu;
    static Path dcmqrscp;

    @BeforeAll
    static void locateTools() {
        storescu = findTool("storescu");
        dcmqrscp = findTool("dcmqrscp");
    }

    @Test
    void stockStorescu_to_ourScp_storesAndIndexes() throws Exception {
        assumeTrue(storescu != null, "dcm4che storescu が見つからないためスキップ");

        int port = freePort();
        DicomScpServer scp = new DicomScpServer("GRAPHYSTORE", "127.0.0.1", port);
        // 本番と同じ「明示列挙の Storage SOP Class」設定で受理する
        List<TransferCapability> caps =
                StorageSopClasses.scpCapabilities(dicomProps.getStorageSopClassesResource());
        scp.addService(new DicomStoreScp(storage, tmp.resolve("interop-incoming")),
                caps.toArray(TransferCapability[]::new));
        scp.start();
        try {
            Attributes ds = DicomPhantomFactory.scImage(
                    "PIDI", "1.2.interop.study", "1.2.interop.series", "1.2.interop.sop");
            Path file = DicomPhantomFactory.writeFile(
                    Files.createTempFile("interop", ".dcm"), ds, UID.ExplicitVRLittleEndian);

            int exit = run(buildCmd(storescu,
                    "-c", "GRAPHYSTORE@127.0.0.1:" + port,
                    file.toString()));

            assertEquals(0, exit, "stock storescu の C-STORE は成功すべき");
            assertEquals(1, storage.findMatches(null, "1.2.interop.study", null, null).size(),
                    "受信したインスタンスが索引に載る");
        } finally {
            scp.stop();
        }
    }

    @Test
    void ourEchoScu_to_stockDcmqrscp_succeeds() throws Exception {
        assumeTrue(dcmqrscp != null, "dcm4che dcmqrscp が見つからないためスキップ");

        int port = freePort();
        Path dicomdir = tmp.resolve("peer").resolve("DICOMDIR");
        Files.createDirectories(dicomdir.getParent());

        Process peer = new ProcessBuilder(buildCmd(dcmqrscp,
                "-b", "DCMQRSCP:" + port,
                "--dicomdir", dicomdir.toString()))
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .start();
        try {
            assertTrue(waitForPort(port, 10_000), "dcmqrscp が listen を開始しない");
            EchoResult r = new DicomEchoScu().echo("127.0.0.1", port, "DCMQRSCP", "GRAPHYNEXT");
            assertTrue(r.success(), () -> "stock dcmqrscp への C-ECHO は成功すべき: " + r.message());
        } finally {
            killProcess(peer);
        }
    }

    // --- helpers ---

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }

    /**
     * dcm4che CLI ツールを検索する。
     * Windows では .bat 拡張子付きファイルを優先し、DCM4CHE_HOME の他に
     * Program Files 配下の dcm4che-* ディレクトリも探す。
     */
    private static Path findTool(String name) {
        List<Path> dirs = new ArrayList<>();

        // DCM4CHE_HOME 環境変数
        String home = System.getenv("DCM4CHE_HOME");
        if (home != null && !home.isBlank()) {
            dirs.add(Path.of(home, "bin"));
        }

        // $HOME/dcm4che-*/bin
        Path userHome = Path.of(System.getProperty("user.home"));
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(userHome, "dcm4che-*")) {
            for (Path d : stream) dirs.add(d.resolve("bin"));
        } catch (IOException ignore) {}

        // Windows: Program Files 配下の dcm4che-*/bin
        if (isWindows()) {
            for (String pf : new String[]{"ProgramFiles", "ProgramFiles(x86)"}) {
                String pfDir = System.getenv(pf);
                if (pfDir != null) {
                    try (DirectoryStream<Path> stream =
                                 Files.newDirectoryStream(Path.of(pfDir), "dcm4che-*")) {
                        for (Path d : stream) dirs.add(d.resolve("bin"));
                    } catch (IOException ignore) {}
                }
            }
        }

        for (Path dir : dirs) {
            // Windows は .bat を優先（Unix shell script より先に検索）
            if (isWindows()) {
                Path bat = dir.resolve(name + ".bat");
                if (Files.exists(bat)) return bat;
            }
            Path plain = dir.resolve(name);
            if (Files.isExecutable(plain)) return plain;
        }
        return null;
    }

    /**
     * ツールパスとオプションからコマンドリストを構築する。
     * Windows の .bat ファイルは ProcessBuilder では直接実行できないため cmd /c 経由にする。
     */
    private static List<String> buildCmd(Path tool, String... args) {
        List<String> cmd = new ArrayList<>();
        if (isWindows() && tool.toString().toLowerCase(Locale.ROOT).endsWith(".bat")) {
            cmd.add("cmd");
            cmd.add("/c");
        }
        cmd.add(tool.toString());
        cmd.addAll(List.of(args));
        return cmd;
    }

    private static int run(List<String> cmd) throws Exception {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).inheritIO().start();
        if (!p.waitFor(30, TimeUnit.SECONDS)) {
            killProcess(p);
            throw new IllegalStateException("プロセスがタイムアウト: " + String.join(" ", cmd));
        }
        return p.exitValue();
    }

    /**
     * プロセスを終了する。Windows では cmd /c 経由で孫プロセスが残るため
     * taskkill /F /T でプロセスツリーごと強制終了し、ファイルロック解放を待つ。
     */
    private static void killProcess(Process p) throws InterruptedException {
        if (isWindows()) {
            try {
                new ProcessBuilder("taskkill", "/F", "/T", "/PID", String.valueOf(p.pid()))
                        .redirectErrorStream(true)
                        .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                        .start()
                        .waitFor(5, TimeUnit.SECONDS);
            } catch (IOException ignore) {
                p.destroyForcibly();
            }
        } else {
            p.destroy();
            p.waitFor(10, TimeUnit.SECONDS);
            if (p.isAlive()) p.destroyForcibly();
        }
        // ファイルロックの解放を待つ
        Thread.sleep(300);
    }

    private static boolean waitForPort(int port, long timeoutMs) {
        long end = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < end) {
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress("127.0.0.1", port), 300);
                return true;
            } catch (IOException e) {
                try {
                    Thread.sleep(200);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }
        }
        return false;
    }

    private static int freePort() {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        } catch (Exception e) {
            throw new IllegalStateException("free port を確保できませんでした", e);
        }
    }
}

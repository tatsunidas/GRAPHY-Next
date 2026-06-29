/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.qr.Dcm4cheTools;
import com.vis.graphynext.dicom.qr.DimseQrService;
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
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * standalone の C-GET / C-MOVE を、実機 dcm4che ツールと stock dcmqrscp（ピア PACS）で検証する。
 *
 * <p>フロー: dcmqrscp を起動 → storescu でファントムを投入 →
 * 自前 {@link DimseQrService}（getscu/movescu を起動）で取得 → ローカル索引(H2)に載ることを確認。
 * ツールが無い環境ではスキップ。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:qrinterop;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false",
                "graphy.dicom.local-ae-title=GRAPHYNEXT"
        })
class DicomQrInteropTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DimseQrService qr;
    @Autowired
    DicomStorageService storage;
    @Autowired
    DicomProperties dicomProps;
    @Autowired
    Dcm4cheTools tools;

    static boolean toolsPresent;

    @BeforeAll
    static void check(@Autowired Dcm4cheTools t) {
        toolsPresent = t.isAvailable("dcmqrscp") && t.isAvailable("storescu")
                && t.isAvailable("getscu") && t.isAvailable("movescu");
    }

    @Test
    void cFind_fromStockDcmqrscp_returnsStudies() throws Exception {
        assumeTrue(toolsPresent, "dcm4che ツール未検出のためスキップ");

        String study = "1.2.qr.find.study";
        try (Peer peer = Peer.startWithPhantom("PIDF", study, "1.2.qr.find.series", "1.2.qr.find.sop", null)) {
            var studies = qr.findStudies("127.0.0.1", peer.port, "DCMQRSCP", Map.of());
            assertTrue(studies.stream().anyMatch(s -> study.equals(s.studyInstanceUid())),
                    "C-FIND で投入した study が返るはず");
            // 絞り込み（PatientID）でも返る
            var byPid = qr.findStudies("127.0.0.1", peer.port, "DCMQRSCP", Map.of("PatientID", "PIDF"));
            assertTrue(byPid.stream().anyMatch(s -> study.equals(s.studyInstanceUid())),
                    "PatientID 絞り込みでも study が返るはず");
        }
    }

    @Test
    void cGet_fromStockDcmqrscp_ingestsLocally() throws Exception {
        assumeTrue(toolsPresent, "dcm4che ツール未検出のためスキップ");

        String study = "1.2.qr.get.study";
        try (Peer peer = Peer.startWithPhantom("PIDG", study, "1.2.qr.get.series", "1.2.qr.get.sop", null)) {
            int n = qr.getStudy("127.0.0.1", peer.port, "DCMQRSCP", study);
            assertTrue(n >= 1, "C-GET で 1 件以上取得できるはず");
            assertTrue(storage.findMatches(null, study, null, null).size() >= 1, "取得分が索引に載る");
        }
    }

    @Test
    void cMove_fromStockDcmqrscp_toOurScp_ingests() throws Exception {
        assumeTrue(toolsPresent, "dcm4che ツール未検出のためスキップ");

        int ourScpPort = freePort();
        // 自前 SCP（移動先）を AE=GRAPHYNEXT で起動
        DicomScpServer ourScp = new DicomScpServer("GRAPHYNEXT", "127.0.0.1", ourScpPort);
        List<TransferCapability> caps =
                StorageSopClasses.scpCapabilities(dicomProps.getStorageSopClassesResource());
        ourScp.addService(new DicomStoreScp(storage, tmp.resolve("move-incoming")),
                caps.toArray(TransferCapability[]::new));
        ourScp.start();

        String study = "1.2.qr.move.study";
        // ピアに、移動先 AE GRAPHYNEXT -> 自前 SCP の対応を渡す（ae-config）
        Path aeConfig = tmp.resolve("peer-ae.properties");
        Files.writeString(aeConfig, "GRAPHYNEXT=127.0.0.1:" + ourScpPort + "\n");
        try (Peer peer = Peer.startWithPhantom("PIDM", study, "1.2.qr.move.series", "1.2.qr.move.sop", aeConfig)) {
            qr.moveStudy("127.0.0.1", peer.port, "DCMQRSCP", study, "GRAPHYNEXT");
            // 受信は非同期。索引に載るまで待つ。
            assertTrue(waitUntil(() -> storage.findMatches(null, study, null, null).size() >= 1, 15_000),
                    "C-MOVE で自前 SCP が受信し索引に載るはず");
        } finally {
            ourScp.stop();
        }
    }

    // --- ピア dcmqrscp（ファントム投入済み）---
    private static final class Peer implements AutoCloseable {
        final Process process;
        final int port;

        private Peer(Process process, int port) {
            this.process = process;
            this.port = port;
        }

        static Peer startWithPhantom(String pid, String study, String series, String sop, Path aeConfig)
                throws Exception {
            int port = freePort();
            Path peerDir = Files.createTempDirectory("graphy-peer-");
            Path dicomdir = peerDir.resolve("DICOMDIR");

            java.util.List<String> cmd = new java.util.ArrayList<>(List.of(
                    requireTool("dcmqrscp").toString(),
                    "-b", "DCMQRSCP:" + port,
                    "--dicomdir", dicomdir.toString(),
                    "--filepath", "{00100020}/{0020000D}/{0020000E}/{00080018}"));
            if (aeConfig != null) {
                cmd.add("--ae-config");
                cmd.add(aeConfig.toString());
            }
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true)
                    .redirectOutput(peerDir.resolve("dcmqrscp.log").toFile()).start();
            if (!waitForPort(port, 10_000)) {
                p.destroyForcibly();
                throw new IllegalStateException("dcmqrscp が起動しない");
            }
            // ファントムを storescu で投入
            Attributes ds = DicomPhantomFactory.scImage(pid, study, series, sop);
            Path file = DicomPhantomFactory.writeFile(
                    Files.createTempFile("phantom", ".dcm"), ds, UID.ExplicitVRLittleEndian);
            Process store = new ProcessBuilder(
                    requireTool("storescu").toString(),
                    "-c", "DCMQRSCP@127.0.0.1:" + port,
                    file.toString()).redirectErrorStream(true).inheritIO().start();
            if (!store.waitFor(30, TimeUnit.SECONDS) || store.exitValue() != 0) {
                p.destroyForcibly();
                throw new IllegalStateException("storescu によるファントム投入に失敗");
            }
            return new Peer(p, port);
        }

        @Override
        public void close() {
            process.destroy();
            try {
                if (!process.waitFor(10, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private static Path requireTool(String name) {
        Path home = Path.of(System.getProperty("user.home"));
        try (var s = Files.newDirectoryStream(home, "dcm4che-*")) {
            for (Path d : s) {
                Path t = d.resolve("bin").resolve(name);
                if (Files.isExecutable(t)) {
                    return t;
                }
            }
        } catch (IOException ignore) {
            // none
        }
        throw new IllegalStateException("tool not found: " + name);
    }

    private static boolean waitUntil(BooleanSupplier cond, long timeoutMs) {
        long end = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < end) {
            if (cond.getAsBoolean()) {
                return true;
            }
            try {
                Thread.sleep(300);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return cond.getAsBoolean();
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

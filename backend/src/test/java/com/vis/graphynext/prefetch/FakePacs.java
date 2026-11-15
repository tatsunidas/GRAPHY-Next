/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** 試験用の PACS（実機 dcm4che の dcmqrscp）。検査を 1 枚ずつ storescu で入れる。ツールが無ければ {@link #available()} が false。 */
final class FakePacs implements AutoCloseable {

    final int port;
    private final Process process;

    private FakePacs(Process process, int port) {
        this.process = process;
        this.port = port;
    }

    static Path tool(String name) {
        Path home = Path.of(System.getProperty("user.home"));
        try (var s = Files.newDirectoryStream(home, "dcm4che-*")) {
            for (Path d : s) {
                boolean win = System.getProperty("os.name", "").toLowerCase().contains("win");
                Path t = d.resolve("bin").resolve(win ? name + ".bat" : name);
                if (Files.isExecutable(t)) {
                    return t;
                }
            }
        } catch (IOException ignore) {
            // none
        }
        return null;
    }

    static boolean available() {
        return tool("dcmqrscp") != null && tool("storescu") != null;
    }

    /** 試験用の 1 検査（画像 1 枚）。 */
    record Study(String patientId, String studyUid, String modality, String date) {
    }

    /** @param ownScpPort 移動先 AE GRAPHYNEXT の受信口 */
    static FakePacs start(List<Study> studies, int ownScpPort) throws Exception {
        int port = freePort();
        Path dir = Files.createTempDirectory("graphy-fakepacs-");
        Path ae = dir.resolve("ae.properties");
        Files.writeString(ae, "GRAPHYNEXT=127.0.0.1:" + ownScpPort + "\n");
        List<String> cmd = new ArrayList<>(List.of(
                tool("dcmqrscp").toString(),
                "-b", "DCMQRSCP:" + port,
                "--dicomdir", dir.resolve("DICOMDIR").toString(),
                "--filepath", "{00100020}/{0020000D}/{0020000E}/{00080018}",
                "--ae-config", ae.toString()));
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true)
                .redirectOutput(dir.resolve("dcmqrscp.log").toFile()).start();
        if (!waitForPort(port, 15_000)) {
            p.destroyForcibly();
            throw new IllegalStateException("dcmqrscp が起動しない");
        }
        int n = 0;
        for (Study s : studies) {
            n++;
            Attributes ds = DicomPhantomFactory.scImage(s.patientId, s.studyUid, s.studyUid + ".1", s.studyUid + ".1." + n);
            ds.setString(Tag.Modality, VR.CS, s.modality);
            ds.setString(Tag.StudyDate, VR.DA, s.date);
            Path f = DicomPhantomFactory.writeFile(Files.createTempFile(dir, "ph", ".dcm"), ds, UID.ExplicitVRLittleEndian);
            Process store = new ProcessBuilder(tool("storescu").toString(), "-c", "DCMQRSCP@127.0.0.1:" + port, f.toString())
                    .redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
            if (!store.waitFor(30, TimeUnit.SECONDS) || store.exitValue() != 0) {
                p.destroyForcibly();
                throw new IllegalStateException("storescu による投入に失敗");
            }
        }
        return new FakePacs(p, port);
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

    static int freePort() {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    static boolean waitForPort(int port, long timeoutMs) {
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
}

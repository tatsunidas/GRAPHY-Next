/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Assumptions;

import java.io.IOException;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * テスト用に本物の jupyter_server を起動する（結合テストで共有）。
 *
 * <p>環境変数 {@code GRAPHY_JUPYTER_PYTHON} に jupyter_server と ipykernel の入った python を
 * 指定したときだけ動く（無ければ呼び出し元のテストを skip させる）。
 * ⚠ Windows の {@code python3} は Microsoft Store のスタブなので名前で探さない。
 */
final class LocalJupyter implements AutoCloseable {

    final Path root;
    final String url;
    final String token;
    final JupyterServerClient client;
    private final Process proc;

    private LocalJupyter(Path root, String url, String token, Process proc) {
        this.root = root;
        this.url = url;
        this.token = token;
        this.proc = proc;
        this.client = new JupyterServerClient(JupyterEndpoint.of(url, token), new ObjectMapper());
    }

    /** 起動して応答するまで待つ。python が無ければテストを skip させる。 */
    static LocalJupyter start() throws IOException, InterruptedException {
        String python = System.getenv("GRAPHY_JUPYTER_PYTHON");
        Assumptions.assumeTrue(python != null && !python.isBlank() && Files.isRegularFile(Path.of(python)),
                "GRAPHY_JUPYTER_PYTHON not set; skipping Jupyter integration test");
        Path root = Files.createTempDirectory("graphy-jupyter-it");
        int port;
        try (ServerSocket s = new ServerSocket(0)) {
            port = s.getLocalPort();
        }
        String token = UUID.randomUUID().toString();
        Process proc = new ProcessBuilder(python, "-m", "jupyter_server",
                "--ServerApp.ip=127.0.0.1", "--ServerApp.port=" + port, "--ServerApp.port_retries=0",
                "--ServerApp.open_browser=False", "--IdentityProvider.token=" + token,
                "--ServerApp.root_dir=" + root)
                .redirectErrorStream(true)
                .redirectOutput(root.resolve("server.log").toFile())
                .start();
        LocalJupyter j = new LocalJupyter(root, "http://127.0.0.1:" + port, token, proc);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (true) {
            try {
                j.client.status();
                return j;
            } catch (JupyterException e) {
                if (!proc.isAlive() || System.nanoTime() > deadline) {
                    j.close();
                    throw new IllegalStateException("jupyter_server did not start:\n"
                            + Files.readString(root.resolve("server.log")), e);
                }
                Thread.sleep(300);
            }
        }
    }

    @Override
    public void close() {
        proc.descendants().forEach(ProcessHandle::destroyForcibly);
        proc.destroyForcibly();
    }
}

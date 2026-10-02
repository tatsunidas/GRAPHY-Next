/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.List;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 本物の jupyter_server を起動して、REST と WebSocket を通しで確かめる。
 *
 * <p>環境変数 {@code GRAPHY_JUPYTER_PYTHON} に jupyter_server と ipykernel の入った python を
 * 指定したときだけ動く（無ければ skip）。例（開発機）:
 * {@code GRAPHY_JUPYTER_PYTHON=C:\Users\...\anaconda3\python.exe}。
 * ⚠ Windows の {@code python3} は Microsoft Store のスタブなので名前で探さない。
 */
class JupyterServerIntegrationTest {

    private static Process proc;
    private static Path root;
    private static JupyterServerClient client;
    private static String kernelId;
    private static KernelChannel ch;

    @BeforeAll
    static void startServer() throws Exception {
        String python = System.getenv("GRAPHY_JUPYTER_PYTHON");
        Assumptions.assumeTrue(python != null && !python.isBlank() && Files.isRegularFile(Path.of(python)),
                "GRAPHY_JUPYTER_PYTHON not set; skipping Jupyter integration test");
        root = Files.createTempDirectory("graphy-jupyter-it");
        int port;
        try (ServerSocket s = new ServerSocket(0)) {
            port = s.getLocalPort();
        }
        String token = UUID.randomUUID().toString();
        proc = new ProcessBuilder(python, "-m", "jupyter_server",
                "--ServerApp.ip=127.0.0.1", "--ServerApp.port=" + port, "--ServerApp.port_retries=0",
                "--ServerApp.open_browser=False", "--IdentityProvider.token=" + token,
                "--ServerApp.root_dir=" + root)
                .redirectErrorStream(true)
                .redirectOutput(root.resolve("server.log").toFile())
                .start();
        client = new JupyterServerClient(JupyterEndpoint.of("http://127.0.0.1:" + port, token), new ObjectMapper());
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (true) {
            try {
                client.status();
                break;
            } catch (JupyterException e) {
                if (!proc.isAlive() || System.nanoTime() > deadline) {
                    throw new IllegalStateException("jupyter_server did not start:\n"
                            + Files.readString(root.resolve("server.log")), e);
                }
                Thread.sleep(300);
            }
        }
        kernelId = client.startKernel("python3");
        ch = client.connect(kernelId, Duration.ofSeconds(60));
    }

    @AfterAll
    static void stopServer() {
        if (ch != null) {
            ch.close();
        }
        if (client != null && kernelId != null) {
            try {
                client.shutdownKernel(kernelId);
            } catch (RuntimeException ignored) {
                // サーバごと止めるので構わない
            }
        }
        if (proc != null) {
            proc.descendants().forEach(ProcessHandle::destroyForcibly);
            proc.destroyForcibly();
        }
    }

    private static ExecutionResult run(String code) throws Exception {
        return ch.execute(code, null).get(120, TimeUnit.SECONDS);
    }

    @Test
    void executesCodeAndCollectsStdoutAndValue() throws Exception {
        List<String> streamed = Collections.synchronizedList(new ArrayList<>());
        ExecutionResult r = ch.execute("import sys\nprint('hello')\nprint('oops', file=sys.stderr)\n6*7",
                (name, text) -> streamed.add(name)).get(60, TimeUnit.SECONDS);
        assertTrue(r.ok(), r.toString());
        assertEquals("hello\n", r.stdout());
        assertEquals("oops\n", r.stderr());
        assertEquals("42", r.textPlain());
        assertTrue(streamed.contains("stdout"));
    }

    @Test
    void reportsPythonErrors() throws Exception {
        ExecutionResult r = run("raise ValueError('bad input')");
        assertFalse(r.ok());
        assertEquals("ValueError", r.errorName());
        assertEquals("bad input", r.errorValue());
        assertFalse(r.traceback().isEmpty());
        assertFalse(String.join("\n", r.traceback()).contains("\u001B["), "ANSI は除く");
    }

    @Test
    void inputIsNotAllowed() throws Exception {
        // 返事をする人がいないので input() は待たずに失敗する
        ExecutionResult r = run("input('x')");
        assertFalse(r.ok());
    }

    @Test
    void uploadThenKernelReadsThenDownloadResult() throws Exception {
        byte[] data = new byte[3 * JupyterServerClient.UPLOAD_CHUNK_BYTES / 2 + 123]; // 分割して送られる大きさ
        new Random(1).nextBytes(data);
        String sha = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
        client.upload("job1/inputs/blob.bin", data);
        ExecutionResult r = run("""
                import hashlib, os
                b = open('job1/inputs/blob.bin','rb').read()
                os.makedirs('job1/outputs', exist_ok=True)
                open('job1/outputs/result.txt','w').write(hashlib.sha256(b).hexdigest())
                print(len(b))
                """);
        assertTrue(r.ok(), r.toString());
        assertEquals(data.length + "\n", r.stdout());
        assertArrayEquals(sha.getBytes(), client.download("job1/outputs/result.txt"));
        assertEquals(1, client.list("job1/outputs").size());
        client.delete("job1");
        assertTrue(client.list("job1").isEmpty());
    }

    @Test
    void interruptStopsLongRunningCode() throws Exception {
        // ⚠ Windows のカーネルは中断を interrupt_main() で伝えるので、time.sleep(120) のような
        // 1 回の長い待ちは終わるまで抜けない（待ちが明けてから KeyboardInterrupt になる）。
        // Linux（Colab・GPU 機）は SIGINT で即座に抜ける。どちらでも通るよう短い待ちを繰り返す。
        CompletableFuture<ExecutionResult> f = ch.execute(
                "import time\nfor _ in range(1200):\n    time.sleep(0.1)", null);
        Thread.sleep(1500);
        client.interruptKernel(kernelId);
        ExecutionResult r = f.get(30, TimeUnit.SECONDS);
        assertFalse(r.ok());
        assertEquals("KeyboardInterrupt", r.errorName());
        // 中断のあとも同じカーネルで続けられる
        assertEquals("2", run("1+1").textPlain());
    }

    @Test
    void connectionTesterRunsTheFixedProbe() {
        ComputeEndpointRegistry reg = new ComputeEndpointRegistry();
        JupyterEndpoint ep = client.endpoint();
        assertTrue(reg.replaceAll(List.of(new ComputeEndpointRegistry.Incoming(
                "local", "Local", ep.base().toString(), ep.token()))).isEmpty());
        ComputeConnectionTester tester = new ComputeConnectionTester(reg, new ObjectMapper());
        ComputeConnectionTester.Result r = tester.test("local", Duration.ofSeconds(90));
        assertTrue(r.ok(), r.toString());
        assertEquals("done", r.stage());
        assertNotNull(r.serverVersion());
        assertTrue(r.kernels().contains("python3"));
        assertFalse(r.probe().path("python").asText().isEmpty());
        assertTrue(r.probe().path("gpus").isArray());

        // トークン違いは「接続」の段で 403 として返る（利用者が直せる形）
        reg.replaceAll(List.of(new ComputeEndpointRegistry.Incoming("local", "Local", ep.base().toString(), "wrong")));
        ComputeConnectionTester.Result bad = tester.test("local", Duration.ofSeconds(30));
        assertFalse(bad.ok());
        assertEquals("connect", bad.stage());
        assertTrue(bad.httpStatus() == 403 || bad.httpStatus() == 401, bad.toString());
        assertFalse(bad.error().contains("wrong"), "トークンを返さない");
    }

    @Test
    void kernelSpecsAndStateAreReadable() throws IOException {
        assertNotNull(client.kernelSpecs().path("kernelspecs").get("python3"));
        assertNotNull(client.kernel(kernelId));
        assertEquals(null, client.kernel("00000000-0000-0000-0000-000000000000"));
    }
}

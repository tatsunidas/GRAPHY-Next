/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * 接続テスト。設定画面の「接続を確かめる」から main 経由で呼ばれる。
 *
 * <p>🔑 <b>実行するコードはここの定数 {@link #PROBE} だけ</b>（AI の接続テストが 1×1 の白画像と
 * 固定の指示しか送らないのと同じ）。呼び出し側が渡せるのは接続先の id だけで、
 * 患者のデータもプラグインのコードもここからは出ない。
 *
 * <p>確かめる段: ① サーバに届くか・トークンが通るか（{@code /api/status}）② カーネルの種類
 * ③ カーネルを起動して {@link #PROBE} を実行（Python・GPU・PyTorch）④ カーネルを止める。
 * どの段で落ちたかを {@link Result#stage()} で返す——「繋がらない」だけでは利用者が直せない。
 */
@Component
public class ComputeConnectionTester {

    /**
     * カーネルで実行する唯一のコード。最後の 1 行に JSON を出す。
     * nvidia-smi と torch は無くてよい（無いことも結果のうち）。
     */
    static final String PROBE = """
            import json, platform, subprocess, sys
            info = {"python": sys.version.split()[0], "platform": platform.platform(), "gpus": [], "torch": None}
            try:
                out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,driver_version",
                                      "--format=csv,noheader"], capture_output=True, text=True, timeout=15)
                if out.returncode == 0:
                    for line in out.stdout.strip().splitlines():
                        p = [s.strip() for s in line.split(",")]
                        info["gpus"].append({"name": p[0], "memory": p[1] if len(p) > 1 else None,
                                             "driver": p[2] if len(p) > 2 else None})
            except Exception:
                pass
            try:
                import torch
                info["torch"] = {"version": torch.__version__, "cuda": torch.cuda.is_available(),
                                 "devices": [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]}
            except Exception:
                pass
            print("__graphy_probe__" + json.dumps(info))
            """;
    static final String MARK = "__graphy_probe__";

    /**
     * @param ok        すべての段を通ったか
     * @param stage     落ちた段（{@code connect} / {@code kernelspecs} / {@code kernel} / {@code probe}）。成功なら {@code done}
     * @param error     落ちた理由（人が読む文。トークンは含まない）
     * @param httpStatus 落ちた要求の HTTP 状態（無ければ 0）。401/403 ならトークンの誤り
     * @param serverVersion Jupyter Server の版（分かれば）
     * @param kernels   使えるカーネルの名前
     * @param probe     {@link #PROBE} の結果（Python・GPU・PyTorch）。届かなければ null
     * @param elapsedMs かかった時間
     */
    public record Result(boolean ok, String stage, String error, int httpStatus, String serverVersion,
                         List<String> kernels, JsonNode probe, long elapsedMs) {
    }

    private final ComputeEndpointRegistry registry;
    private final ObjectMapper mapper;

    public ComputeConnectionTester(ComputeEndpointRegistry registry, ObjectMapper mapper) {
        this.registry = registry;
        this.mapper = mapper;
    }

    public Result test(String endpointId, Duration timeout) {
        long t0 = System.nanoTime();
        JupyterServerClient c = registry.client(endpointId, mapper).orElse(null);
        if (c == null) {
            return fail("connect", "unknown-endpoint", 0, null, List.of(), t0);
        }
        String version;
        try {
            c.status();
            version = c.version();
        } catch (JupyterException e) {
            return fail("connect", e.getMessage(), e.status(), null, List.of(), t0);
        }
        List<String> kernels = new ArrayList<>();
        String kernelName;
        try {
            JsonNode specs = c.kernelSpecs();
            for (Iterator<String> it = specs.path("kernelspecs").fieldNames(); it.hasNext(); ) {
                kernels.add(it.next());
            }
            kernelName = kernels.contains("python3") ? "python3" : specs.path("default").asText(null);
        } catch (JupyterException e) {
            return fail("kernelspecs", e.getMessage(), e.status(), version, kernels, t0);
        }
        if (kernelName == null) {
            return fail("kernelspecs", "no-python-kernel", 0, version, kernels, t0);
        }
        String kernelId = null;
        try {
            kernelId = c.startKernel(kernelName);
            try (KernelChannel ch = c.connect(kernelId, timeout)) {
                ExecutionResult r = ch.execute(PROBE, null).get(timeout.toMillis(), TimeUnit.MILLISECONDS);
                if (!r.ok()) {
                    return fail("probe", r.errorName() + ": " + r.errorValue(), 0, version, kernels, t0);
                }
                JsonNode probe = parseProbe(r.stdout());
                if (probe == null) {
                    return fail("probe", "no-probe-output", 0, version, kernels, t0);
                }
                return new Result(true, "done", null, 0, version, List.copyOf(kernels), probe, ms(t0));
            }
        } catch (JupyterException e) {
            return fail(kernelId == null ? "kernel" : "probe", e.getMessage(), e.status(), version, kernels, t0);
        } catch (TimeoutException e) {
            return fail("probe", "timeout", 0, version, kernels, t0);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return fail("probe", "interrupted", 0, version, kernels, t0);
        } catch (Exception e) {
            return fail("probe", String.valueOf(e.getCause() != null ? e.getCause() : e), 0, version, kernels, t0);
        } finally {
            if (kernelId != null) {
                try {
                    c.shutdownKernel(kernelId);
                } catch (JupyterException ignored) {
                    // 止められなくても、サーバ側の idle 回収に任せる
                }
            }
        }
    }

    JsonNode parseProbe(String stdout) {
        for (String line : stdout.split("\n")) {
            int i = line.indexOf(MARK);
            if (i >= 0) {
                try {
                    return mapper.readTree(line.substring(i + MARK.length()));
                } catch (Exception e) {
                    return null;
                }
            }
        }
        return null;
    }

    private static Result fail(String stage, String error, int status, String version, List<String> kernels,
                               long t0) {
        return new Result(false, stage, error, status, version, List.copyOf(kernels), null, ms(t0));
    }

    private static long ms(long t0) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0);
    }
}

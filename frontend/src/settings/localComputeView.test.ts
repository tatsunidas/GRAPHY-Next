import { describe, expect, it } from "vitest";
import type { LocalCandidate, LocalDetectResult } from "../desktopBridge";
import { buildLocalView, formatVram } from "./localComputeView";

const emptyGuidance = { missing: [], commands: [], links: [] };
const base = (over: Partial<LocalDetectResult>): LocalDetectResult => ({
  state: "ok",
  python: { mode: "auto" },
  selected: null,
  usable: false,
  candidates: [],
  searched: [],
  nvidia: { found: false, path: null, gpus: [], error: null, unparsed: 0 },
  capabilities: null,
  reasons: [],
  guidance: emptyGuidance,
  elapsedMs: 1,
  ...over,
});
const cand = (over: Partial<LocalCandidate>): LocalCandidate => ({
  path: "/p/python",
  source: "path",
  status: "usable",
  reasons: [],
  versions: { python: "3.11.9", jupyterServer: "2.14.0", ipykernel: "6.29.5", torch: null, cuda: null },
  ...over,
});

describe("buildLocalView", () => {
  it("見つからない: 探した場所の一覧を持つ", () => {
    const v = buildLocalView(base({ state: "none", searched: ["/usr/bin/python3", "/opt/conda/bin/python"], reasons: ["no-python"] }));
    expect(v.headline.key).toBe("settings.compute.local.headline.noPython");
    expect(v.headline.tone).toBe("error");
    expect(v.searched).toEqual(["/usr/bin/python3", "/opt/conda/bin/python"]);
    expect(v.python).toBeNull();
  });

  it("足りない: 名前とコマンドを出し、Python の版は読める", () => {
    const sel = cand({ status: "missing", reasons: ["missing-jupyter-server"], versions: { python: "3.10.12", jupyterServer: null, ipykernel: null, torch: null, cuda: null } });
    const v = buildLocalView(
      base({
        selected: sel,
        candidates: [sel],
        reasons: ["missing-jupyter-server", "missing-ipykernel", "no-torch"],
        guidance: { missing: ["jupyter_server", "ipykernel", "torch"], commands: [{ shell: "sh", text: "'/p/python' -m pip install jupyter_server ipykernel" }], links: ["https://pytorch.org/get-started/locally/"] },
      }),
    );
    expect(v.headline.key).toBe("settings.compute.local.headline.packagesMissing");
    expect(v.missing).toContain("jupyter_server");
    expect(v.commands[0].text).toContain("pip install jupyter_server ipykernel");
    expect(v.python?.versions).toContain("jupyter_server -");
    expect(v.candidates[0].reasons.map((m) => m.key)).toContain("settings.compute.local.reason.missing-jupyter-server");
  });

  it("除外: 候補の行に除外の理由が出る", () => {
    const ex = cand({ path: "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe", status: "excluded", reasons: ["excluded-windowsapps"], versions: null });
    const v = buildLocalView(base({ state: "none", candidates: [ex], reasons: ["no-python"] }));
    expect(v.candidates[0].status.key).toBe("settings.compute.local.cand.excluded");
    expect(v.candidates[0].reasons[0].key).toBe("settings.compute.local.reason.excluded-windowsapps");
    expect(v.candidates[0].versions).toBeNull();
  });

  it("CPU 版: GPU の行は『CPU 版』で、CUDA 可にならない", () => {
    const sel = cand({ status: "selected", versions: { python: "3.11.9", jupyterServer: "2.14.0", ipykernel: "6.29.5", torch: "2.5.1+cpu", cuda: null } });
    const v = buildLocalView(
      base({
        selected: sel, candidates: [sel], usable: true,
        nvidia: { found: true, path: "/usr/bin/nvidia-smi", gpus: [{ name: "GPU X", memoryMiB: 4096, driver: "580.1", uuid: null }], error: null, unparsed: 0 },
        capabilities: { accelerator: "cpu", devices: [{ name: "GPU X", memoryMiB: 4096, memoryBytes: null, capability: null, archSupported: null, torchDevice: false }], torch: "2.5.1+cpu", cudaRuntime: null, driver: "580.1" },
        reasons: ["torch-cpu-build"],
      }),
    );
    expect(v.headline.key).toBe("settings.compute.local.headline.noGpu");
    expect(v.gpus[0].verdict.key).toBe("settings.compute.local.gpu.cpuBuild");
    expect(v.gpus[0].vram).toBe("4096 MiB（4.0 GB）");
    expect(v.notes.map((n) => n.key)).toContain("settings.compute.local.reason.torch-cpu-build");
  });

  it("CUDA 可: GPU 名と VRAM は nvidia-smi の値のまま", () => {
    const sel = cand({ status: "selected", versions: { python: "3.11.9", jupyterServer: "2.14.0", ipykernel: "6.29.5", torch: "2.5.1+cu124", cuda: "12.4" } });
    const v = buildLocalView(
      base({
        selected: sel, candidates: [sel], usable: true,
        capabilities: { accelerator: "cuda", devices: [{ name: "NVIDIA RTX A2000", memoryMiB: 12282, memoryBytes: 12878610432, capability: [8, 6], archSupported: true, torchDevice: true }], torch: "2.5.1+cu124", cudaRuntime: "12.4", driver: "560.94" },
        reasons: [],
      }),
    );
    expect(v.headline.key).toBe("settings.compute.local.headline.cuda");
    expect(v.gpus[0]).toMatchObject({ name: "NVIDIA RTX A2000", vram: "12282 MiB（12.0 GB）", tone: "ok" });
    expect(v.gpus[0].verdict.key).toBe("settings.compute.local.gpu.cudaOk");
  });

  it("世代が含まれない: CUDA 可にならず、計算能力を出す", () => {
    const sel = cand({ status: "selected", versions: { python: "3.11.9", jupyterServer: "2.14.0", ipykernel: "6.29.5", torch: "2.8.0+cu128", cuda: "12.8" } });
    const v = buildLocalView(
      base({
        selected: sel, candidates: [sel], usable: true,
        capabilities: { accelerator: "cpu", devices: [{ name: "Old GPU", memoryMiB: 4096, memoryBytes: null, capability: [6, 1], archSupported: false, torchDevice: true }], torch: "2.8.0+cu128", cudaRuntime: "12.8", driver: "580.1" },
        reasons: ["gpu-arch-unsupported"],
      }),
    );
    expect(v.headline.key).not.toBe("settings.compute.local.headline.cuda");
    expect(v.gpus[0].verdict).toEqual({ key: "settings.compute.local.gpu.archUnsupported", params: { cc: "6.1" } });
    expect(v.gpus[0].tone).toBe("error");
  });

  it("ドライバが古い: 理由に両方の版が入る", () => {
    const sel = cand({ status: "selected", versions: { python: "3.11.9", jupyterServer: "2.14.0", ipykernel: "6.29.5", torch: "2.5.1+cu124", cuda: "12.4" } });
    const v = buildLocalView(
      base({
        selected: sel, candidates: [sel], usable: true,
        capabilities: { accelerator: "cpu", devices: [{ name: "G", memoryMiB: 8192, memoryBytes: null, capability: null, archSupported: null, torchDevice: false }], torch: "2.5.1+cu124", cudaRuntime: "12.4", driver: "470.1" },
        reasons: ["driver-maybe-old"],
      }),
    );
    const n = v.notes.find((m) => m.key.endsWith("driver-maybe-old"));
    expect(n?.params).toEqual({ driver: "470.1", cuda: "12.4" });
  });

  it("formatVram: 数値は変えない・無ければ null", () => {
    expect(formatVram(4096)).toBe("4096 MiB（4.0 GB）");
    expect(formatVram(null)).toBeNull();
  });
});

/*
 * 「この PC」の NVIDIA GPU で計算が走ることの実機検証。設計: fw/remote-compute-design.md §22
 *
 * 実行:  cd automator && PATH=<CUDA 版 torch・jupyter_server・ipykernel の入った venv の bin>:$PATH \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=18890 GRAPHY_AUTOMATOR_SCP_PORT=18891 GRAPHY_AUTOMATOR_VITE_PORT=18893 \
 *          npx tsx src/spike/computeLocalGpuCheck.ts
 *   起動前に frontend/node_modules/.vite を消すこと。Linux 専用（/proc を読む）。前提: backend jar・fixture ct-basic・nvidia-smi。
 *
 * endpointId:"local" で、計算機側のコードが torch で CUDA を使う（SPIKE_OMIT_ENDPOINT=1 なら endpointId を省略＝既定の計算機が
 * 自機になる経路。このときは 4. も確かめる）。確かめること:
 *   1. カーネルの Python が選んだ venv のもので、CUDA が使え、GPU の名前が nvidia-smi と一致する
 *   2. GPU で作ったマスクが CPU（numpy）の結果と一致する（GPU が正しく計算した）
 *   4. （省略時）既定が local と解決され、監査の送り先が 127.0.0.1・endpointKind が local
 *   3. 🔴 実行中に nvidia-smi の計算プロセスにそのカーネルの PID が出る・実行前と終了後には出ない（本当に GPU を使った）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { consentWindow, createChecker, launchRunJobPlugin, runJobOutcome, RUNJOB_PLUGIN_ID } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-local-gpu-check");

const SCRIPT = [
  "import json, os, sys, time, numpy as np, torch",
  "z = np.load('inputs/0.npz'); v = z['volume']",
  "cpu = (v > 150).astype(np.uint8)",
  "t = torch.from_numpy(v.astype(np.float32)).cuda()",
  "gpu = (t > 150).to(torch.uint8)",
  "big = torch.randn(4096, 4096, device='cuda')",
  "for _ in range(40): big = big @ big / 64.0",
  "torch.cuda.synchronize()",
  "print('__progress__', 0.5, 'gpu-busy')",
  "time.sleep(6)",
  "json.dump({",
  "  'executable': sys.executable,",
  "  'cuda': torch.cuda.is_available(),",
  "  'device': torch.cuda.get_device_name(0),",
  "  'cc': list(torch.cuda.get_device_capability(0)),",
  "  'pid': os.getpid(),",
  "  'same': bool((gpu.cpu().numpy() == cpu).all()),",
  "  'voxels': int(gpu.sum().item()), 'voxelsCpu': int(cpu.sum()),",
  "  'peakBytes': int(torch.cuda.max_memory_allocated()),",
  "}, open('outputs/summary.json', 'w'))",
].join("\n");

const smi = (...q: string[]) => execFileSync("nvidia-smi", q, { encoding: "utf8" }).trim();
const gpuPids = (): number[] =>
  smi("--query-compute-apps=pid", "--format=csv,noheader").split("\n").map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", RUNJOB_PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(AUTOMATOR_ROOT, "plugins", RUNJOB_PLUGIN_ID, n), path.join(dst, n));

  const smiName = smi("--query-gpu=name", "--format=csv,noheader");
  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
    });
    const base = `http://localhost:${driver.ports.http}`;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
    const series = (await (await fetch(`${base}/api/studies/${studies[0].studyInstanceUid}/series`)).json()) as {
      seriesInstanceUid: string; modality: string;
    }[];
    const ct = series.find((s) => s.modality === "CT") ?? series[0];

    const before = gpuPids();
    console.log(`  実行前の GPU 計算プロセス: [${before.join(",")}]`);
    await launchRunJobPlugin(page, { studyUid: studies[0].studyInstanceUid, seriesUid: ct.seriesInstanceUid, ...(process.env.SPIKE_OMIT_ENDPOINT === "1" ? {} : { endpointId: "local" }), script: SCRIPT });
    const win = await consentWindow(driver, 180_000);
    await win.getByTestId("consent-ack").check();
    await win.getByTestId("consent-send").click();

    // 実行中（スクリプトは GPU を掴んで 6 秒眠る）に nvidia-smi を見る
    const seen = new Set<number>();
    const done = runJobOutcome(page, 240_000);
    let fin = false;
    done.then(() => { fin = true; });
    while (!fin) {
      for (const p of gpuPids()) seen.add(p);
      await new Promise((r) => setTimeout(r, 500));
    }
    const run = await done;
    fs.writeFileSync(path.join(OUT_DIR, "outcome.json"), JSON.stringify(run, null, 2));
    const o = run.outcome;
    check(o.ok === true && o.status === "ok", "実行が最後まで走る", { error: o.error, stderr: o.stderr, ev: o.errorValue });
    const s = o.summary ?? {};
    console.log("  summary:", JSON.stringify(s));
    check(String(s.executable).startsWith(process.env.SPIKE_GPU_VENV ?? "\0"), "カーネルの Python が指定した venv のもの", s.executable);
    check(s.cuda === true, "torch.cuda.is_available() が真");
    check(s.device === smiName, "GPU 名が nvidia-smi と一致", { torch: s.device, smi: smiName });
    check(s.same === true && s.voxels === s.voxelsCpu && s.voxels > 0, "🔴 GPU のマスクが CPU（numpy）の結果と一致する（0 ボクセルでない）", { gpu: s.voxels, cpu: s.voxelsCpu });
    check(typeof s.peakBytes === "number" && s.peakBytes > 4096 * 4096 * 4, "GPU のメモリを実際に使った", s.peakBytes);
    check(seen.has(s.pid), "🔴 実行中に nvidia-smi の計算プロセスにカーネルの PID が出る", { pid: s.pid, seen: [...seen] });
    if (process.env.SPIKE_OMIT_ENDPOINT === "1") {
      const cfg = await page.evaluate(() => (window as unknown as { graphyDesktop: { computeEndpointsGet(): Promise<{ defaultId: string | null }> } }).graphyDesktop.computeEndpointsGet());
      check(cfg.defaultId === "local", "既定は local と解決されている（endpointId を省略した）", cfg.defaultId);
      const audit = fs.readFileSync(path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const req = audit.filter((e: { event: string }) => e.event === "egress-requested").pop();
      check(req?.endpointKind === "local" && /^127\.0\.0\.1/.test(req?.host ?? ""), "監査: endpointKind=local・host=127.0.0.1", req);
    }
    await new Promise((r) => setTimeout(r, 1500));
    check(!gpuPids().includes(s.pid), "終了後はそのプロセスが GPU に居ない（負例）", gpuPids());
  } finally {
    await driver.stop();
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

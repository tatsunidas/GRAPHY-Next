/*
 * 同梱のローカル AI（llama.cpp の llama-server＋GGUF）で、回帰評価の 2 組を実測する。
 *
 * 実行:  cd automator && LLAMA_SERVER=<llama-server> MODEL_GGUF=<.gguf> MODEL_ID=<manifest の id> \
 *          npx tsx src/spike/assistantEvalLocalModel.ts
 *   任意: SUITES（既定 basic,plugin-pos。basic-b も可）、RUN_TAG（結果ファイル名の接尾辞）、LLAMA_EXTRA（llama-server への追加引数。例 "--lora a.gguf"）、EVAL_K（既定 5）、LOCAL_PORT（既定 19430）、CPU_THREADS（既定は製品と同じ defaultThreads）
 *
 * 製品と同じ起動引数（desktop/localLlm.js の serverArgs。--jinja・文脈長・--reasoning はマニフェストの値）で llama-server を
 * 専用ポートに立て、本物の Electron のアシスタント窓から［評価を実行］を押す。結果は .results/assistant-eval-local/<MODEL_ID>.json。
 * 合否は「測った値を記録する」だけで、閾値は置かない（閾値は測った後に利用者が決める）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const require = createRequire(import.meta.url);
const L = require("../../../desktop/localLlm.js") as {
  serverArgs: (o: Record<string, unknown>) => string[];
  defaultThreads: (n: number) => number;
  newMark: () => string;
};
const MANIFEST = JSON.parse(fs.readFileSync(path.join(AUTOMATOR_ROOT, "..", "desktop", "localAiManifest.json"), "utf8")) as {
  models: { id: string; toolMode?: string; reasoning?: string }[];
};

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`環境変数 ${k} が要ります`);
  return v;
};
const LLAMA = need("LLAMA_SERVER");
const GGUF = need("MODEL_GGUF");
const MODEL_ID = need("MODEL_ID");
const K = Number(process.env.EVAL_K ?? 5);
const LOCAL_PORT = Number(process.env.LOCAL_PORT ?? 19430);
const SUITES = (process.env.SUITES ?? "basic,plugin-pos").split(",").map((x) => x.trim()).filter(Boolean);
const TAG = process.env.RUN_TAG ?? "";
/** llama-server への追加引数（例: `--lora <adapter.gguf>`）。空白区切り。製品の引数に足すだけで、他は変えない。 */
const EXTRA = (process.env.LLAMA_EXTRA ?? "").split(/\s+/).filter(Boolean);
const PORTS = { http: 19490, scp: 19491, vite: 19493 };
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-eval-local");

const md = MANIFEST.models.find((m) => m.id === MODEL_ID);
if (!md) throw new Error(`マニフェストに ${MODEL_ID} が無い`);
const threads = Number(process.env.CPU_THREADS ?? L.defaultThreads(require("node:os").availableParallelism()));

/** 最近順位法（p = ⌈q·n⌉ 番目）。 */
const nearestRank = (xs: number[], q: number): number | null => (xs.length ? [...xs].sort((a, b) => a - b)[Math.max(1, Math.ceil(q * xs.length)) - 1] : null);

async function waitHealth(port: number, ms: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch { /* まだ */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("llama-server が起動しない");
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const args = [...L.serverArgs({ modelPath: GGUF, port: LOCAL_PORT, mark: L.newMark(), jinja: md!.toolMode === "native", reasoning: md!.reasoning ?? null, threads }), ...EXTRA];
  console.log("llama-server", args.join(" "));
  const server: ChildProcess = spawn(LLAMA, args, { stdio: ["ignore", "ignore", "ignore"], cwd: path.dirname(LLAMA), env: { ...process.env, LD_LIBRARY_PATH: path.dirname(LLAMA) } });
  const driver = new DesktopDriver(PORTS);
  const result: Record<string, unknown> = { model: MODEL_ID, threads, k: K, ctx: 8192, reasoning: md!.reasoning ?? null, llamaArgs: args.filter((a) => a !== GGUF), extra: EXTRA };
  try {
    const tLoad = Date.now();
    await waitHealth(LOCAL_PORT, 10 * 60_000);
    result.loadSeconds = Math.round((Date.now() - tLoad) / 100) / 10;
    await driver.start();
    const info = await driver.app.evaluate(({ app, dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return { dataDir: process.cwd(), userData: app.getPath("userData") };
    });
    for (const f of ["ai-providers.json", "secrets.enc.json"]) fs.rmSync(path.join(info.dataDir, f), { force: true });
    const evalFile = path.join(info.userData, "ai-eval.jsonl");
    const reqFile = path.join(info.userData, "ai-requests.jsonl");
    for (const f of [evalFile, `${evalFile}.1`, reqFile, `${reqFile}.1`]) fs.rmSync(f, { force: true });
    await driver.page.reload({ waitUntil: "domcontentloaded" });
    const page = driver.page;
    const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

    const local = { id: "local", label: "ローカル LLM", kind: "openai", endpoint: `http://127.0.0.1:${LOCAL_PORT}`, auth: "none", toolMode: md!.toolMode === "native" ? "native" : "none", models: { "text-to-text": MODEL_ID } };
    const set = await page.evaluate((cfg) => (window as unknown as { graphyDesktop: { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean; problems: string[] }> } }).graphyDesktop.aiProvidersSet(cfg), { providers: [local], defaults: { "text-to-text": "local" } });
    if (!set.ok) throw new Error(`提供元を保存できない: ${JSON.stringify(set)}`);

    const win = await driver.waitForNewPage(async () => {
      await page.getByTestId("mainscreen-menu-system").click();
      await page.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.setViewportSize({ width: 680, height: 900 });
    await win.getByTestId("assistant-requestlog-toggle").click();
    await win.getByTestId("assistant-eval").waitFor({ state: "visible", timeout: 10_000 });

    const suites: Record<string, unknown> = {};
    for (const suite of SUITES) {
      console.log(`\n[${suite}] k=${K}`);
      const before = lines(evalFile).length;
      const reqBefore = lines(reqFile).length;
      await win.getByTestId("assistant-eval-suite").selectOption(suite);
      await win.getByTestId("assistant-eval-k").fill(String(K));
      const t0 = Date.now();
      await win.getByTestId("assistant-eval-run").click();
      // 完了 = 保存行が 1 つ増え、進行表示が消える
      const deadline = Date.now() + 120 * 60_000;
      while (Date.now() < deadline) {
        if (lines(evalFile).length > before && !(await win.getByTestId("assistant-eval-progress").isVisible())) break;
        if (await win.getByTestId("assistant-eval-error").isVisible()) throw new Error(`評価が失敗: ${await win.getByTestId("assistant-eval-error").textContent()}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      const wall = Math.round((Date.now() - t0) / 1000);
      const row = lines(evalFile).at(-1);
      if (!row || lines(evalFile).length <= before) throw new Error(`${suite}: 結果が保存されなかった`);
      const reqs = lines(reqFile).slice(reqBefore);
      const ok = reqs.filter((r) => r.outcome === "ok").map((r) => r.latencyMs as number);
      const cases = row.cases as { id: string; pass: boolean; passes: number; n: number; latencyMs?: number }[];
      const passes = cases.reduce((a, c) => a + c.passes, 0);
      const n = cases.reduce((a, c) => a + c.n, 0);
      suites[suite] = {
        suiteVersion: row.suiteVersion,
        questions: row.total,
        questionsAllPass: row.passed,
        passes,
        n,
        wallSeconds: wall,
        requests: reqs.length,
        requestsNotOk: reqs.length - ok.length,
        requestLatencyMs: { n: ok.length, p50: nearestRank(ok, 0.5), p95: nearestRank(ok, 0.95) },
        perQuestion: cases.map((c) => ({ id: c.id, passes: c.passes, n: c.n, meanMs: c.latencyMs ?? null })),
        rateText: ((await win.getByTestId("assistant-eval-rate").textContent().catch(() => null)) ?? null),
        failedRows: await win.getByTestId("assistant-eval-failed-row").allTextContents(),
      };
      await win.screenshot({ path: path.join(OUT_DIR, `${MODEL_ID}${TAG}-${suite}.png`) });
    }
    result.suites = suites;
  } finally {
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT_DIR, `${MODEL_ID}${TAG}.json`), JSON.stringify(result, null, 2));
    server.kill("SIGTERM");
    await driver.stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

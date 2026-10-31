/*
 * 同梱のローカル AI（llama.cpp の llama-server＋GGUF、LoRA アダプタ任意）が、本物の 2D 窓を自律的に動かせるかを実測する。
 *
 * 実行:  cd automator && LLAMA_SERVER=<llama-server> MODEL_GGUF=<.gguf> MODEL_ID=<manifest の id> \
 *          npx tsx src/spike/assistantAgenticLocalCheck.ts
 *   任意: LLAMA_EXTRA（例 "--lora a.gguf"）、RUN_TAG（結果ファイル名の接尾辞）、SCENES（例 "2,4,1"。既定は全部）、
 *         REPEATS（各場面の繰り返し回数。既定 3。実機のチャットは毎回同じ出力とは限らない）、
 *         LOCAL_PORT（既定 19430）、CPU_THREADS
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic, 43 枚) の #2dviewer 窓 ＋ 製品と同じ起動引数の llama-server。
 * 回帰の組（assistantEvalLocalModel.ts）はツール呼び出しの列だけを見る合成の土台なので、こちらは**画面の実体**で判定する:
 * cornerstone の W/L、スライダの値、操作カードの状態、本文で終わったか、同じ操作の重複、往復数（要求ログ）。
 * 合否は測った値を記録するだけで、閾値は置かない。前提が崩れた場面は「未達」と数え、合格に混ぜない。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Page } from "playwright";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { dismissUpdateDialog } from "./dismissUpdateDialog.js";
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
const LOCAL_PORT = Number(process.env.LOCAL_PORT ?? 19430);
const TAG = process.env.RUN_TAG ?? "";
const EXTRA = (process.env.LLAMA_EXTRA ?? "").split(/\s+/).filter(Boolean);
const K = Number(process.env.REPEATS ?? 3);
const WANT = (process.env.SCENES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const PORTS = { http: 19520, scp: 19521, vite: 19523 };
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-agentic-local");
const SLICES = 43; // fixtures/ct-basic（ファイル 43 枚）。実際の枚数は実行時に getState の前提として読み直す
const PRESETS = { 肺: { center: -600, width: 1500 }, 骨: { center: 300, width: 1500 } } as const; // frontend/src/viewer2d/wlPresets.ts

const md = MANIFEST.models.find((m) => m.id === MODEL_ID);
if (!md) throw new Error(`マニフェストに ${MODEL_ID} が無い`);
const threads = Number(process.env.CPU_THREADS ?? L.defaultThreads(require("node:os").availableParallelism()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(port: number, ms: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch { /* まだ */ }
    await sleep(1000);
  }
  throw new Error("llama-server が起動しない");
}

type Verdict = "pass" | "fail" | "unreached";
interface SceneResult {
  id: number;
  rep: number;
  title: string;
  ask: string;
  verdict: Verdict;
  reasons: string[];
  rounds: number | null;
  calls: string[][];
  cards: string[];
  endedWithText: boolean | null;
  seconds: number;
  before?: unknown;
  after?: unknown;
  botText?: string;
}

const readWl = (v: Page) =>
  v.evaluate(`(function(){ var p = window.__graphyDebug.getViewportProperties()[0]; return p && p.windowLevel ? { center: p.windowLevel.center, width: p.windowLevel.width } : null; })()`) as Promise<{ center: number; width: number } | null>;
const readSlice = async (v: Page) => Number(await v.getByTestId("dim-slider-z").first().inputValue());
/** スライダへ値を直接入れて、本物の入力イベントを起こす（アシスタントを通さない前提づくり）。効いたかは読み直して確かめる。 */
async function setSlice(v: Page, n: number): Promise<boolean> {
  await v.evaluate((val) => {
    const el = document.querySelector('[data-testid="dim-slider-z"]') as HTMLInputElement | null;
    if (!el) return;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, String(val));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, n);
  await v.waitForTimeout(700);
  return (await readSlice(v)) === n;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const args = [...L.serverArgs({ modelPath: GGUF, port: LOCAL_PORT, mark: L.newMark(), jinja: md!.toolMode === "native", reasoning: md!.reasoning ?? null, threads }), ...EXTRA];
  console.log("llama-server", args.join(" "));
  const server: ChildProcess = spawn(LLAMA, args, { stdio: ["ignore", "ignore", "ignore"], cwd: path.dirname(LLAMA), env: { ...process.env, LD_LIBRARY_PATH: path.dirname(LLAMA) } });
  const driver = new DesktopDriver(PORTS);
  const out: Record<string, unknown> = { model: MODEL_ID, threads, extra: EXTRA, ctx: 8192 };
  const results: SceneResult[] = [];
  try {
    await waitHealth(LOCAL_PORT, 10 * 60_000);
    await driver.start();
    const info = await driver.app.evaluate(({ app, dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return { dataDir: process.cwd(), userData: app.getPath("userData") };
    });
    for (const f of ["ai-providers.json", "secrets.enc.json"]) fs.rmSync(path.join(info.dataDir, f), { force: true });
    const reqFile = path.join(info.userData, "ai-requests.jsonl");
    for (const f of [reqFile, `${reqFile}.1`]) fs.rmSync(f, { force: true });
    const reqLines = () => (fs.existsSync(reqFile) ? fs.readFileSync(reqFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { toolCalls?: string[]; outcome?: string }) : []);

    const main: Page = driver.page;
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await dismissUpdateDialog(main);
    await openFirstSeriesInViewer(main, createStepRecorder());
    await dismissUpdateDialog(main);
    const vb = main.getByTestId("viewer2d-toolbar-button");
    console.log("  main:", main.url(), "ボタン数", await vb.count(), "無効", await vb.isDisabled(), "窓数", driver.app.windows().length);
    const viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click({ timeout: 120_000 }), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2500);
    const max = Number(await viewer.getByTestId("dim-slider-z").first().getAttribute("max"));
    out.sliceMax = max;
    out.sliceCountAssumed = SLICES;
    console.log(`  スライダ max=${max}（${SLICES} 枚なら 42）`);

    const local = { id: "local", label: "ローカル LLM", kind: "openai", endpoint: `http://127.0.0.1:${LOCAL_PORT}`, auth: "none", toolMode: md!.toolMode === "native" ? "native" : "none", models: { "text-to-text": MODEL_ID } };
    const set = await main.evaluate((cfg) => (window as unknown as { graphyDesktop: { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean }> } }).graphyDesktop.aiProvidersSet(cfg), { providers: [local], defaults: { "text-to-text": "local" } });
    if (!set.ok) throw new Error(`提供元を保存できない: ${JSON.stringify(set)}`);

    await dismissUpdateDialog(main);
    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.setViewportSize({ width: 680, height: 900 });
    const fresh = async () => {
      await win.reload({ waitUntil: "domcontentloaded" });
      await win.getByTestId("assistant-input").waitFor({ state: "visible", timeout: 20_000 });
      await sleep(600);
    };
    await fresh();

    /** 質問を送り、返答の完了まで待つ。要求ログの増分と、最後の吹き出しの操作カードを返す。 */
    async function ask(q: string) {
      const before = reqLines().length;
      const t0 = Date.now();
      await win.getByTestId("assistant-input").fill(q);
      await win.getByTestId("assistant-send").click();
      await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 5 * 60_000 });
      await sleep(400);
      const reqs = reqLines().slice(before);
      const last = win.getByTestId("assistant-msg-bot").last();
      const cards = await last.locator('[data-testid^="assistant-action-"]').evaluateAll((els) =>
        els.filter((e) => e.getAttribute("data-testid") !== "assistant-action-status").map((e) => `${(e.getAttribute("data-testid") ?? "").replace("assistant-action-", "")}:${e.getAttribute("data-status") ?? ""}`),
      );
      const text = (await last.evaluate((e) => (e as HTMLElement).innerText)).replace(/\s+/g, " ").trim();
      return { reqs, cards, text, seconds: Math.round((Date.now() - t0) / 100) / 10, last, asked: q };
    }

    const scenes: { needsState?: boolean; id: number; title: string; ask: string; askFor?: (pre: { wl: { center: number; width: number } | null }) => string; run: (r: Awaited<ReturnType<typeof ask>>, pre: { slice: number; wl: { center: number; width: number } | null }, v: Verdict[], why: string[]) => Promise<{ after?: unknown } | void>; pre?: () => Promise<string | null> }[] = [
      {
        needsState: true, id: 2, title: "今のスライスから 5 枚先へ（getState の値から計算）", ask: "今のスライスから 5 枚先へ進めて",
        pre: async () => ((await setSlice(viewer, 10)) ? null : "スライダを 10 にできない（前提）"),
        run: async (_r, pre, _v, why) => {
          const s = await readSlice(viewer);
          if (s !== pre.slice + 5) why.push(`スライス ${pre.slice} → ${s}（期待 ${pre.slice + 5}）`);
          return { after: { slice: s } };
        },
      },
      {
        needsState: true, id: 4, title: "ウィンドウ幅を今の 2 倍（大きいときは半分）に", ask: "ウィンドウ幅を今の 2 倍にして",
        askFor: (pre) => (pre.wl && pre.wl.width > 20000 ? "ウィンドウ幅を今の半分にして" : "ウィンドウ幅を今の 2 倍にして"),
        run: async (r, pre, _v, why) => {
          const wl = await readWl(viewer);
          if (!pre.wl || !wl) { why.push("W/L を読めない"); return; }
          const want = r.asked.includes("半分") ? pre.wl.width / 2 : pre.wl.width * 2;
          if (Math.abs(wl.width - want) > Math.max(2, want * 0.02) || Math.abs(wl.center - pre.wl.center) > 2) why.push(`W/L ${JSON.stringify(pre.wl)} → ${JSON.stringify(wl)}（期待 center 同じ・width ${want}）`);
          return { after: wl };
        },
      },
      {
        needsState: true, id: 1, title: "最後のスライスを表示（getState → goToSlice）", ask: "最後のスライスを表示して",
        pre: async () => ((await setSlice(viewer, 10)) ? null : "スライダを 10 にできない（前提）"),
        run: async (_r, _pre, _v, why) => {
          const s = await readSlice(viewer);
          if (s !== max) why.push(`スライス ${s}（期待 ${max}）`);
          return { after: { slice: s } };
        },
      },
      {
        needsState: true, id: 3, title: "最後のスライスに移動して肺（または骨）の条件に（2 つの操作）", ask: "最後のスライスに移動して、肺の条件にして",
        // 前の実行で既に肺条件だと検査が空振りするので、その場合は骨の条件を頼む
        askFor: (pre) => (pre.wl && Math.abs(pre.wl.center - PRESETS.肺.center) <= 2 ? "最後のスライスに移動して、骨の条件にして" : "最後のスライスに移動して、肺の条件にして"),
        pre: async () => ((await setSlice(viewer, 10)) ? null : "スライダを 10 にできない（前提）"),
        run: async (r, pre, _v, why) => {
          const s = await readSlice(viewer);
          const wl = await readWl(viewer);
          if (s !== max) why.push(`スライス ${s}（期待 ${max}）`);
          const want = r.asked.includes("骨") ? PRESETS.骨 : PRESETS.肺;
          if (!wl || Math.abs(wl.center - want.center) > 2 || Math.abs(wl.width - want.width) > 2) why.push(`W/L ${JSON.stringify(wl)}（期待 ${JSON.stringify(want)}）`);
          if (pre.wl && Math.abs(pre.wl.center - want.center) <= 2 && Math.abs(pre.wl.width - want.width) <= 2) why.push("UNREACHED:開始時点で既に期待の W/L（前提）");
          return { after: { slice: s, wl } };
        },
      },
      {
        id: 5, title: "ROI が無いときの計測値の質問（数値を作らない）", ask: "ROI の平均と SD を教えて",
        run: async (r, _pre, _v, why) => {
          if (!r.cards.some((c) => c.startsWith("getMeasurements:"))) why.push("getMeasurements を呼んでいない");
          if (/\d+(\.\d+)?\s*(HU|mm)/.test(r.text)) why.push(`本文に数値（ROI が無いのに）: ${r.text.slice(0, 80)}`);
        },
      },
      {
        id: 6, title: "曖昧な依頼（何も実行しない）", ask: "画像を消して",
        run: async (r, _pre, _v, why) => {
          const ops = r.cards.filter((c) => !/^(getState|getMeasurements):/.test(c));
          if (ops.length) why.push(`操作が実行された: ${ops.join(",")}`);
        },
      },
      {
        id: 7, title: "2D 窓が無い（no-viewer を受けて止まる）", ask: "左右反転して",
        pre: async () => { if (!viewer.isClosed()) { await viewer.close(); await sleep(1000); } return null; },
        run: async (r, _pre, _v, why) => {
          if (!r.cards.some((c) => c.startsWith("flipH:failed"))) why.push(`flipH のカードが「失敗」でない: ${r.cards.join(",")}`);
          if (r.reqs.length > 2) why.push(`往復 ${r.reqs.length}（2 以内で止まるはず）`);
        },
      },
    ];

    const plan = scenes.filter((sc) => !WANT.length || WANT.includes(String(sc.id))).flatMap((sc) => Array.from({ length: K }, (_, rep) => ({ sc, rep })));
    for (const { sc, rep } of plan) {
      console.log(`\n[場面 ${sc.id}] ${sc.title}（${rep + 1}/${K} 回目）`);
      await fresh();
      const why: string[] = [];
      let verdict: Verdict = "pass";
      const noViewer = sc.id === 7;
      const preErr = sc.pre ? await sc.pre() : null;
      const pre = noViewer ? { slice: 0, wl: null } : { slice: await readSlice(viewer), wl: await readWl(viewer) };
      if (preErr) {
        results.push({ id: sc.id, rep, title: sc.title, ask: sc.ask, verdict: "unreached", reasons: [preErr], rounds: null, calls: [], cards: [], endedWithText: null, seconds: 0 });
        console.log(`  未達: ${preErr}`);
        continue;
      }
      const asked = sc.askFor ? sc.askFor(pre) : sc.ask;
      const r = await ask(asked);
      const extra = await sc.run(r, pre, [], why);
      const calls = r.reqs.map((q) => q.toolCalls ?? []);
      const lastReq = r.reqs.at(-1);
      const endedWithText = !!lastReq && lastReq.outcome === "ok" && (lastReq.toolCalls ?? []).length === 0 && r.text.length > 0;
      if (!endedWithText) why.push(`本文で終わっていない（往復 ${r.reqs.length}、最後の呼び出し ${JSON.stringify(lastReq?.toolCalls ?? null)}）`);
      const opNames = r.cards.map((c) => c.split(":")[0]).filter((n) => !/^(getState|getMeasurements)$/.test(n));
      const dup = opNames.filter((n, i) => opNames.indexOf(n) !== i);
      if (dup.length) why.push(`同じ操作の重複: ${[...new Set(dup)].join(",")}`);
      if (sc.needsState) {
        // 状態に依存する依頼は、getState の結果を受けてから操作する（同じ往復で一緒に呼ぶのは推測。たまたま合っても合格にしない）
        const first = calls[0] ?? [];
        if (!first.includes("getState") || first.some((n) => n !== "getState")) why.push(`状態を読んでから操作していない（最初の往復の呼び出し ${JSON.stringify(first)}）`);
      }
      const unreached = why.filter((w) => w.startsWith("UNREACHED:"));
      const failures = why.filter((w) => !w.startsWith("UNREACHED:"));
      if (failures.length) verdict = "fail";
      else if (unreached.length) verdict = "unreached";
      const shot = `${MODEL_ID}${TAG}-scene${sc.id}-${rep + 1}`;
      await win.screenshot({ path: path.join(OUT_DIR, `${shot}-assistant.png`) });
      if (!noViewer) await viewer.screenshot({ path: path.join(OUT_DIR, `${shot}-viewer.png`) });
      results.push({ id: sc.id, rep, title: sc.title, ask: asked, verdict, reasons: why.map((w) => w.replace("UNREACHED:", "")), rounds: r.reqs.length, calls, cards: r.cards, endedWithText, seconds: r.seconds, before: { slice: pre.slice, wl: pre.wl }, after: extra?.after, botText: r.text.slice(0, 200) });
      console.log(`  ${verdict === "pass" ? "合格" : verdict === "fail" ? "失敗" : "未達"}  往復 ${r.reqs.length}  ${r.seconds}s  呼び出し ${JSON.stringify(calls)}${why.length ? "\n    " + why.join("\n    ") : ""}`);
    }
    const n = (v: Verdict) => results.filter((x) => x.verdict === v).length;
    out.k = K;
    out.summary = { pass: n("pass"), fail: n("fail"), unreached: n("unreached"), total: results.length };
    const ids = [...new Set(results.map((x) => x.id))];
    out.perScene = ids.map((id) => ({ id, pass: results.filter((x) => x.id === id && x.verdict === "pass").length, runs: results.filter((x) => x.id === id).length }));
    console.log(`\n実行ごと: 合格 ${n("pass")} / 失敗 ${n("fail")} / 未達 ${n("unreached")}（全 ${results.length} 回）`);
    console.log("場面ごとの合格回数: " + (out.perScene as { id: number; pass: number; runs: number }[]).map((x) => `${x.id}: ${x.pass}/${x.runs}`).join("  "));
  } finally {
    // 準備の段階で止まったとき、画面を見られるようにする（失敗の原因がモデルでなく環境かを切り分けるため）
    await driver.page.screenshot({ path: path.join(OUT_DIR, `${MODEL_ID}${TAG}-main-at-exit.png`) }).catch(() => undefined);
    out.scenes = results;
    out.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT_DIR, `${MODEL_ID}${TAG}.json`), JSON.stringify(out, null, 2));
    server.kill("SIGTERM");
    await driver.stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

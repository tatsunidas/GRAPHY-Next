/*
 * ローカル AI（この PC の軽量 LLM）の導入ウィザード・遅延起動・登録・削除（S4）の実機検証。設計: fw/ai-routing-design.md §18。
 *
 * 実行:  cd automator && npx tsx src/spike/localAiWizardCheck.ts
 *        実モデルの検査も行うとき:  GRAPHY_REAL_LOCAL_AI=<local-ai フォルダ> npx tsx src/spike/localAiWizardCheck.ts
 *        （<local-ai> は runtime/ と models/ を持つ、本体が導入したフォルダ。無ければ B は「未達」と数える）
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓。
 * A（偽 llama-server）: 偽の実行ファイル(Node スクリプト)とモデルを userData に置き、導入済みの状態から検証する。
 *   1. 設定＞AI にローカル AI の区画が出て「導入済み・停止中」になる
 *   2. 起動テストで起動し、提供元 local-llm の endpoint が実ポートへ書き換わる（loopback・auth:none）
 *   3. 縮退先・既定の切り替えが ai-providers.json に反映され、戻せる
 *   4. 起動していない状態で #assistant から会話すると、遅延起動して偽サーバーが答える（画面に返答が出る）
 *   5. 🔴 画面経由の保存で local-llm の endpoint・モデルは変えられない
 *   6. 🔴 負例: 公式の一覧にないファイル・GGUF でないファイルの取り込みは拒否される
 *   7. 削除で停止・登録解除・ファイル削除、既定は元に戻る
 * B（実 llama.cpp ＋ 実 GGUF）: 実モデルで 起動テスト → 会話 → 2D ビューアの表示操作（tool 呼び出し）を行い、W/L を cornerstone から読む。
 *   モデルの出力は毎回違うので、操作の検査は最大 3 回まで試し、回数を記録する（通らなければ失敗として数える）。
 * 未達として残すもの: Windows/macOS の実機、ダウンロード（実ネットワーク）の画面経由の操作、インストーラのチェックボックス。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "local-ai-wizard-check");
const PORTS = { http: 19330, scp: 19331, vite: 19333 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REAL = process.env.GRAPHY_REAL_LOCAL_AI ?? "";

const FAKE_SERVER = `#!/usr/bin/env node
const http = require("http"), fs = require("fs"), path = require("path");
const a = process.argv;
const port = Number(a[a.indexOf("--port") + 1]);
const host = a[a.indexOf("--host") + 1];
const log = path.join(__dirname, "..", "..", "fake-seen.jsonl");
http.createServer((q, r) => {
  if (q.url === "/health") { r.end("{}"); return; }
  const chunks = [];
  q.on("data", (c) => chunks.push(c));
  q.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    fs.appendFileSync(log, JSON.stringify({ argv: a.slice(2), url: q.url, body: raw.slice(0, 2000) }) + "\\n");
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    if (body.stream) {
      r.writeHead(200, { "Content-Type": "text/event-stream" });
      r.write("data: " + JSON.stringify({ choices: [{ delta: { content: "ローカル(偽)の返答です。" }, finish_reason: "stop" }] }) + "\\n\\n");
      r.write("data: [DONE]\\n\\n");
      r.end();
      return;
    }
    r.setHeader("Content-Type", "application/json");
    r.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ローカル(偽)の返答です。" } }] }));
  });
}).listen(port, host);
process.on("SIGTERM", () => process.exit(0));
`;

type Bridge = {
  aiProvidersGet: () => Promise<{ providers: { id: string; endpoint: string; auth?: unknown; models: Record<string, string>; toolMode?: string }[]; defaults: Record<string, string>; fallbacks?: Record<string, string[]> }>;
  aiProvidersSet: (cfg: unknown) => Promise<{ ok: boolean; problems: string[] }>;
  aiLocalStatus: () => Promise<{ running?: boolean; registered?: boolean; runtime?: { installed: boolean }; model?: { installed: boolean; verified: boolean } }>;
  aiLocalImport: (u: boolean) => Promise<{ ok: boolean; error?: string }>;
};

async function openAiPanel(page: Page): Promise<void> {
  const dialogOpen = await page.getByTestId("settings-dialog").isVisible().catch(() => false);
  if (dialogOpen) {
    await page.getByTestId("dialog-close-button").click();
    await page.getByTestId("settings-dialog").waitFor({ state: "detached", timeout: 5_000 });
  }
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("settings-cat-ai").click();
  await page.getByTestId("ai-panel").waitFor({ state: "visible", timeout: 10_000 });
}

async function readWl(viewer: Page): Promise<{ center: number; width: number } | null> {
  return viewer.evaluate(`(function(){ var p = window.__graphyDebug.getViewportProperties()[0]; return p && p.windowLevel ? { center: p.windowLevel.center, width: p.windowLevel.width } : null; })()`) as Promise<{ center: number; width: number } | null>;
}

function writeState(root: string, state: unknown): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state));
}

function seedFake(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  const dir = path.join(root, "runtime", "build-bFAKE");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "llama-server"), FAKE_SERVER, { mode: 0o755 });
  fs.mkdirSync(path.join(root, "models"), { recursive: true });
  fs.writeFileSync(path.join(root, "models", "fake.gguf"), Buffer.concat([Buffer.from("GGUF"), Buffer.alloc(64)]));
  writeState(root, { runtime: { build: "bFAKE", exe: "build-bFAKE/llama-server" }, model: { id: "fake", file: "fake.gguf", verified: true, toolMode: "none" } });
}

function seedReal(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "models"), { recursive: true });
  fs.cpSync(path.join(REAL, "runtime"), path.join(root, "runtime"), { recursive: true, verbatimSymlinks: true });
  const gguf = "Qwen3-1.7B-Q8_0.gguf";
  fs.symlinkSync(path.join(REAL, "models", gguf), path.join(root, "models", gguf));
  const exe = fs.readdirSync(path.join(root, "runtime")).map((d) => `${d}/llama-b11804/llama-server`).find((p) => fs.existsSync(path.join(root, "runtime", p)));
  writeState(root, { runtime: { build: "b11804", exe }, model: { id: "qwen3-1-7b-q8", file: gguf, verified: true, toolMode: "native" } });
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver(PORTS);
  let dataDir = "";
  try {
    await driver.start();
    const info = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      // ファイル選択は、試験が決めたパスを返す
      (globalThis as unknown as { __pick: string }).__pick = "";
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [(globalThis as unknown as { __pick: string }).__pick] })) as unknown as typeof dialog.showOpenDialog;
      return { cwd: process.cwd() };
    });
    dataDir = info.cwd;
    const root = path.join(dataDir, "local-ai");
    const pick = (p: string) => driver.app.evaluate((_a, v) => { (globalThis as unknown as { __pick: string }).__pick = v; }, p);
    for (const f of ["ai-providers.json", "secrets.enc.json", "first-run-local-llm.flag"]) {
      if (fs.existsSync(path.join(dataDir, f))) fs.rmSync(path.join(dataDir, f));
    }
    fs.rmSync(root, { recursive: true, force: true });
    const main: Page = driver.page;
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await openFirstSeriesInViewer(main, createStepRecorder());
    const viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2500);
    const bridge = <T,>(fn: (b: Bridge) => Promise<T>) => main.evaluate(`(${fn.toString()})(window.graphyDesktop)`) as Promise<T>;

    // ── 0. 導入前 ──
    console.log("\n[0] 導入前");
    await openAiPanel(main);
    check(await main.getByTestId("ai-local").isVisible(), "設定＞AI にローカル AI の区画が出る");
    check(await main.getByTestId("ai-local-install").isVisible(), "未導入なら『ダウンロードして導入』が出る");
    check((await main.getByTestId("ai-local-model").locator("option").count()) >= 2, "モデルを選べる（同梱マニフェストの一覧）");
    check((await main.getByTestId("ai-local-ready").count()) === 0, "未導入なら導入済みの区画は出ない");
    await main.screenshot({ path: path.join(OUT_DIR, "0-not-installed.png") });

    // ── A. 偽 llama-server ──
    console.log("\n[A1] 導入済み・停止中");
    seedFake(root);
    await openAiPanel(main);
    await main.getByTestId("ai-local-ready").waitFor({ state: "visible", timeout: 10_000 });
    const st1 = await bridge((b) => b.aiLocalStatus());
    check(st1.runtime?.installed === true && st1.model?.installed === true && st1.running === false, "導入済み・停止中として見える", st1);
    check((await main.getByTestId("ai-local-unverified").count()) === 0, "公式のモデルなら『検証できていません』は出ない");

    console.log("\n[A2] 起動テスト");
    await main.getByTestId("ai-local-check").click();
    await main.getByTestId("ai-local-message").waitFor({ state: "visible", timeout: 30_000 });
    const cfg2 = await bridge((b) => b.aiProvidersGet());
    const llm2 = cfg2.providers.find((p) => p.id === "local-llm");
    const rec2 = JSON.parse(fs.readFileSync(path.join(root, "server.json"), "utf8")) as { port: number; pid: number };
    check(!!llm2, "起動すると提供元 local-llm が登録される", cfg2.providers.map((p) => p.id));
    check(llm2?.endpoint === `http://127.0.0.1:${rec2.port}`, "🔑 endpoint は起動した実ポート（loopback）", [llm2?.endpoint, rec2.port]);
    check(llm2?.auth === "none", "🔴 auth は none（鍵を持たない）", llm2?.auth);
    check((await bridge((b) => b.aiLocalStatus())).running === true, "起動中として見える");
    await main.screenshot({ path: path.join(OUT_DIR, "A2-running.png") });

    console.log("\n[A3] 縮退先・既定");
    await main.getByTestId("ai-local-fallback").check();
    await sleep(800);
    const cfg3 = await bridge((b) => b.aiProvidersGet());
    check(JSON.stringify(cfg3.fallbacks?.["text-to-text"]) === '["local-llm"]', "縮退先に入る", cfg3.fallbacks);
    const defaultBefore = cfg3.defaults["text-to-text"];
    await main.getByTestId("ai-local-default").check();
    await sleep(800);
    check((await bridge((b) => b.aiProvidersGet())).defaults["text-to-text"] === "local-llm", "会話の既定を local-llm にできる");
    check(defaultBefore !== "local-llm", "（前提）変更前の既定は local-llm ではなかった", defaultBefore);

    console.log("\n[A4] 停止中に #assistant から会話 → 遅延起動");
    process.kill(rec2.pid, "SIGTERM");
    for (let i = 0; i < 40; i++) {
      if (!(await bridge((b) => b.aiLocalStatus())).running) break;
      await sleep(250);
    }
    check((await bridge((b) => b.aiLocalStatus())).running === false, "（前提）サーバーを止めた");
    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("dialog-close-button").click();
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.getByTestId("assistant-input").fill("こんにちは");
    await win.getByTestId("assistant-send").click();
    await win.getByTestId("assistant-msg-bot").last().waitFor({ state: "visible", timeout: 60_000 });
    await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 60_000 });
    const botText = (await win.getByTestId("assistant-msg-bot").last().textContent()) ?? "";
    check(botText.includes("ローカル(偽)の返答です"), "停止中でも会話すると自動で起動して偽サーバーが答える", botText);
    const seen = fs.readFileSync(path.join(root, "fake-seen.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; url: string; body: string });
    const last = seen[seen.length - 1];
    check(last.url === "/v1/chat/completions", "POST /v1/chat/completions が届いた", last.url);
    check(last.argv[last.argv.indexOf("--host") + 1] === "127.0.0.1", "🔴 llama-server は 127.0.0.1 にだけ bind して起動された", last.argv);
    check(last.argv.includes("--no-webui") && last.argv.some((a) => a.startsWith("graphy-local-llm:")), "Web UI なし・目印つきの引数で起動された", last.argv);
    await win.screenshot({ path: path.join(OUT_DIR, "A4-assistant-fake.png") });
    await win.close();

    console.log("\n[A5] 🔴 画面経由の保存では local-llm の宛先を変えられない");
    const cfg5 = await bridge((b) => b.aiProvidersGet());
    const evil = cfg5.providers.map((p) => (p.id === "local-llm" ? { ...p, endpoint: "http://127.0.0.1:9", models: { "text-to-text": "evil" } } : p));
    const set5 = await main.evaluate((c) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiProvidersSet(c), { providers: evil, defaults: cfg5.defaults });
    const cfg5b = await bridge((b) => b.aiProvidersGet());
    const after = cfg5b.providers.find((p) => p.id === "local-llm");
    check(set5.ok === true, "保存自体は通る（他の提供元の編集を妨げない）", set5);
    check(after?.endpoint === cfg5.providers.find((p) => p.id === "local-llm")?.endpoint, "🔴 endpoint は書き換わらない", [after?.endpoint]);
    check(after?.models["text-to-text"] !== "evil", "🔴 モデル名も書き換わらない", after?.models);

    console.log("\n[A6] 🔴 負例: 取り込み");
    const junk = path.join(OUT_DIR, "junk.bin");
    const fakeGguf = path.join(OUT_DIR, "not-really.gguf");
    fs.writeFileSync(junk, "hello");
    fs.writeFileSync(fakeGguf, "this is not gguf");
    await pick(junk);
    const imp1 = await bridge((b) => b.aiLocalImport(false));
    check(imp1.ok === false && imp1.error === "unknown-file", "公式の一覧にないファイルは拒否", imp1);
    await pick(fakeGguf);
    const imp2 = await bridge((b) => b.aiLocalImport(true));
    check(imp2.ok === false && imp2.error === "not-gguf", "GGUF の見出しが無いものは、検証なしでも拒否", imp2);
    const st6 = await bridge((b) => b.aiLocalStatus());
    check(st6.model?.verified === true, "拒否したあとも導入済みのモデルは変わらない", st6);

    // ── B. 実モデル ──
    console.log("\n[B] 実 llama.cpp + 実 GGUF");
    if (!REAL || !fs.existsSync(path.join(REAL, "runtime"))) {
      check(false, "（未達）実モデルの検査: GRAPHY_REAL_LOCAL_AI が無い／runtime が無い。B は実行していない");
    } else {
      await openAiPanel(main);
      await main.getByTestId("ai-local-remove").click();
      await main.getByTestId("ai-local-install").waitFor({ state: "visible", timeout: 20_000 });
      seedReal(root);
      await openAiPanel(main);
      await main.getByTestId("ai-local-ready").waitFor({ state: "visible", timeout: 10_000 });
      const t0 = Date.now();
      await main.getByTestId("ai-local-check").click();
      await main.getByTestId("ai-local-message").waitFor({ state: "visible", timeout: 180_000 });
      const startMs = Date.now() - t0;
      check(true, `実 llama-server が起動し /health が通った（${startMs} ms）`);
      const cfgB = await bridge((b) => b.aiProvidersGet());
      check(cfgB.providers.find((p) => p.id === "local-llm")?.toolMode === "native", "実モデルは toolMode:native で登録された", cfgB.providers.find((p) => p.id === "local-llm"));
      await main.getByTestId("ai-local-default").check();
      await sleep(800);
      check((await bridge((b) => b.aiProvidersGet())).defaults["text-to-text"] === "local-llm", "（前提）会話の既定が local-llm");
      await main.screenshot({ path: path.join(OUT_DIR, "B1-real-ready.png") });

      const w2 = await driver.waitForNewPage(async () => {
        await main.getByTestId("dialog-close-button").click();
        await main.getByTestId("mainscreen-menu-system").click();
        await main.getByTestId("menu-item-assistant").click();
      }, (u) => u.includes("#assistant"));
      await w2.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
      const ask = async (q: string) => {
        await w2.getByTestId("assistant-input").fill(q);
        await w2.getByTestId("assistant-send").click();
        await w2.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 180_000 });
      };
      const t1 = Date.now();
      await ask("こんにちは。何ができますか?");
      const hello = ((await w2.getByTestId("assistant-msg-bot").last().textContent()) ?? "").trim();
      check(hello.length > 5, `実モデルが日本語で返答した（${Date.now() - t1} ms）`, hello.slice(0, 80));
      await w2.screenshot({ path: path.join(OUT_DIR, "B2-real-hello.png") });

      const wl0 = await readWl(viewer);
      let done = false;
      let attempts = 0;
      for (; attempts < 3 && !done; attempts++) {
        const t2 = Date.now();
        await ask("ウィンドウ幅を400、レベルを40にしてください");
        const wl = await readWl(viewer);
        done = !!wl && Math.abs(wl.center - 40) <= 1 && Math.abs(wl.width - 400) <= 1;
        console.log(`  試行${attempts + 1}: ${Date.now() - t2} ms W/L=${JSON.stringify(wl)} 初期=${JSON.stringify(wl0)}`);
      }
      check(done, `🔑 実ローカルモデルの tool 呼び出しで、2D 窓の W/L が実際に 40/400 になった（試行 ${attempts} 回）`, await readWl(viewer));
      await w2.screenshot({ path: path.join(OUT_DIR, "B3-real-operate.png") });
      const card = w2.getByTestId("assistant-action-setWindowLevel").last();
      if (done && (await card.count()) > 0) {
        await card.getByTestId("assistant-undo").click();
        await w2.waitForFunction(() => document.querySelector('[data-testid="assistant-action-setWindowLevel"]')?.getAttribute("data-status") === "undone", null, { timeout: 10_000 }).catch(() => undefined);
        const wlU = await readWl(viewer);
        check(!!wlU && !!wl0 && Math.abs(wlU.center - wl0.center) <= 1 && Math.abs(wlU.width - wl0.width) <= 1, "『元に戻す』で初期の W/L に戻る", [wlU, wl0]);
      }
      await w2.close();
    }

    // ── 7. 削除 ──
    console.log("\n[A7] 削除");
    await openAiPanel(main);
    if (await main.getByTestId("ai-local-ready").isVisible().catch(() => false)) {
      await main.getByTestId("ai-local-remove").click();
    } else {
      seedFake(root);
      await openAiPanel(main);
      await main.getByTestId("ai-local-remove").click();
    }
    await main.getByTestId("ai-local-install").waitFor({ state: "visible", timeout: 20_000 });
    const cfg7 = await bridge((b) => b.aiProvidersGet());
    check(!cfg7.providers.some((p) => p.id === "local-llm"), "削除すると提供元 local-llm が消える", cfg7.providers.map((p) => p.id));
    check(cfg7.defaults["text-to-text"] !== "local-llm", "既定は local-llm のままにならない（元に戻る）", cfg7.defaults);
    check(!(cfg7.fallbacks?.["text-to-text"] ?? []).includes("local-llm"), "縮退先からも消える", cfg7.fallbacks);
    check(!fs.existsSync(root), "local-ai フォルダごと削除される");
    await main.screenshot({ path: path.join(OUT_DIR, "A7-removed.png") });
  } finally {
    await driver.stop().catch(() => undefined);
    for (const f of ["ai-providers.json", "secrets.enc.json"]) {
      if (dataDir && fs.existsSync(path.join(dataDir, f))) fs.rmSync(path.join(dataDir, f));
    }
    if (dataDir) fs.rmSync(path.join(dataDir, "local-ai"), { recursive: true, force: true });
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

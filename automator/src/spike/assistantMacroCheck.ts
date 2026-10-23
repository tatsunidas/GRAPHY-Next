/*
 * アシスタントのマクロ（S5a）の実機検証。計画: S5a（表示操作の保存と再生）。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantMacroCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓 ＋ loopback の偽 OpenAI 互換サーバー。
 * 確かめること:
 *   1. AI が実行した 2 操作（W/L・反転）が候補に出て、名前を付けて保存できる
 *   2. 🔴 アシスタント窓を閉じて開き直しても、保存したマクロが残る（userData/assistant-macros.json）
 *   3. 🔴 再生で 2D 窓の W/L が実際に変わる（cornerstone の値）。モデルへは何も送らない（偽サーバーへの要求数が増えない）
 *   4. 「直前の実行を全部元に戻す」で W/L が元に戻る
 *   5. 負例: ファイルを書き換えて未知 id を混ぜたマクロは、読み込み側で落ちるか再生が拒否され、2D 窓は変わらない
 *   6. 負例: 他の窓（メイン・2D）からの assistantMacros* は forbidden
 *   7. 負例: 2D 窓が無いと再生は止まり、理由（no-viewer）が出る
 * 未達として残すもの: 実モデルがマクロ向きの操作列を作るか／手動操作の記録／パラメータ編集。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Page } from "playwright";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-macro-check");
const PORTS = { http: 19340, scp: 19341, vite: 19343 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Msg { role: string; content?: unknown; tool_call_id?: string }
const seen: { messages: Msg[] }[] = [];

/** 質問文の合言葉で、最初の往復は tool_calls、ツール結果を受けた次の往復は本文を返す。 */
const SCRIPT: Record<string, { name: string; args: unknown }> = {
  WL: { name: "setWindowLevel", args: { center: 123, width: 456 } },
  FLIP: { name: "flipH", args: {} },
};

function startFake(port: number) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: { messages?: Msg[]; stream?: boolean } = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* */ }
      const messages = body.messages ?? [];
      seen.push({ messages });
      const last = messages[messages.length - 1];
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
      const key = Object.keys(SCRIPT).find((k) => userText.includes(k));
      const wantCall = !!key && last?.role !== "tool";
      const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
      if (!body.stream) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "OK" } }] })); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (wantCall) {
        const c = SCRIPT[key!];
        const argStr = JSON.stringify(c.args);
        res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${key}`, function: { name: c.name, arguments: argStr.slice(0, 3) } }] } }] }));
        res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(3) } }] }, finish_reason: "tool_calls" }] }));
      } else {
        res.write(sse({ choices: [{ delta: { content: "完了しました。" }, finish_reason: "stop" }] }));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

async function readWl(viewer: Page): Promise<{ center: number; width: number } | null> {
  return viewer.evaluate(`(function(){ var p = window.__graphyDebug.getViewportProperties()[0]; return p && p.windowLevel ? { center: p.windowLevel.center, width: p.windowLevel.width } : null; })()`) as Promise<{ center: number; width: number } | null>;
}

const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fakePort = await freePort();
  const fake = startFake(fakePort);
  const driver = new DesktopDriver(PORTS);
  let dataDir = "";
  let userData = "";
  const clean = () => {
    for (const f of ["ai-providers.json", "secrets.enc.json"]) {
      if (dataDir && fs.existsSync(path.join(dataDir, f))) fs.rmSync(path.join(dataDir, f));
    }
  };
  try {
    await driver.start();
    const info = await driver.app.evaluate(({ dialog, app }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return { cwd: process.cwd(), userData: app.getPath("userData") };
    });
    dataDir = info.cwd;
    userData = info.userData;
    clean();
    const journalFile = path.join(userData, "assistant-journal.jsonl");
    for (const f of [journalFile, `${journalFile}.1`]) if (fs.existsSync(f)) fs.rmSync(f);
    const main: Page = driver.page;
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await openFirstSeriesInViewer(main, createStepRecorder());
    const viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2500);
    const wl0 = await readWl(viewer);
    check(!!wl0, "2D 窓の W/L を cornerstone から読める（前提）", wl0);
    const slice0 = await viewer.getByTestId("dim-slider-z").first().inputValue();
    console.log(`  初期 W/L=${JSON.stringify(wl0)} slice=${slice0}`);

    const local = { id: "local", label: "ローカル LLM", kind: "openai", endpoint: `http://127.0.0.1:${fakePort}`, auth: "none", models: { "text-to-text": "tiny" } };
    const set = await main.evaluate(
      (cfg) => (window as unknown as { graphyDesktop: { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean }> } }).graphyDesktop.aiProvidersSet(cfg),
      { providers: [local], defaults: { "text-to-text": "local" } },
    );
    check(set.ok === true, "ローカル提供元（native tools）を保存できる", set);

    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.setViewportSize({ width: 520, height: 780 });
    await win.getByTestId("assistant-input").waitFor({ state: "visible" });
    await sleep(600);
    const ask = async (q: string) => {
      await win.getByTestId("assistant-input").fill(q);
      await win.getByTestId("assistant-send").click();
      await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 30_000 });
    };

    const macroFile = path.join(userData, "assistant-macros.json");
    if (fs.existsSync(macroFile)) fs.rmSync(macroFile);

    // --- 1. 候補と保存 ---
    console.log("\n[1] 候補と保存");
    await win.getByTestId("assistant-macro-toggle").click();
    check((await win.getByTestId("assistant-macro-nocand").count()) === 1, "操作の前は候補が無い旨が出る");
    await ask("WL ウィンドウを変えて");
    await ask("FLIP 反転して");
    await viewer.waitForTimeout(500);
    const wl1 = await readWl(viewer);
    check(!!wl1 && near(wl1.center, 123) && near(wl1.width, 456), "前提: AI の操作で W/L が 123/456 になった", wl1);
    check((await win.getByTestId("assistant-macro-pick").count()) === 2, "候補が 2 件（W/L・反転）");
    await win.getByTestId("assistant-macro-name-input").fill("肺条件");
    await win.getByTestId("assistant-macro-save").click();
    await win.getByTestId("assistant-macro-item").first().waitFor({ state: "visible", timeout: 10_000 });
    check((await win.getByTestId("assistant-macro-name").first().textContent()) === "肺条件", "保存したマクロが一覧に出る");
    await win.screenshot({ path: path.join(OUT_DIR, "1-panel.png") });
    check(fs.existsSync(macroFile), "assistant-macros.json ができる");
    const saved = JSON.parse(fs.readFileSync(macroFile, "utf8")) as { macros: { steps: { id: string; params: Record<string, unknown> }[] }[] };
    check(saved.macros[0]?.steps.map((s) => s.id).join() === "setWindowLevel,flipH" && saved.macros[0].steps[0].params.center === 123, "ファイルに操作 id と数値だけが入る", saved);
    check(!/patient|\b\d+(\.\d+){5,}\b/i.test(JSON.stringify(saved)), "🔴 ファイルに患者情報・UID が無い");

    // --- 2. 開き直しても残る ---
    console.log("\n[2] 開き直し");
    await win.close();
    await sleep(800);
    const win2 = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win2.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win2.setViewportSize({ width: 520, height: 780 });
    await win2.getByTestId("assistant-macro-toggle").click();
    await win2.getByTestId("assistant-macro-item").first().waitFor({ state: "visible", timeout: 10_000 });
    check((await win2.getByTestId("assistant-macro-name").first().textContent()) === "肺条件", "🔴 開き直してもマクロが残る");

    // --- 3. 再生 ---
    console.log("\n[3] 再生");
    // 画面を別の値にしてから再生し、再生で 123/456 に戻ることを見る。
    await win2.evaluate(() => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<unknown> } }).graphyDesktop.assistantViewerCmd("pre", { kind: "action", id: "setWindowLevel", params: { center: 40, width: 400 } }));
    await viewer.waitForTimeout(500);
    const reqBefore = seen.length;
    const rWlBefore = await readWl(viewer);
    await win2.getByTestId("assistant-macro-run").first().click();
    await win2.getByTestId("assistant-macro-msg").waitFor({ state: "visible", timeout: 15_000 });
    await viewer.waitForTimeout(600);
    const rWl = await readWl(viewer);
    check(((await win2.getByTestId("assistant-macro-msg").textContent()) ?? "").includes("2"), "完了の表示が出る", await win2.getByTestId("assistant-macro-msg").textContent());
    check(seen.length === reqBefore, "🔴 再生でモデルへ要求を送っていない", { before: reqBefore, after: seen.length });
    check(!!rWlBefore && near(rWlBefore.center, 40), "前提: 再生前は別の W/L（40/400）", rWlBefore);
    check(!!rWl && near(rWl.center, 123) && near(rWl.width, 456), "🔴 再生で 2D 窓の W/L が 123/456", { before: rWlBefore, after: rWl });
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-viewer-after-run.png") });
    await win2.screenshot({ path: path.join(OUT_DIR, "3-after-run.png") });

    // --- 4. 全部取り消す ---
    console.log("\n[4] 全部取り消す");
    await win2.getByTestId("assistant-macro-undo").click();
    await win2.waitForFunction(() => /./.test(document.querySelector('[data-testid="assistant-macro-msg"]')?.textContent ?? ""), null, { timeout: 10_000 });
    await viewer.waitForTimeout(600);
    const wlU = await readWl(viewer);
    check(!!wlU && !!rWlBefore && near(wlU.center, rWlBefore.center) && near(wlU.width, rWlBefore.width), "🔴 取り消しで再生前の W/L に戻る", { beforeRun: rWlBefore, afterUndo: wlU });

    // --- 5. 負例: 書き換えられたファイル ---
    console.log("\n[5] 書き換えられたファイル");
    fs.writeFileSync(macroFile, JSON.stringify({ macros: [{ id: "evil", name: "危険", steps: [{ id: "flipH" }, { id: "deleteStudy", params: {} }] }, { id: "evil2", name: "範囲外", steps: [{ id: "setWindowLevel", params: { center: 1, width: -5 } }] }] }));
    await win2.getByTestId("assistant-macro-toggle").click();
    await win2.getByTestId("assistant-macro-toggle").click();
    await win2.getByTestId("assistant-macro-item").first().waitFor({ state: "visible", timeout: 10_000 });
    const wlE0 = await readWl(viewer);
    for (const i of [0, 1]) {
      await win2.getByTestId("assistant-macro-run").nth(i).click();
      await win2.waitForTimeout(900);
      const msg = (await win2.getByTestId("assistant-macro-msg").textContent()) ?? "";
      check(/unknown-action|out-of-range/.test(msg), `🔴 不正なマクロ(${i + 1}) は再生が拒否され理由が出る`, msg);
    }
    const wlE1 = await readWl(viewer);
    check(!!wlE0 && !!wlE1 && near(wlE0.center, wlE1.center) && near(wlE0.width, wlE1.width), "🔴 不正なマクロでは 2D 窓が 1 つも動かない（先頭の flipH も実行されない）", { before: wlE0, after: wlE1 });
    await win2.screenshot({ path: path.join(OUT_DIR, "4-rejected.png") });

    // --- 6. forbidden ---
    console.log("\n[6] 他の窓から");
    for (const [label, page] of [["メイン窓", main], ["2D 窓", viewer]] as const) {
      const r = await page.evaluate(() => {
        const d = (window as unknown as { graphyDesktop: { assistantMacrosList: () => Promise<{ error?: string }>; assistantMacrosSave: (m: unknown) => Promise<{ error?: string }>; assistantMacrosDelete: (i: string) => Promise<{ error?: string }> } }).graphyDesktop;
        return Promise.all([d.assistantMacrosList(), d.assistantMacrosSave({ name: "x", steps: [{ id: "invert" }] }), d.assistantMacrosDelete("evil")]);
      });
      check(r.every((x) => x.error === "forbidden"), `🔴 ${label}からの list/save/delete は forbidden`, r);
    }
    check(JSON.parse(fs.readFileSync(macroFile, "utf8")).macros.length === 2, "forbidden の呼び出しでファイルは変わらない");

    // --- 7. 2D 窓が無い ---
    console.log("\n[7] 2D 窓が無い");
    await viewer.close();
    await sleep(800);
    await win2.getByTestId("assistant-macro-run").nth(0).click();
    await win2.waitForFunction(() => /no-viewer/.test(document.querySelector('[data-testid="assistant-macro-msg"]')?.textContent ?? ""), null, { timeout: 10_000 }).catch(() => undefined);
    const nvMsg = (await win2.getByTestId("assistant-macro-msg").textContent()) ?? "";
    check(/no-viewer|unknown-action/.test(nvMsg), "🔴 2D 窓が無いと止まり理由が出る", nvMsg);
    await win2.screenshot({ path: path.join(OUT_DIR, "5-no-viewer.png") });
  } finally {
    await driver.stop();
    fake.close();
    clean();
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

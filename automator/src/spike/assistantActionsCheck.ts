/*
 * AI アシスタントによる 2D ビューアの表示操作（S2）の実機検証。設計: fw/ai-routing-design.md §17。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantActionsCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓 ＋ loopback の偽 OpenAI 互換サーバー（SSE・tool_calls）。
 * **画面の値は 2D 窓の cornerstone から直接読む**（__graphyDebug.getViewportProperties / スライダ）。
 * 何を確かめるか:
 *   1. getState: モデルへ返る状態に UID・患者キー・imageId・apiBase が無い
 *   2. setWindowLevel が実際に 2D 窓の W/L を変え、「元に戻す」で元の値に戻る
 *   3. goToSlice が実際にスライスを動かし、元に戻せる
 *   4. 負例: 範囲外の引数は 2D 窓へ届かず（履歴にも残らず）、カードは「実行できませんでした」
 *   5. 負例: データを変える id（clearRois 等）は実行されない（カードも作られず、モデルにエラーが返る）
 *   6. propose_steps は手順カードだけで何も実行しない
 *   7. 2D 窓が無いと no-viewer（カードに出る）
 *   8. 負例: メイン窓・2D 窓から assistantViewerCmd は forbidden
 *   9. 操作履歴（assistant-journal.jsonl）に操作が残り、患者情報が無い
 * 未達として残すもの: 実 Gemini/OpenAI・実ローカルモデルが tools を正しく呼ぶか／https のクラウド宛で seriesLabel が除かれる経路の実機（偽サーバーは loopback＝ローカル判定のため）。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-actions-check");
const PORTS = { http: 19320, scp: 19321, vite: 19323 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Msg { role: string; content?: unknown; tool_call_id?: string }
const seen: { messages: Msg[] }[] = [];

/** 質問文の合言葉で、最初の往復は tool_calls、ツール結果を受けた次の往復は本文を返す。 */
const SCRIPT: Record<string, { name: string; args: unknown }> = {
  STATE: { name: "getState", args: {} },
  WL: { name: "setWindowLevel", args: { center: 123, width: 456 } },
  SLICE: { name: "goToSlice", args: { index: 3 } },
  BAD: { name: "setWindowLevel", args: { center: 1, width: -5 } },
  DATA: { name: "clearRois", args: {} },
  PROPOSE: { name: "propose_steps", args: { title: "ROI を描いて保存する", steps: ["ROI ツールを選ぶ", "画像上でドラッグする", "保存を押す"] } },
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
    await win.getByTestId("assistant-input").waitFor({ state: "visible" });
    await sleep(600);
    const ask = async (q: string) => {
      await win.getByTestId("assistant-input").fill(q);
      await win.getByTestId("assistant-send").click();
      await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 30_000 });
    };
    const lastBot = () => win.getByTestId("assistant-msg-bot").last();

    // --- 1. getState ---
    console.log("\n[1] getState");
    await ask("STATE 状態を教えて");
    const stateCard = lastBot().getByTestId("assistant-action-getState");
    check((await stateCard.count()) === 1 && (await stateCard.getAttribute("data-status")) === "done", "getState のカードが「実行しました」");
    const toolMsg = [...seen].reverse().find((s) => s.messages.some((m) => m.role === "tool"))?.messages.filter((m) => m.role === "tool").pop();
    const toolText = String(toolMsg?.content ?? "");
    check(toolText.includes('"tiles"') && toolText.includes("CT"), "モデルへ返った状態にタイル情報（modality）が入る", toolText.slice(0, 200));
    check(!/\b\d+(\.\d+){5,}\b/.test(toolText), "🔴 状態に UID（Study/Series/SOP）が含まれない", toolText.slice(0, 300));
    check(!/patientKey|studyUid|seriesUid|imageId|apiBase|wadouri|http:/i.test(toolText), "🔴 状態に識別子・URL が含まれない");

    // --- 2. W/L ---
    console.log("\n[2] setWindowLevel と元に戻す");
    await ask("WL ウィンドウを変えて");
    const wlCard = lastBot().getByTestId("assistant-action-setWindowLevel");
    check((await wlCard.getAttribute("data-status")) === "done", "カードが「実行しました」");
    await viewer.waitForTimeout(500);
    const wl1 = await readWl(viewer);
    check(!!wl1 && near(wl1.center, 123) && near(wl1.width, 456), "🔴 2D 窓の W/L が実際に 123/456 になった（cornerstone の値）", { before: wl0, after: wl1 });
    await win.screenshot({ path: path.join(OUT_DIR, "1-assistant-wl.png") });
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-viewer-wl.png") });
    await wlCard.getByTestId("assistant-undo").click();
    await win.waitForFunction(() => document.querySelector('[data-testid="assistant-action-setWindowLevel"]')?.getAttribute("data-status") === "undone", null, { timeout: 10_000 });
    await viewer.waitForTimeout(500);
    const wl2 = await readWl(viewer);
    check(!!wl0 && !!wl2 && near(wl2.center, wl0.center) && near(wl2.width, wl0.width), "🔴 「元に戻す」で W/L が元の値に戻る", { initial: wl0, afterUndo: wl2 });

    // --- 3. スライス ---
    console.log("\n[3] goToSlice と元に戻す");
    await ask("SLICE 4 枚目へ");
    await viewer.waitForTimeout(600);
    const s1 = await viewer.getByTestId("dim-slider-z").first().inputValue();
    check(s1 === "3", "🔴 2D 窓のスライスが実際に 3 になった（スライダの値）", { before: slice0, after: s1 });
    const sCard = lastBot().getByTestId("assistant-action-goToSlice");
    await sCard.getByTestId("assistant-undo").click();
    await win.waitForFunction(() => document.querySelector('[data-testid="assistant-action-goToSlice"]')?.getAttribute("data-status") === "undone", null, { timeout: 10_000 });
    await viewer.waitForTimeout(600);
    const s2 = await viewer.getByTestId("dim-slider-z").first().inputValue();
    check(s2 === slice0, "🔴 「元に戻す」でスライスが元に戻る", { initial: slice0, afterUndo: s2 });

    // --- 4. 負例: 範囲外 ---
    console.log("\n[4] 範囲外の引数");
    await ask("BAD 幅をマイナスに");
    const badCard = lastBot().getByTestId("assistant-action-setWindowLevel");
    check((await badCard.getAttribute("data-status")) === "failed", "🔴 カードが「実行できませんでした」");
    const wl3 = await readWl(viewer);
    check(!!wl0 && !!wl3 && near(wl3.center, wl0.center) && near(wl3.width, wl0.width), "2D 窓の W/L は変わっていない", wl3);
    const errTool = JSON.parse(String([...seen].reverse()[0].messages.filter((m) => m.role === "tool").pop()?.content ?? "{}"));
    check(errTool.ok === false && /out-of-range/.test(errTool.error), "モデルへ理由（out-of-range）が返る", errTool);

    // --- 5. 負例: データ系 ---
    console.log("\n[5] データを変える id");
    await ask("DATA ROI を全部消して");
    check((await lastBot().getByTestId("assistant-action-clearRois").count()) === 0, "🔴 clearRois の実行カードは作られない");
    const dataTool = JSON.parse(String([...seen].reverse()[0].messages.filter((m) => m.role === "tool").pop()?.content ?? "{}"));
    check(dataTool.ok === false && dataTool.error === "unknown-tool", "🔴 モデルへ unknown-tool が返る（実行されていない）", dataTool);

    // --- 6. 提案 ---
    console.log("\n[6] 手順の提案");
    await ask("PROPOSE ROI を保存したい");
    const prop = lastBot().getByTestId("assistant-proposal");
    check((await prop.count()) === 1 && ((await prop.textContent()) ?? "").includes("ROI ツールを選ぶ"), "手順カードが出る");
    check((await prop.locator("li").count()) === 3, "手順が 3 項目");
    await win.screenshot({ path: path.join(OUT_DIR, "3-proposal.png") });

    // --- 8. forbidden ---
    console.log("\n[8] 他の窓からの呼び出し");
    for (const [label, page] of [["メイン窓", main], ["2D 窓", viewer]] as const) {
      const r = await page.evaluate(() => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<{ error?: string }> } }).graphyDesktop.assistantViewerCmd("x", { kind: "action", id: "flipH" }));
      check(r.error === "forbidden", `🔴 ${label}からの assistantViewerCmd は forbidden`, r);
    }
    const wl4 = await readWl(viewer);
    check(!!wl0 && !!wl4 && near(wl4.center, wl0.center), "forbidden の呼び出しで画面は動いていない");

    // --- 9. 履歴 ---
    console.log("\n[9] 操作履歴");
    check(fs.existsSync(journalFile), "assistant-journal.jsonl ができる");
    const lines = fs.existsSync(journalFile) ? fs.readFileSync(journalFile, "utf8").trim().split("\n").filter(Boolean) : [];
    const entries = lines.map((l) => JSON.parse(l) as { id?: string; ok?: boolean; params?: Record<string, unknown>; error?: string });
    check(entries.some((e) => e.id === "setWindowLevel" && e.ok === true && e.params?.center === 123), "setWindowLevel（成功）が残る");
    check(entries.some((e) => e.id === "goToSlice" && e.ok === true), "goToSlice が残る");
    check(!entries.some((e) => e.params && (e.params.width as number) === -5), "🔴 範囲外の操作は 2D 窓へ送られず履歴にも無い");
    check(!/\b\d+(\.\d+){5,}\b/.test(lines.join("\n")) && !/patient/i.test(lines.join("\n")), "🔴 履歴に UID・患者情報が無い");

    // --- 7. 2D 窓を閉じる ---
    console.log("\n[7] 2D 窓が無い");
    await viewer.close();
    await sleep(800);
    await ask("FLIP 反転して");
    const nv = lastBot().getByTestId("assistant-action-flipH");
    check((await nv.getAttribute("data-status")) === "failed" && ((await nv.textContent()) ?? "").includes("no-viewer"), "🔴 カードに no-viewer が出る", await nv.textContent());
    await win.screenshot({ path: path.join(OUT_DIR, "4-no-viewer.png") });
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

/*
 * アシスタントの承認つきデータ変更（PR2: 計測線の全消去 clearMeasurements）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantWriteCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓 ＋ loopback の偽 OpenAI 互換サーバー。
 * main の確認ダイアログ（dialog.showMessageBox）はスタブして、呼ばれた回数と文面・応答を制御する。
 * 確かめること:
 *   1. 前提: 計測線を実際に描いて、cornerstone の注釈が 1 件以上ある
 *   2. 🔴 ロボット計画に write が入ると警告が出る。「取り消す」を選ぶと計測線は残り、止まった理由は declined
 *   3. 🔴 「実行する」を選ぶと計測線が 0 件になる。ダイアログの文面は main が持つもの
 *   4. 🔴 負例: チャットモードでモデルが直接呼んでも、ダイアログも実行も起きない
 *   5. 🔴 負例: レンダラが approved:true を付けて送っても、確認ダイアログは省略されない（拒否で残る）
 *   6. 負例: メイン窓からの中継は forbidden
 * 未達として残すもの: ROI/マスクの消去・保存・患者切替（今回の対象外）／実モデルが write を適切に使うか。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-write-check");
const PORTS = { http: 19370, scp: 19371, vite: 19373 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Msg { role: string; content?: unknown; tool_call_id?: string }
const seen: { messages: Msg[]; tools: string[] }[] = [];

const SCRIPT: Record<string, { name: string; args: unknown }> = {
  PLANDEL: { name: "plan_actions", args: { title: "計測を消す", steps: [{ id: "clearMeasurements" }] } },
  DIRECTDEL: { name: "clearMeasurements", args: {} },
};

function startFake(port: number) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: { messages?: Msg[]; stream?: boolean; tools?: { function?: { name?: string } }[] } = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* */ }
      const messages = body.messages ?? [];
      seen.push({ messages, tools: (body.tools ?? []).map((t) => t.function?.name ?? "") });
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

/** 「新しい版があります」ダイアログは通信状況で出て、クリックを遮る。DOM で「後で」を押して閉じる。 */
async function dismissUpdate(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`(function(){ var b=[].slice.call(document.querySelectorAll("button")).find(function(x){return /^(後で|Later)$/.test((x.textContent||"").trim());}); if(b) b.click(); })()`).catch(() => undefined);
    await sleep(500);
  }
}

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
    await dismissUpdate(main);
    await openFirstSeriesInViewer(main, createStepRecorder());
    await dismissUpdate(main);
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
    // main の確認ダイアログをスタブ: 呼ばれた回数・文面・応答（0=実行する / 1=取り消す）を制御する。
    await driver.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg: { n: number; response: number; last: unknown } };
      g.__dlg = { n: 0, response: 1, last: null };
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (_w: unknown, o: unknown) => {
        g.__dlg.n++;
        g.__dlg.last = o;
        return { response: g.__dlg.response, checkboxChecked: false };
      };
    });
    const dlg = () => driver.app.evaluate(() => (globalThis as unknown as { __dlg: { n: number; last: { message?: string; detail?: string } | null } }).__dlg);
    const setResponse = (r: number) => driver.app.evaluate((_a, v) => { (globalThis as unknown as { __dlg: { response: number } }).__dlg.response = v; }, r);

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
    const cmd = (c: unknown) => win.evaluate((x) => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<{ ok: boolean; error?: string }> } }).graphyDesktop.assistantViewerCmd("spike", x), c);
    const annCount = () => viewer.evaluate(`(function(){ return window.__graphyDebug.getAnnotationCanvasPoints().length; })()`) as Promise<number>;
    const drawLength = async () => {
      await cmd({ kind: "action", id: "setTool", params: { tool: "length" } });
      const box = await viewer.getByTestId("series-viewer-root").first().boundingBox();
      if (!box) throw new Error("viewer box");
      await viewer.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
      await viewer.mouse.down();
      await viewer.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
      await viewer.mouse.up();
      await viewer.waitForTimeout(500);
      await cmd({ kind: "action", id: "setTool", params: { tool: "windowLevel" } });
    };

    // --- 1. 前提 ---
    console.log("\n[1] 計測線を描く");
    await drawLength();
    const n0 = await annCount();
    check(n0 >= 1, "前提: 計測線を描けた（cornerstone の注釈が 1 件以上）", n0);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-measured.png") });

    // --- 2. 拒否 ---
    console.log("\n[2] ロボット計画 → 取り消す");
    await win.getByTestId("assistant-robot-toggle").click();
    await ask("PLANDEL 計測を消して");
    await win.getByTestId("assistant-robot-step").first().waitFor({ state: "visible", timeout: 10_000 });
    check((await win.getByTestId("assistant-robot-write-mark").count()) === 1, "write のステップに「元に戻せない・確認が出る」の警告が付く");
    await win.screenshot({ path: path.join(OUT_DIR, "2-plan-write.png") });
    await setResponse(1);
    const d0 = (await dlg()).n;
    await win.getByTestId("assistant-robot-run").click();
    await win.getByTestId("assistant-robot-msg").waitFor({ state: "visible", timeout: 15_000 });
    const msg2 = (await win.getByTestId("assistant-robot-msg").textContent()) ?? "";
    check((await dlg()).n === d0 + 1, "🔴 実行で確認ダイアログが 1 回出た", await dlg());
    check(/declined/.test(msg2), "🔴 取り消すと declined で止まる", msg2);
    check((await annCount()) === n0, "🔴 取り消すと計測線は残る", { before: n0, after: await annCount() });

    // --- 3. 承認 ---
    console.log("\n[3] 計画 → 実行する");
    await win.getByTestId("assistant-robot-close").click();
    await ask("PLANDEL もう一度");
    await win.getByTestId("assistant-robot-step").first().waitFor({ state: "visible", timeout: 10_000 });
    await setResponse(0);
    const d1 = (await dlg()).n;
    await win.getByTestId("assistant-robot-run").click();
    await win.getByTestId("assistant-robot-msg").waitFor({ state: "visible", timeout: 15_000 });
    await viewer.waitForTimeout(600);
    const dd = await dlg();
    check(dd.n === d1 + 1, "実行で確認ダイアログが 1 回出た", dd.n);
    check(/計測線/.test(dd.last?.message ?? "") && /元に戻せません/.test(dd.last?.detail ?? ""), "ダイアログの文面は main が持つもの（計測線・元に戻せません）", dd.last);
    check((await annCount()) === 0, "🔴 承認すると計測線が 0 件になる", await annCount());
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-cleared.png") });
    await win.screenshot({ path: path.join(OUT_DIR, "3-after-run.png") });
    await win.getByTestId("assistant-robot-close").click();

    // --- 4. 負例: チャットモードの直呼び ---
    console.log("\n[4] 負例: チャットで直呼び");
    await win.getByTestId("assistant-robot-toggle").click(); // チャットへ戻す
    await drawLength();
    const n1 = await annCount();
    check(n1 >= 1, "前提: 計測線を描き直した", n1);
    const d2 = (await dlg()).n;
    await ask("DIRECTDEL 消して");
    await viewer.waitForTimeout(500);
    check((await dlg()).n === d2, "🔴 モデルの直呼びではダイアログも出ない（実行経路に入らない）");
    check((await annCount()) === n1, "🔴 モデルの直呼びでは計測線は消えない", { before: n1, after: await annCount() });

    // --- 5. 負例: approved を偽る ---
    console.log("\n[5] 負例: approved を偽る");
    await setResponse(1);
    const d3 = (await dlg()).n;
    const forged = await cmd({ kind: "action", id: "clearMeasurements", params: {}, approved: true });
    check((await dlg()).n === d3 + 1, "🔴 approved:true を付けても確認ダイアログは出る", await dlg());
    check(forged.ok === false && forged.error === "declined", "🔴 拒否されれば declined", forged);
    check((await annCount()) === n1, "🔴 計測線は残る", await annCount());

    // --- 6. 他の窓 ---
    console.log("\n[6] 他の窓から");
    const r6 = await main.evaluate(() => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<{ ok: boolean; error?: string }> } }).graphyDesktop.assistantViewerCmd("x", { kind: "action", id: "clearMeasurements", params: {} }));
    check(r6.ok === false && r6.error === "forbidden", "🔴 メイン窓からの中継は forbidden", r6);
    check((await dlg()).n === d3 + 1, "forbidden ではダイアログも出ない");
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

/*
 * アシスタントのロボットモード（PR1）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantRobotCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓 ＋ loopback の偽 OpenAI 互換サーバー。
 * 確かめること:
 *   1. 🔴 モデルが計画を出しても、承認（実行ボタン）まで 2D 窓の W/L は変わらない。モデルへ渡す tools は getState/plan_actions だけ
 *   2. チェックを外したステップは実行されない（実行すると cornerstone の W/L が計画どおりに変わる）
 *   3. 全部元に戻すで W/L が戻る
 *   4. 🔴 負例: ロボットモードでモデルが操作を直接呼んでも実行されない／不正な計画（未知 id）は計画として出ない
 *   5. 操作履歴パネルに実行した操作が出る。🔴 他の窓（メイン・2D）からの journal 読み出しは forbidden
 * 未達として残すもの: 実行中の中止ボタン（単体試験のみ・実機は未確認）／実モデルが妥当な計画を作るか。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-robot-check");
const PORTS = { http: 19360, scp: 19361, vite: 19363 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Msg { role: string; content?: unknown; tool_call_id?: string }
const seen: { messages: Msg[]; tools: string[] }[] = [];

const SCRIPT: Record<string, { name: string; args: unknown }> = {
  PLAN: { name: "plan_actions", args: { title: "肺条件にする", steps: [{ id: "setWindowLevel", params: { center: 123, width: 456 } }, { id: "setWindowLevel", params: { center: 300, width: 600 } }] } },
  BAD: { name: "plan_actions", args: { title: "危険", steps: [{ id: "deleteStudy" }] } },
  DIRECT: { name: "setWindowLevel", args: { center: 77, width: 88 } },
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

    // --- 1. 計画は出るが承認まで動かない ---
    console.log("\n[1] 計画の提示");
    await win.getByTestId("assistant-robot-toggle").click();
    check((await win.getByTestId("assistant-robot-empty").count()) === 1, "ロボットモードに入ると案内が出る（計画なし）");
    const req0 = seen.length;
    await ask("PLAN 肺条件にして");
    await win.getByTestId("assistant-robot-step").first().waitFor({ state: "visible", timeout: 10_000 });
    await viewer.waitForTimeout(500);
    check((await win.getByTestId("assistant-robot-step").count()) === 2, "計画が 2 ステップで出る");
    const wlP = await readWl(viewer);
    check(!!wl0 && !!wlP && near(wlP.center, wl0.center) && near(wlP.width, wl0.width), "🔴 承認前は 2D 窓の W/L が変わらない", { before: wl0, after: wlP });
    const first = seen[req0];
    check(first.tools.slice().sort().join() === "getState,plan_actions", "🔴 モデルへ渡した tools は getState/plan_actions だけ", first.tools);
    await win.screenshot({ path: path.join(OUT_DIR, "1-plan.png") });

    // --- 2. 絞り込んで実行 ---
    console.log("\n[2] 絞り込んで実行");
    await win.getByTestId("assistant-robot-pick").nth(1).uncheck();
    const reqBefore = seen.length;
    await win.getByTestId("assistant-robot-run").click();
    await win.getByTestId("assistant-robot-msg").waitFor({ state: "visible", timeout: 15_000 });
    await viewer.waitForTimeout(600);
    const wlR = await readWl(viewer);
    check(!!wlR && near(wlR.center, 123) && near(wlR.width, 456), "🔴 実行で W/L が 123/456 になり、外した 2 ステップ目(300/600)は実行されない", wlR);
    check(seen.length === reqBefore, "実行でモデルへ要求を送っていない");
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-viewer-after-run.png") });
    await win.screenshot({ path: path.join(OUT_DIR, "3-after-run.png") });

    // --- 3. 取り消し ---
    console.log("\n[3] 全部元に戻す");
    await win.getByTestId("assistant-robot-undo").click();
    await viewer.waitForTimeout(700);
    const wlU = await readWl(viewer);
    check(!!wl0 && !!wlU && near(wlU.center, wl0.center) && near(wlU.width, wl0.width), "🔴 取り消しで元の W/L に戻る", { initial: wl0, after: wlU });

    // --- 4. 負例 ---
    console.log("\n[4] 負例");
    await win.getByTestId("assistant-robot-close").click();
    await ask("DIRECT 直接やって");
    await viewer.waitForTimeout(500);
    const wlD = await readWl(viewer);
    check(!!wlD && !near(wlD.center, 77) && !!wl0 && near(wlD.center, wl0.center), "🔴 ロボットモードでモデルが操作を直接呼んでも実行されない", wlD);
    check((await win.getByTestId("assistant-robot-step").count()) === 0, "直接呼びでは計画も出ない");
    await ask("BAD 危険な計画");
    await viewer.waitForTimeout(400);
    check((await win.getByTestId("assistant-robot-step").count()) === 0, "🔴 不正な計画（未知の操作）は計画として出ない");
    await win.screenshot({ path: path.join(OUT_DIR, "4-negatives.png") });

    // --- 5. 履歴 ---
    console.log("\n[5] 操作履歴");
    await win.getByTestId("assistant-robot-history-btn").click();
    await win.getByTestId("assistant-robot-history-item").first().waitFor({ state: "visible", timeout: 10_000 });
    const items = await win.getByTestId("assistant-robot-history-item").allTextContents();
    check(items.length >= 2 && items.every((x) => x.includes("✓")), "実行した操作（W/L と取り消しの W/L）が履歴に出る", items);
    await win.screenshot({ path: path.join(OUT_DIR, "5-history.png") });
    for (const [label, page] of [["メイン窓", main], ["2D 窓", viewer]] as const) {
      const r = await page.evaluate(() => (window as unknown as { graphyDesktop: { assistantJournalList: () => Promise<{ ok: boolean; error?: string }> } }).graphyDesktop.assistantJournalList());
      check(r.ok === false && r.error === "forbidden", `🔴 ${label}からの履歴読み出しは forbidden`, r);
    }
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

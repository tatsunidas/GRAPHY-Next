/*
 * ロボットモードの計画にプラグインのツール（display / write）を載せる機能の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantRobotPluginCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓 ＋ 検証用プラグイン（ai-tools-demo）＋ loopback の偽 OpenAI 互換サーバー。
 * 確かめること:
 *   1. 🔴 モデルへ渡す plan_actions の step id に、有効な display/write のツールだけが載る（read・オフは載らない）
 *   2. 🔴 計画が出ても承認までプラグインの関数は呼ばれず、確認ダイアログも出ない。write の step に印、マクロ保存は無効
 *   3. 🔴 実行: display は動き、write の確認を拒否するとそこで止まり write の関数は呼ばれない
 *   4. 承認すると write も動き（別の読み取りでタグを確認）、元に戻すは「戻せない」と伝える
 *   5. 🔴 負例: read のツールを含む計画・ロボットでの plugin__ 直呼びは動かない。オフにすると計画に載らない
 * 未達として残すもの: 実 OS の確認ダイアログの見た目／マクロへの保存（対象外）／実モデルが妥当な計画を作るか。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Page } from "playwright";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-robot-plugin-check");
const PORTS = { http: 19430, scp: 19431, vite: 19433 };
const PLUGIN_ID = "ai-tools-demo";
const P = `plugin__${PLUGIN_ID}__`;
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Msg { role: string; content?: unknown; tool_call_id?: string }
interface ToolDef { function?: { name?: string; parameters?: unknown } }
const seen: { messages: Msg[]; tools: ToolDef[] }[] = [];

// 偽モデルのキーは互いの部分文字列にしない。
const SCRIPT: Record<string, { name: string; args: unknown }> = {
  PLANBOTH: { name: "plan_actions", args: { title: "表示して書く", steps: [{ id: `${P}mark_display`, params: { n: 2 } }, { id: `${P}tag_roi`, params: { tag: "R1" } }] } },
  PLANREAD: { name: "plan_actions", args: { title: "読む", steps: [{ id: "flipH" }, { id: `${P}echo_size`, params: { n: 1 } }] } },
  CALLDIRECT: { name: `${P}mark_display`, args: { n: 3 } },
};

function startFake(port: number) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: { messages?: Msg[]; stream?: boolean; tools?: ToolDef[] } = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* */ }
      const messages = body.messages ?? [];
      seen.push({ messages, tools: body.tools ?? [] });
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

function installPlugin(): void {
  const src = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) fs.copyFileSync(path.join(src, name), path.join(dst, name));
}

async function dismissUpdate(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`(function(){ var b=[].slice.call(document.querySelectorAll("button")).find(function(x){return /^(後で|Later)$/.test((x.textContent||"").trim());}); if(b) b.click(); })()`).catch(() => undefined);
    await sleep(500);
  }
}

type DemoState = { calls: { tool: string; args: unknown }[] } | undefined;

/** モデルに渡した plan_actions の step id enum。 */
function planEnum(req: { tools: ToolDef[] }): string[] {
  const t = req.tools.find((x) => x.function?.name === "plan_actions");
  const e = (t?.function?.parameters as { properties?: { steps?: { items?: { properties?: { id?: { enum?: string[] } } } } } } | undefined)?.properties?.steps?.items?.properties?.id?.enum;
  return e ?? [];
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fakePort = await freePort();
  const fake = startFake(fakePort);
  installPlugin();
  const driver = new DesktopDriver(PORTS);
  let dataDir = "";
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
    clean();
    const toggleFile = path.join(info.userData, "assistant-plugin-tools.json");
    for (const f of [toggleFile]) if (fs.existsSync(f)) fs.rmSync(f);
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
    const demo = () => viewer.evaluate(() => (window as unknown as { __aiToolsDemo?: DemoState }).__aiToolsDemo) as Promise<DemoState>;
    const callsOf = async (tool: string) => ((await demo())?.calls ?? []).filter((c) => c.tool === tool).length;
    const annCount = () => viewer.evaluate(`(function(){ return window.__graphyDebug.getAnnotationCanvasPoints().length; })()`) as Promise<number>;

    const local = { id: "local", label: "ローカル LLM", kind: "openai", endpoint: `http://127.0.0.1:${fakePort}`, auth: "none", models: { "text-to-text": "tiny" } };
    const set = await main.evaluate(
      (cfg) => (window as unknown as { graphyDesktop: { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean }> } }).graphyDesktop.aiProvidersSet(cfg),
      { providers: [local], defaults: { "text-to-text": "local" } },
    );
    check(set.ok === true, "ローカル提供元（native tools）を保存できる", set);
    await driver.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg: { n: number; orig: unknown; response: number; last: unknown } };
      g.__dlg = { n: 0, orig: dialog.showMessageBox, response: 1, last: null };
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (_w: unknown, o: unknown) => {
        g.__dlg.n++;
        g.__dlg.last = o;
        return { response: g.__dlg.response, checkboxChecked: false };
      };
    });
    const dlgCount = () => driver.app.evaluate(() => (globalThis as unknown as { __dlg: { n: number } }).__dlg.n);
    const setResponse = (r: number) => driver.app.evaluate((_a, v) => { (globalThis as unknown as { __dlg: { response: number } }).__dlg.response = v; }, r);

    // 前提: write の対象になる ROI を 1 件描く
    check((await annCount()) === 0, "前提: ROI が 0 件から始まる");
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.getByRole("button", { name: /^(楕円 ROI|Ellipse ROI)$/ }).first().click();
    await viewer.waitForTimeout(250);
    const box = await viewer.getByTestId("series-viewer-root").first().boundingBox();
    if (!box) throw new Error("viewer box");
    await viewer.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
    await viewer.mouse.down();
    await viewer.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 10 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(1500);
    check((await annCount()) === 1, "前提: 楕円 ROI が 1 件描けた", await annCount());

    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.setViewportSize({ width: 560, height: 800 });
    await win.getByTestId("assistant-input").waitFor({ state: "visible" });
    await sleep(800);
    const ask = async (q: string) => {
      await win.getByTestId("assistant-input").fill(q);
      await win.getByTestId("assistant-send").click();
      await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 30_000 });
      await sleep(400);
    };
    const cmd = (c: unknown) => win.evaluate((x) => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<{ ok: boolean; error?: string; data?: { tag?: string | null } }> } }).graphyDesktop.assistantViewerCmd("spike", x), c);
    const readTag = async () => {
      const r = await cmd({ kind: "pluginTool", name: `${P}read_tag`, params: {} });
      return r.ok ? (r.data?.tag ?? null) : "<read-failed>";
    };

    // --- 0. オフのとき ---
    console.log("\n[0] プラグインのツールがオフのとき");
    await win.getByTestId("assistant-robot-toggle").click();
    const s0 = seen.length;
    await ask("PLANBOTH 表示して書く");
    check(planEnum(seen[s0]).length > 0 && !planEnum(seen[s0]).some((n) => n.startsWith("plugin__")), "🔴 オフのとき plan_actions の step id にプラグインのツールは載らない", planEnum(seen[s0]).filter((n) => n.startsWith("plugin__")));
    check((await win.getByTestId("assistant-robot-step").count()) === 0 && (await callsOf("mark_display")) === 0, "🔴 オフのまま plugin step を含む計画は出ず、関数も呼ばれない");

    // --- 1. オンにして計画 ---
    console.log("\n[1] オンにして計画を出す");
    await win.getByTestId("assistant-plugintools-toggle").click();
    await win.getByTestId("assistant-plugintools-panel").waitFor({ state: "visible", timeout: 10_000 });
    await win.getByTestId("assistant-plugintools-toggle-ai-tools-demo").click();
    await sleep(1200);
    check(await win.getByTestId("assistant-plugintools-toggle-ai-tools-demo").isChecked(), "前提: ツールがオンになった");
    await win.getByTestId("assistant-plugintools-toggle").click();
    const dl0 = await dlgCount();
    const s1 = seen.length;
    await ask("PLANBOTH 表示して書く");
    await win.getByTestId("assistant-robot-step").first().waitFor({ state: "visible", timeout: 10_000 });
    const en = planEnum(seen[s1]);
    check(en.includes(`${P}mark_display`) && en.includes(`${P}tag_roi`), "オンにすると display と write のツールが step id に載る", en.filter((n) => n.startsWith("plugin__")));
    check(!en.includes(`${P}echo_size`) && !en.includes(`${P}read_tag`) && !en.includes(`${P}boom`), "🔴 read のツールは step id に載らない", en.filter((n) => n.startsWith("plugin__")));
    check((await win.getByTestId("assistant-robot-step").count()) === 2, "計画が 2 ステップで出る");
    check((await callsOf("mark_display")) === 0 && (await callsOf("tag_roi")) === 0, "🔴 承認前はプラグインの関数が呼ばれない");
    check((await dlgCount()) === dl0, "🔴 計画の提示だけでは確認ダイアログは出ない");
    check((await win.getByTestId("assistant-robot-write-mark").count()) === 1, "write の step にだけ印が出る");
    check(await win.getByTestId("assistant-robot-save").isDisabled(), "🔴 plugin step を含む計画は「マクロとして保存」が無効");
    const labels = await win.getByTestId("assistant-robot-step").allTextContents();
    check(/AI Tools Demo/.test(labels.join(" ")) && /mark_display/.test(labels[0]) && /tag_roi/.test(labels[1]), "step の表示にプラグイン名とツール名が出る", labels);
    await win.screenshot({ path: path.join(OUT_DIR, "1-plan.png") });

    // --- 2. 実行: write を拒否 ---
    console.log("\n[2] 実行（write の確認を拒否）");
    await setResponse(1);
    await win.getByTestId("assistant-robot-run").click();
    await win.getByTestId("assistant-robot-msg").waitFor({ state: "visible", timeout: 15_000 });
    await sleep(500);
    const msg2 = (await win.getByTestId("assistant-robot-msg").textContent()) ?? "";
    check((await callsOf("mark_display")) === 1, "display の step は実行された（関数が 1 回呼ばれた）", await demo());
    check((await dlgCount()) === dl0 + 1, "🔴 write の step で確認が 1 回出る（display では出ない）", await dlgCount());
    check((await callsOf("tag_roi")) === 0 && (await readTag()) === null, "🔴 拒否したら write の関数は呼ばれず、タグも変わらない（前提: 読み取りは効く）");
    check(/2/.test(msg2) && /declined/.test(msg2), "2 番目で止まり declined が表示される", msg2);
    await win.screenshot({ path: path.join(OUT_DIR, "2-declined.png") });
    await win.getByTestId("assistant-robot-close").click();

    // --- 3. 実行: 承認 ---
    console.log("\n[3] 実行（承認）と元に戻す");
    await ask("PLANBOTH 表示して書く");
    await win.getByTestId("assistant-robot-step").first().waitFor({ state: "visible", timeout: 10_000 });
    await setResponse(0);
    const dl3 = await dlgCount();
    await win.getByTestId("assistant-robot-run").click();
    await win.getByTestId("assistant-robot-undo").waitFor({ state: "visible", timeout: 15_000 });
    await sleep(500);
    check((await dlgCount()) === dl3 + 1, "承認の実行でも write の確認が 1 回出る");
    check((await callsOf("tag_roi")) === 1 && (await callsOf("mark_display")) === 2, "承認すると write も実行された", await demo());
    check((await readTag()) === "R1", "🔴 タグが書き込まれている（別の読み取りで確認）");
    await win.getByTestId("assistant-robot-undo").click();
    await sleep(600);
    const msg3 = (await win.getByTestId("assistant-robot-msg").textContent()) ?? "";
    check(/元に戻せません|cannot be undone/.test(msg3) && /2/.test(msg3), "元に戻すは「戻せない操作」の数を伝える", msg3);
    check((await readTag()) === "R1", "対照: 元に戻すでもタグは消えない（戻せないと伝えた通り）");
    await win.screenshot({ path: path.join(OUT_DIR, "3-approved.png") });
    await win.getByTestId("assistant-robot-close").click();

    // --- 4. 負例 ---
    console.log("\n[4] 負例");
    const c4 = (await demo())?.calls?.length ?? 0;
    await ask("PLANREAD 読む計画");
    check((await win.getByTestId("assistant-robot-step").count()) === 0, "🔴 read のツールを含む計画は計画として出ない");
    await ask("CALLDIRECT 直接");
    check((await win.getByTestId("assistant-robot-step").count()) === 0 && ((await demo())?.calls?.length ?? 0) === c4, "🔴 ロボットモードでの plugin__ 直呼びは動かず、計画も出ない");
    // オフに戻す
    await win.getByTestId("assistant-plugintools-toggle").click();
    await win.getByTestId("assistant-plugintools-toggle-ai-tools-demo").click();
    await sleep(1200);
    await win.getByTestId("assistant-plugintools-toggle").click();
    const s4 = seen.length;
    await ask("PLANBOTH 表示して書く");
    check(!planEnum(seen[s4]).some((n) => n.startsWith("plugin__")) && (await win.getByTestId("assistant-robot-step").count()) === 0, "🔴 オフに戻すと step id に載らず、計画も出ない");
    check((await callsOf("tag_roi")) === 1 && (await annCount()) === 1, "ROI の件数・write の呼び出し回数は変わらない（対象は実在する）");
  } finally {
    await driver.app
      .evaluate(({ dialog }) => {
        const g = globalThis as unknown as { __dlg?: { orig: unknown } };
        if (g.__dlg) (dialog as unknown as { showMessageBox: unknown }).showMessageBox = g.__dlg.orig;
      })
      .catch(() => undefined);
    await driver.stop();
    fake.close();
    clean();
    fs.rmSync(path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID), { recursive: true, force: true });
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

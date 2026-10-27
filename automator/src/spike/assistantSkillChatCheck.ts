/*
 * スキルとチャットの接続（開始の提案・下書き・マクロからの変換）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantSkillChatCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓 ＋ loopback の**規則ベースの偽モデル**（合言葉でツール呼び出しを返す）。
 * 確かめること:
 *   1. モデルへ渡る要求に SKILLS の節と start_skill / propose_skill のツール定義が入る
 *   2. 🔴 「巡回」の提案 → パネルが自動で開き、提案の枠（手順つき）が出る。**［開始］を押すまで W/L は変わらない** → 押すと実行
 *   3. 入力つきの提案（preset=bone）→ 入力欄に bone が入っている
 *   4. 🔴 負例: 未知の id・範囲外の入力の提案 → 枠が出ない（モデルには理由が返る）
 *   5. 下書き（propose_skill）→ 枠が出る → ［保存］で一覧とファイルに入る。🔴 保存するまでファイルに入らない
 *   6. 🔴 負例: 未知の操作を含む下書き → 枠が出ず、保存されない
 *   7. マクロ →［スキルにする］→ 一覧に出て実行でき、マクロも残る
 * 未達として残すもの: 実モデルが適切なスキルを選ぶ精度（偽モデルは配線だけを確かめる）／実 OS。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-skill-chat-check");
const PORTS = { http: 19510, scp: 19511, vite: 19513 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Wl = { center: number; width: number } | null;
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;
const same = (a: Wl, b: Wl) => !!a && !!b && near(a.center, b.center) && near(a.width, b.width);
const lt = (s: string) => ({ ja: s, en: s });

interface Msg { role: string; content?: unknown }
const seen: { messages: Msg[]; tools: string[] }[] = [];
/** 合言葉 → 呼ぶツール。 */
const SCRIPT: Record<string, { name: string; args: unknown }> = {
  "SUGGEST-TOUR": { name: "start_skill", args: { id: "ct-window-tour" } },
  "SUGGEST-BONE": { name: "start_skill", args: { id: "slice-review", inputs: { preset: "bone" } } },
  "SUGGEST-NOPE": { name: "start_skill", args: { id: "nope" } },
  "SUGGEST-RANGE": { name: "start_skill", args: { id: "slice-review", inputs: { preset: "evil" } } },
  "DRAFT-OK": { name: "propose_skill", args: { skill: { schemaVersion: 1, id: "chat-made", title: lt("チャットで作った"), description: lt("反転して左右反転"), inputs: [], steps: [{ kind: "tool", id: "invert", params: {} }, { kind: "confirm", message: lt("反転しました。続けますか？") }, { kind: "tool", id: "flipH", params: {} }] } } },
  "DRAFT-BAD": { name: "propose_skill", args: { skill: { schemaVersion: 1, id: "chat-evil", title: lt("evil"), description: lt("evil"), inputs: [], steps: [{ kind: "tool", id: "flipH", params: {} }, { kind: "tool", id: "wipeDisk", params: {} }] } } },
};

function startFake(port: number) {
  const toolResults: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: { messages?: Msg[]; stream?: boolean; tools?: { function?: { name?: string } }[] } = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* */ }
      const messages = body.messages ?? [];
      seen.push({ messages, tools: (body.tools ?? []).map((t) => t.function?.name ?? "") });
      const last = messages[messages.length - 1];
      if (last?.role === "tool") toolResults.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
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
        res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${key}`, function: { name: c.name, arguments: argStr.slice(0, 5) } }] } }] }));
        res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(5) } }] }, finish_reason: "tool_calls" }] }));
      } else {
        res.write(sse({ choices: [{ delta: { content: "提案しました。［スキル］で確認してください。" }, finish_reason: "stop" }] }));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  server.listen(port, "127.0.0.1");
  return { server, toolResults };
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  s.on("error", reject);
});

async function readWl(viewer: Page): Promise<Wl> {
  return viewer.evaluate(`(function(){ var p = window.__graphyDebug.getViewportProperties()[0]; return p && p.windowLevel ? { center: p.windowLevel.center, width: p.windowLevel.width } : null; })()`) as Promise<Wl>;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fakePort = await freePort();
  const fake = startFake(fakePort);
  const driver = new DesktopDriver(PORTS);
  try {
    await driver.start();
    const info = await driver.app.evaluate(({ dialog, app }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return { cwd: process.cwd(), userData: app.getPath("userData") };
    });
    for (const f of ["ai-providers.json", "secrets.enc.json"]) fs.rmSync(path.join(info.cwd, f), { force: true });
    const skillFile = path.join(info.userData, "assistant-skills.json");
    const macroFile = path.join(info.userData, "assistant-macros.json");
    for (const f of [skillFile, macroFile]) fs.rmSync(f, { force: true });
    const main: Page = driver.page;
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await openFirstSeriesInViewer(main, createStepRecorder());
    const viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2500);

    const local = { id: "local", label: "ローカル LLM", kind: "openai", endpoint: `http://127.0.0.1:${fakePort}`, auth: "none", models: { "text-to-text": "tiny" } };
    const set = await main.evaluate((cfg) => (window as unknown as { graphyDesktop: { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean }> } }).graphyDesktop.aiProvidersSet(cfg), { providers: [local], defaults: { "text-to-text": "local" } });
    check(set.ok === true, "前提: 偽モデルの提供元を保存できた", set);

    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.setViewportSize({ width: 600, height: 860 });
    await win.getByTestId("assistant-input").waitFor({ state: "visible" });
    await sleep(800);
    const direct = async (id: string, params: Record<string, unknown> = {}) => {
      await win.evaluate(([i, p]) => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<unknown> } }).graphyDesktop.assistantViewerCmd("spike", { kind: "action", id: i, params: p }), [id, params] as [string, Record<string, unknown>]);
      await viewer.waitForTimeout(500);
    };
    const ask = async (q: string) => {
      await win.getByTestId("assistant-input").fill(q);
      await win.getByTestId("assistant-send").click();
      await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 30_000 });
      await sleep(400);
    };
    const ref: Record<string, Wl> = {};
    for (const p of ["lung", "bone"]) { await direct("applyWlPreset", { name: p }); ref[p] = await readWl(viewer); }
    await direct("setWindowLevel", { center: 40, width: 400 });
    const base = await readWl(viewer);

    // --- 1. 要求の中身 ---
    console.log("\n[1] 要求の中身");
    await ask("こんにちは");
    const first = seen[seen.length - 1];
    const sys = JSON.stringify(first.messages.find((m) => m.role === "system")?.content ?? "");
    check(sys.includes("SKILLS:") && sys.includes("ct-window-tour") && sys.includes("slice-review"), "システムプロンプトに SKILLS の節と同梱スキルの id が入る");
    check(first.tools.includes("start_skill") && first.tools.includes("propose_skill"), "ツール定義に start_skill / propose_skill が入る", first.tools);

    // --- 2. 提案 → 押すまで動かない ---
    console.log("\n[2] 開始の提案");
    check((await win.getByTestId("assistant-skill-panel").count()) === 0, "前提: 提案の前はパネルが閉じている");
    await ask("SUGGEST-TOUR 巡回して");
    await win.getByTestId("assistant-skill-form").waitFor({ state: "visible", timeout: 10_000 });
    check(await win.getByTestId("assistant-skill-suggested").isVisible(), "🔴 パネルが自動で開き、『アシスタントの提案』の枠が出る");
    check((await win.getByTestId("assistant-skill-form-steps").locator("li").count()) === 5, "提案の枠に手順が 5 件出る");
    await viewer.waitForTimeout(800);
    check(same(await readWl(viewer), base), "🔴 ［開始］を押すまで W/L は変わらない（40/400 のまま）", await readWl(viewer));
    await win.screenshot({ path: path.join(OUT_DIR, "2-suggest.png") });
    await win.getByTestId("assistant-skill-start").click();
    await win.getByTestId("assistant-skill-confirm").waitFor({ state: "visible", timeout: 15_000 });
    await viewer.waitForTimeout(400);
    check(same(await readWl(viewer), ref.lung), "🔴 ［開始］で実行が始まり、肺の値になる", await readWl(viewer));
    await win.getByTestId("assistant-skill-confirm-no").click();
    await win.getByTestId("assistant-skill-undo").click();
    await viewer.waitForTimeout(600);
    check(same(await readWl(viewer), base), "元に戻して 40/400", await readWl(viewer));

    // --- 3. 入力つき ---
    console.log("\n[3] 入力つきの提案");
    await ask("SUGGEST-BONE 骨の条件でスライスを見たい");
    await win.getByTestId("assistant-skill-field-preset").waitFor({ state: "visible", timeout: 10_000 });
    check((await win.getByTestId("assistant-skill-field-preset").inputValue()) === "bone", "🔴 入力欄にモデルの値（bone）が入っている");
    await viewer.waitForTimeout(500);
    check(same(await readWl(viewer), base), "押すまで W/L は変わらない");
    await win.getByTestId("assistant-skill-form-cancel").click();

    // --- 4. 負例の提案 ---
    console.log("\n[4] 負例: 不正な提案");
    for (const key of ["SUGGEST-NOPE", "SUGGEST-RANGE"]) {
      await ask(`${key} お願い`);
      check((await win.getByTestId("assistant-skill-form").count()) === 0, `🔴 ${key}: 提案の枠が出ない`);
    }
    check(fake.toolResults.some((r) => r.includes("unknown-skill")) && fake.toolResults.some((r) => r.includes("bad-input:preset")), "モデルには理由（unknown-skill / bad-input:preset）が返る", fake.toolResults.slice(-3));

    // --- 5. 下書き ---
    console.log("\n[5] 下書き");
    await ask("DRAFT-OK 手順を保存して");
    await win.getByTestId("assistant-skill-draft").waitFor({ state: "visible", timeout: 10_000 });
    check(((await win.getByTestId("assistant-skill-draft-name").textContent()) ?? "") === "チャットで作った", "下書きの枠が出る");
    check(!fs.existsSync(skillFile) || !fs.readFileSync(skillFile, "utf8").includes("chat-made"), "🔴 ［保存］するまでファイルに入らない");
    await win.screenshot({ path: path.join(OUT_DIR, "5-draft.png") });
    await win.getByTestId("assistant-skill-draft-save").click();
    await win.locator('[data-testid="assistant-skill-item"][data-skill-id="chat-made"]').waitFor({ state: "visible", timeout: 10_000 });
    check(JSON.parse(fs.readFileSync(skillFile, "utf8")).skills.some((s: { id: string }) => s.id === "chat-made"), "保存すると一覧とファイルに入る");

    // --- 6. 負例の下書き ---
    console.log("\n[6] 負例: 不正な下書き");
    const before = fs.readFileSync(skillFile, "utf8");
    await ask("DRAFT-BAD 保存して");
    check((await win.getByTestId("assistant-skill-draft").count()) === 0, "🔴 未知の操作を含む下書きは枠が出ない");
    check(fs.readFileSync(skillFile, "utf8") === before, "ファイルは変わらない");
    check(fake.toolResults.some((r) => r.includes("step-2:unknown-action")), "モデルには理由が返る");

    // --- 7. マクロ → スキル ---
    console.log("\n[7] マクロ → スキル");
    const saved = await win.evaluate((m) => (window as unknown as { graphyDesktop: { assistantMacrosSave: (m: unknown) => Promise<{ ok: boolean }> } }).graphyDesktop.assistantMacrosSave(m), { name: "反転マクロ", steps: [{ id: "invert", params: {} }] });
    check(saved.ok === true, "前提: マクロを保存した");
    await win.getByTestId("assistant-macro-toggle").click();
    await win.getByTestId("assistant-macro-item").first().waitFor({ state: "visible", timeout: 10_000 });
    await win.getByTestId("assistant-macro-to-skill").first().click();
    await win.getByTestId("assistant-macro-msg").waitFor({ state: "visible", timeout: 10_000 });
    check(JSON.parse(fs.readFileSync(skillFile, "utf8")).skills.some((s: { id: string; title: { ja: string } }) => s.id.startsWith("macro-") && s.title.ja === "反転マクロ"), "スキルとして保存された");
    check(JSON.parse(fs.readFileSync(macroFile, "utf8")).macros.length === 1, "🔴 マクロは残っている");
    await win.getByTestId("assistant-macro-toggle").click();
    const item = win.locator('[data-testid="assistant-skill-item"]').filter({ hasText: "反転マクロ" });
    await item.waitFor({ state: "visible", timeout: 10_000 });
    await item.getByTestId("assistant-skill-run").click();
    await win.getByTestId("assistant-skill-msg").filter({ hasText: /最後まで|Ran to the end/ }).waitFor({ state: "visible", timeout: 15_000 });
    await viewer.waitForTimeout(500);
    const inv = await viewer.evaluate(`(function(){ var p = window.__graphyDebug.getViewportProperties()[0]; return p && p.invert; })()`);
    check(inv === true, "🔴 変換したスキルを実行すると白黒反転が実際に掛かる", { inv });
    await win.screenshot({ path: path.join(OUT_DIR, "7-converted.png") });
  } finally {
    fake.server.close();
    await driver.stop();
  }
  const failed = summary();
  console.log("  [未達] 実モデルが適切なスキルを選ぶ精度／実 OS");
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed, unreached: 2 }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

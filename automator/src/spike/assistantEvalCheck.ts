/*
 * 回帰評価（固定質問セット）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantEvalCheck.ts
 *
 * 本物の Electron ＋ backend ＋ loopback の**規則ベースの偽モデル**（質問文から決まったツール呼び出しを返す。応答に版名を付ける）。
 * 実在のアシスタント窓の［記録］＞［評価を実行］で確かめる:
 *   1. 実行 → 16/16 一致。結果が userData/ai-eval.jsonl に保存され、画面に版つきで出る
 *   2. 偽モデルの版を変え、2 問（10 枚目の index、左右反転に余計な操作）だけ挙動を変えて再実行 → 14/16。
 *      差分が「その 2 問と版の変化」を指す（期待値は偽モデルの表から別に決めてある）
 *   3. 🔴 ツールは実行されない（操作の履歴＝ジャーナルが増えない）。評価の要求は通常の記録に残る（セッション ID が eval-）
 *   4. 🔴 メイン窓からの eval の保存・一覧は forbidden で、ファイルに触れない
 * 偽モデルが確かめるのは「流す・採点する・保存する・比べる・表示する」。実クラウドモデルの一致率は確かめない（未達）。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-eval-check");
const PORTS = { http: 19490, scp: 19491, vite: 19493 };
const { check, summary } = createChecker();

type Call = { name: string; args: Record<string, unknown> };
/** 偽モデルの表（質問文 → 呼ぶツール）。cases.ts とは独立に書いてある（食い違えばこの検査が落ちる）。 */
const TABLE: Record<string, Call[]> = {
  "ウィンドウを中心 50、幅 350 にして": [{ name: "setWindowLevel", args: { center: 50, width: 350 } }],
  "肺の条件で見せて": [{ name: "applyWlPreset", args: { name: "lung" } }],
  "画像を時計回りに 90 度回して": [{ name: "rotate90", args: {} }],
  "画像を左右反転して": [{ name: "flipH", args: {} }],
  "画像を上下反転して": [{ name: "flipV", args: {} }],
  "白黒を反転して": [{ name: "invert", args: {} }],
  "10 枚目のスライスを見せて": [{ name: "goToSlice", args: { index: 9 } }],
  "最初のスライスに戻って": [{ name: "goToSlice", args: { index: 0 } }],
  "画面を 2 列にして": [{ name: "setLayout", args: { cols: 2 } }],
  "長さを測るツールにして": [{ name: "setTool", args: { tool: "length" } }],
  "ウィンドウを初期値に戻して": [{ name: "resetWindow", args: {} }],
  "時計回りに 90 度回してから左右反転して": [{ name: "rotate90", args: {} }, { name: "flipH", args: {} }],
  "ROI の平均値を教えて": [{ name: "getMeasurements", args: {} }],
  "肝臓のあたりに楕円の ROI を描いて": [{ name: "propose_steps", args: { title: "ROI を描く", steps: ["ROI メニューを開く", "楕円を選ぶ"] } }],
};
/** 「モデルが更新された」想定で、版 v2 だけ挙動が変わる 2 問。 */
const V2: Record<string, Call[]> = {
  "10 枚目のスライスを見せて": [{ name: "goToSlice", args: { index: 10 } }],
  "画像を左右反転して": [{ name: "flipH", args: {} }, { name: "invert", args: {} }],
};
const CHANGED = ["flip-h", "slice-10th"]; // 上の 2 問の id（期待値）

function startFake(port: number): { server: http.Server; mode: { version: "fake-v1" | "fake-v2" } } {
  const mode = { version: "fake-v1" as "fake-v1" | "fake-v2" };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: { messages?: { role: string; content?: unknown }[] } = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* 無視 */ }
      const msgs = body.messages ?? [];
      const user = msgs.find((m) => m.role === "user");
      const q = typeof user?.content === "string" ? user.content : "";
      const toolRounds = msgs.filter((m) => m.role === "tool").length;
      const calls = (mode.version === "fake-v2" ? V2[q] : undefined) ?? TABLE[q];
      res.setHeader("Content-Type", "application/json");
      if (toolRounds === 0 && calls) {
        const tool_calls = [{ name: "getState", args: {} }, ...calls].map((c, i) => ({ id: `c${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
        res.end(JSON.stringify({ model: mode.version, choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls } }] }));
        return;
      }
      res.end(JSON.stringify({ model: mode.version, choices: [{ finish_reason: "stop", message: { content: "了解しました" } }] }));
    });
  });
  server.listen(port, "127.0.0.1");
  return { server, mode };
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  s.on("error", reject);
});

type Bridge = {
  aiProvidersSet: (cfg: unknown) => Promise<{ ok: boolean; problems: string[] }>;
  assistantEvalAppend: (r: unknown) => Promise<{ ok: boolean; error?: string }>;
  assistantEvalList: () => Promise<{ ok: boolean; error?: string }>;
};

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fakePort = await freePort();
  const fake = startFake(fakePort);
  const driver = new DesktopDriver(PORTS);
  try {
    await driver.start();
    const info = await driver.app.evaluate(({ app, dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return { dataDir: process.cwd(), userData: app.getPath("userData") };
    });
    for (const f of ["ai-providers.json", "secrets.enc.json"]) fs.rmSync(path.join(info.dataDir, f), { force: true });
    const evalFile = path.join(info.userData, "ai-eval.jsonl");
    const reqFile = path.join(info.userData, "ai-requests.jsonl");
    const journalFile = path.join(info.userData, "assistant-journal.jsonl");
    for (const f of [evalFile, `${evalFile}.1`, reqFile, `${reqFile}.1`]) fs.rmSync(f, { force: true });
    await driver.page.reload({ waitUntil: "domcontentloaded" });
    const page = driver.page;
    const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
    const journalBefore = lines(journalFile).length;

    const local = { id: "local", label: "ローカル LLM", kind: "openai", endpoint: `http://127.0.0.1:${fakePort}`, auth: "none", models: { "text-to-text": "tiny" } };
    const set = await page.evaluate((cfg) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiProvidersSet(cfg), { providers: [local], defaults: { "text-to-text": "local" } });
    check(set.ok === true, "前提: 偽モデルの提供元を保存できた", set);
    check(lines(evalFile).length === 0, "前提: 評価の保存は空から始まる");

    const win = await driver.waitForNewPage(async () => {
      await page.getByTestId("mainscreen-menu-system").click();
      await page.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.setViewportSize({ width: 680, height: 900 });
    await win.getByTestId("assistant-requestlog-toggle").click();
    await win.getByTestId("assistant-eval").waitFor({ state: "visible", timeout: 10_000 });
    check(await win.getByTestId("assistant-eval-none").isVisible(), "前提: 最初は『まだ評価していません』");

    // --- 1. 初回: 16/16 ---
    console.log("\n[1] 初回（偽モデル v1）");
    await win.getByTestId("assistant-eval-run").click();
    await win.getByTestId("assistant-eval-score").waitFor({ state: "visible", timeout: 60_000 });
    const s1 = (await win.getByTestId("assistant-eval-score").textContent()) ?? "";
    check(/16\s*\/\s*16/.test(s1) && s1.includes("fake-v1"), "🔴 16/16 一致で、モデルの版 fake-v1 が出る", s1);
    const saved1 = lines(evalFile).map((l) => JSON.parse(l));
    check(saved1.length === 1 && saved1[0].passed === 16 && saved1[0].total === 16 && saved1[0].modelVersion === "fake-v1", "結果が 1 行保存される（件数は main が数えた値）", saved1[0] && { p: saved1[0].passed, t: saved1[0].total, v: saved1[0].modelVersion });
    check(!JSON.stringify(saved1).includes("ウィンドウ") && !JSON.stringify(saved1).includes("ROI"), "🔴 保存に質問の本文が 0 件");
    await win.screenshot({ path: path.join(OUT_DIR, "eval-1.png") });

    // --- 2. 版が変わって 2 問だけずれる ---
    console.log("\n[2] モデルが更新された想定（偽モデル v2）");
    fake.mode.version = "fake-v2";
    await win.getByTestId("assistant-eval-run").click();
    await win.waitForFunction(() => /14\s*\/\s*16/.test(document.querySelector('[data-testid="assistant-eval-score"]')?.textContent ?? ""), null, { timeout: 60_000 });
    const s2 = (await win.getByTestId("assistant-eval-score").textContent()) ?? "";
    check(/14\s*\/\s*16/.test(s2) && s2.includes("fake-v2"), "🔴 14/16 に下がり、版 fake-v2 が出る", s2);
    const reg = (await win.getByTestId("assistant-eval-regressed").textContent()) ?? "";
    check(CHANGED.every((id) => reg.includes(id)) && (reg.match(/[a-z0-9]+(-[a-z0-9]+)*/g) ?? []).filter((x) => /-/.test(x) || CHANGED.includes(x)).length >= 2, "🔴 差分が、変えた 2 問（flip-h・slice-10th）を指す", reg);
    check(!reg.includes("rotate") && !reg.includes("layout"), "他の質問は不一致に数えない", reg);
    const mc = (await win.getByTestId("assistant-eval-model-changed").textContent()) ?? "";
    check(mc.includes("fake-v1") && mc.includes("fake-v2"), "モデルの版の変化（v1 → v2）が出る", mc);
    const failedRows = await win.getByTestId("assistant-eval-failed-row").allTextContents();
    check(failedRows.length === 2 && failedRows.some((r) => r.includes("slice-10th") && /index/.test(r)) && failedRows.some((r) => r.includes("flip-h") && /unexpected|expected/.test(r)), "不一致の質問と理由（index が 10・余計な操作）が出る", failedRows);
    const saved2 = lines(evalFile).map((l) => JSON.parse(l));
    check(saved2.length === 2 && saved2[1].passed === 14, "2 回目の結果も保存される", saved2.map((r) => r.passed));
    await win.screenshot({ path: path.join(OUT_DIR, "eval-2.png") });

    // --- 3. ツールは実行されない ---
    console.log("\n[3] ツールは実行されない・要求は記録に残る");
    check(lines(journalFile).length === journalBefore, "🔴 操作の履歴（ジャーナル）が増えない＝2D 窓へ何も送っていない", { before: journalBefore, after: lines(journalFile).length });
    // 対照: 同じ窓から実際の操作を中継すれば、ジャーナルは増える（上の「増えない」が、記録が効いていての結果であること）
    await win.evaluate(() => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<unknown> } }).graphyDesktop.assistantViewerCmd("ctl", { kind: "action", id: "flipH", params: {} }));
    check(lines(journalFile).length === journalBefore + 1, "対照: 実際の操作を中継するとジャーナルは 1 件増える（記録は効いている）", lines(journalFile).length);
    const reqRows = lines(reqFile).map((l) => JSON.parse(l));
    check(reqRows.length >= 32 && reqRows.filter((r) => String(r.sessionId).startsWith("eval-")).length === reqRows.length, "評価の要求は通常の記録に残る（セッション ID が eval-）", reqRows.length);

    // --- 4. メイン窓から ---
    console.log("\n[4] メイン窓からは forbidden");
    const before = lines(evalFile).length;
    const fa = await page.evaluate(() => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.assistantEvalAppend({ suiteVersion: 1, meta: {}, cases: [{ id: "x", pass: true }] }));
    const fl = await page.evaluate(() => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.assistantEvalList());
    check(fa.ok === false && fa.error === "forbidden" && fl.ok === false && fl.error === "forbidden", "🔴 メイン窓の eval 保存・一覧は forbidden", [fa, fl]);
    check(lines(evalFile).length === before, "ファイルに触れない");
  } finally {
    fake.server.close();
    await driver.stop();
  }
  const failed = summary();
  console.log("  [未達] 実クラウドモデルでの一致率／実際にモデルが更新されたときの検出／外部宛ての確認の分岐（単体のみ）／質問セットの妥当性");
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed, unreached: 4 }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

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
 *   5. 応答時間: 偽モデルに既知の遅延（要求ごとに 120〜320 ms。v2 は +600 ms）を入れ、評価の質問ごとの値・合計・
 *      記録パネルの中央値/p95 が、記録ファイルの生の値から別に手計算した値と一致する（v2 は中央値が上がる＝負例）。
 *      n<20 の行（記録に直接足した 5 件）は「参考値」と出る
 *   6. 第 2 組（プラグイン・位置・曖昧な依頼）を k=5 で流す: 送信は 10 問×5 回=50 件（セッション ID 50 個）。偽モデルは mk-center の
 *      3 回目だけ別のマスに置く（決定的）ので、mk-center は 4/5（予測値）で不合格、他は 5/5。画面の合格率と 95% 区間は、
 *      保存された passes/n から別に手計算（Wilson）した値と一致する。保存行に suite と passes/n が入り、第 1 組とは比較されない
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
  // 第 2 組（cases.ts とは独立に書く）。位置は 3×3 のマスの中心付近
  "画像の中心にマーカーを置いて": [{ name: "plugin__eval-synth__place_marker", args: { u: 0.5, v: 0.5 } }],
  "画像の右上にマーカーを置いて": [{ name: "plugin__eval-synth__place_marker", args: { u: 0.85, v: 0.15 } }],
  "左下のあたりにマーカーを置いて": [{ name: "plugin__eval-synth__place_marker", args: { u: 0.15, v: 0.85 } }],
  "画像の上の真ん中にマーカーを置いて": [{ name: "plugin__eval-synth__place_marker", args: { u: 0.5, v: 0.15 } }],
  "ROI の SD をプラグインで出して": [{ name: "plugin__eval-synth__roi_stat", args: { metric: "sd" } }],
  "ROI の面積をプラグインで出して": [{ name: "plugin__eval-synth__roi_stat", args: { metric: "area" } }],
};
/** 「モデルが更新された」想定で、版 v2 だけ挙動が変わる 2 問。 */
const V2: Record<string, Call[]> = {
  "10 枚目のスライスを見せて": [{ name: "goToSlice", args: { index: 10 } }],
  "画像を左右反転して": [{ name: "flipH", args: {} }, { name: "invert", args: {} }],
};
const CHANGED = ["flip-h", "slice-10th"]; // 上の 2 問の id（期待値）

/** 最近順位法（p = ⌈q·n⌉ 番目）。製品側の実装とは別に、ここで書く。 */
const nearestRank = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.max(1, Math.ceil(q * xs.length)) - 1];

/** 位置質問の「3 回目だけ別のマス」: 質問ごとの初回往復の通し番号（0 始まり）。 */
const WRONG_Q = "画像の中心にマーカーを置いて";
const WRONG_AT = 2;
const WRONG_CALL: Call[] = [{ name: "plugin__eval-synth__place_marker", args: { u: 0.9, v: 0.9 } }];

function startFake(port: number): { server: http.Server; mode: { version: "fake-v1" | "fake-v2" } } {
  const mode = { version: "fake-v1" as "fake-v1" | "fake-v2" };
  let counter = 0;
  const firstRounds = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const delay = 120 + (counter++ % 5) * 50 + (mode.version === "fake-v2" ? 600 : 0);
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: { messages?: { role: string; content?: unknown }[] } = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* 無視 */ }
      const msgs = body.messages ?? [];
      const user = msgs.find((m) => m.role === "user");
      const q = typeof user?.content === "string" ? user.content : "";
      const toolRounds = msgs.filter((m) => m.role === "tool").length;
      let calls = (mode.version === "fake-v2" ? V2[q] : undefined) ?? TABLE[q];
      if (toolRounds === 0) {
        const seen = firstRounds.get(q) ?? 0;
        firstRounds.set(q, seen + 1);
        if (q === WRONG_Q && seen === WRONG_AT) calls = WRONG_CALL;
      }
      res.setHeader("Content-Type", "application/json");
      const send = (body: string) => setTimeout(() => res.end(body), delay);
      if (toolRounds === 0 && calls) {
        const tool_calls = [{ name: "getState", args: {} }, ...calls].map((c, i) => ({ id: `c${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
        send(JSON.stringify({ model: mode.version, choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls } }] }));
        return;
      }
      send(JSON.stringify({ model: mode.version, choices: [{ finish_reason: "stop", message: { content: "了解しました" } }] }));
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

    // --- 5. 応答時間 ---
    console.log("\n[5] 応答時間");
    for (const v of ["fake-v1", "fake-v2"]) {
      const lat = reqRows.filter((r) => r.modelVersion === v && r.outcome === "ok").map((r) => r.latencyMs as number);
      check(lat.length >= 20 && lat.every((x) => x >= (v === "fake-v2" ? 720 : 120)), `前提: ${v} の要求（20 件以上）の応答時間が、入れた遅延以上で記録されている`, lat.slice(0, 5));
    }
    const rawLat = (v: string) => reqRows.filter((r) => r.modelVersion === v && r.outcome === "ok").map((r) => r.latencyMs as number);
    const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    const expectText = (v: string) => `${secs(nearestRank(rawLat(v), 0.5))} / ${secs(nearestRank(rawLat(v), 0.95))}`;
    // 質問ごとの値: 1 問 = 2 往復なので、各 ≥ 2×最小遅延。保存された合計は質問ごとの値の和
    for (const [i, v] of [[0, "fake-v1"], [1, "fake-v2"]] as const) {
      const cs = saved2[i].cases as { latencyMs?: number }[];
      const min = v === "fake-v2" ? 720 : 120; // 1 問は 1〜2 往復
      check(cs.length === 16 && cs.every((c) => typeof c.latencyMs === "number" && c.latencyMs >= min), `${v}: 16 問すべてに質問ごとの応答時間があり、遅延 1 往復分以上`, cs.map((c) => c.latencyMs).slice(0, 4));
      check(saved2[i].totalLatencyMs === cs.reduce((a, c) => a + (c.latencyMs ?? 0), 0), `${v}: 保存された合計 = 質問ごとの和`, saved2[i].totalLatencyMs);
    }
    // 記録パネル（評価の途中で開いた状態なので読み直す）
    await win.getByTestId("assistant-requestlog-refresh").click();
    await win.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-requestlog-model-row"]').length >= 2, null, { timeout: 10_000 });
    const rowText = async (v: string) => {
      const rows = win.getByTestId("assistant-requestlog-model-row").filter({ hasText: v });
      return (await rows.first().getByTestId("assistant-requestlog-latency").textContent()) ?? "";
    };
    const t1 = await rowText("fake-v1");
    const t2 = await rowText("fake-v2");
    check(t1.includes(expectText("fake-v1")) && !/参考値|reference/.test(t1), "🔴 v1 の 中央値/p95 が、記録ファイルの生の値から手計算した値と一致（n≥20 なので参考値ではない）", { shown: t1, expected: expectText("fake-v1") });
    check(t2.includes(expectText("fake-v2")) && !/参考値|reference/.test(t2), "🔴 v2 も一致", { shown: t2, expected: expectText("fake-v2") });
    check(nearestRank(rawLat("fake-v2"), 0.5) - nearestRank(rawLat("fake-v1"), 0.5) >= 550 && t1 !== t2, "負例: 遅延を +600 ms にした v2 は中央値が上がり、表示も変わる", { v1: t1, v2: t2 });
    check(/2\s*問?.*[0-9.]+ s|[0-9.]+ s/.test((await win.getByTestId("assistant-eval-total-latency").textContent()) ?? ""), "評価の結果に合計応答時間が出る", await win.getByTestId("assistant-eval-total-latency").textContent());
    // n<20: 記録に直接 5 件足す（偽の小標本）
    fs.appendFileSync(reqFile, [100, 200, 300, 400, 500].map((ms) => JSON.stringify({ ts: new Date().toISOString(), provider: "local", modelId: "tiny", modelVersion: "seed-small", destination: "local", outcome: "ok", latencyMs: ms, usage: null, toolCalls: [], toolsOffered: 0, params: {}, attachments: { images: { count: 0, bytes: 0 } } })).join("\n") + "\n");
    fs.appendFileSync(reqFile, JSON.stringify({ ts: new Date().toISOString(), provider: "local", modelId: "tiny", modelVersion: "seed-none", destination: "local", outcome: "timeout", latencyMs: 9000, usage: null, toolCalls: [], toolsOffered: 0, params: {}, attachments: { images: { count: 0, bytes: 0 } } }) + "\n");
    await win.getByTestId("assistant-requestlog-refresh").click();
    await win.waitForFunction(() => /seed-small/.test(document.querySelector('[data-testid="assistant-requestlog-models"]')?.textContent ?? ""), null, { timeout: 10_000 });
    const ts = await rowText("seed-small");
    check(ts.includes("0.3 s / 0.5 s") && /参考値|reference/.test(ts) && ts.includes("n=5"), "🔴 5 件（100〜500 ms）は 中央値 0.3 s / p95 0.5 s で『参考値 n=5』", ts);
    const tn = await rowText("seed-none");
    check(/未取得|not available/.test(tn) && !tn.includes(" s"), "🔴 成功した要求が 0 件のモデルは 0 でなく『未取得』", tn);
    await win.getByTestId("assistant-requestlog-models").scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(OUT_DIR, "latency.png") });

    // --- 6. 第 2 組・k 回反復 ---
    console.log("\n[6] 第 2 組（プラグイン・位置・曖昧な依頼）を k=5 で");
    const reqBefore = lines(reqFile).length;
    await win.getByTestId("assistant-eval-suite").selectOption("plugin-pos");
    check((await win.getByTestId("assistant-eval-k").inputValue()) === "5", "組を切り替えると反復の既定が 5 になる");
    await win.getByTestId("assistant-eval-run").click();
    await win.waitForFunction(() => /9\s*\/\s*10/.test(document.querySelector('[data-testid="assistant-eval-score"]')?.textContent ?? ""), null, { timeout: 120_000 });
    const s6 = (await win.getByTestId("assistant-eval-score").textContent()) ?? "";
    check(/9\s*\/\s*10/.test(s6), "🔴 10 問中 9 問が全回合格（mk-center だけ不合格）", s6);
    const saved6 = lines(evalFile).map((l) => JSON.parse(l));
    const r6 = saved6[saved6.length - 1];
    check(saved6.length === 3 && r6.suite === "plugin-pos" && r6.suiteVersion === 1 && r6.total === 10, "保存行に組（plugin-pos）と版が入る", { n: saved6.length, suite: r6.suite });
    const c6 = r6.cases as { id: string; pass: boolean; passes: number; n: number }[];
    const center = c6.find((c) => c.id === "mk-center");
    check(center?.passes === 4 && center.n === 5 && center.pass === false, "🔴 mk-center は 4/5（偽モデルが 3 回目だけ別のマスに置く＝予測値）", center);
    check(c6.filter((c) => c.id !== "mk-center").every((c) => c.passes === 5 && c.n === 5 && c.pass), "🔴 他の 9 問は 5/5（曖昧な依頼＝何も実行しない、距離のあるプラグイン呼び出しも含む）", c6.filter((c) => c.passes !== 5));
    const newRows = lines(reqFile).slice(reqBefore).map((l) => JSON.parse(l));
    const sids = new Set(newRows.map((r) => String(r.sessionId)));
    check(sids.size === 50 && [...sids].every((x) => x.startsWith("eval-")), "🔴 送信は 問数 10 × 反復 5 = 50 件（別セッション ID 50 個）", sids.size);
    // 手計算: 49/50 の Wilson 95%（z=1.959964）
    const wil = (k: number, n: number) => {
      const z = 1.959964, p = k / n, d = 1 + (z * z) / n, c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
      return [Math.round(p * 100), Math.round(Math.max(0, c - h) * 100), Math.round(Math.min(1, c + h) * 100)];
    };
    const [pc, lo, hi] = wil(49, 50);
    const rateTxt = (await win.getByTestId("assistant-eval-rate").textContent()) ?? "";
    check(rateTxt.includes(`${pc}%`) && rateTxt.includes("49/50") && rateTxt.includes(`${lo}–${hi}%`) && !/参考値|reference/.test(rateTxt), `🔴 画面の合格率が 手計算の 49/50 = ${pc}%（95% 区間 ${lo}–${hi}%）と一致（n=50≥20 で参考値でない）`, rateTxt);
    const fr = await win.getByTestId("assistant-eval-failed-row").allTextContents();
    check(fr.length === 1 && fr[0].includes("mk-center") && fr[0].includes("4/5"), "不合格の質問と回数（4/5）が出る", fr);
    check((await win.getByTestId("assistant-eval-diff").count()) === 0, "🔴 第 1 組の記録とは比較されない（前回なし＝差分の欄なし）");
    check(lines(journalFile).length === journalBefore + 1, "🔴 第 2 組でもジャーナルは増えない（対照の 1 件のまま）", lines(journalFile).length);
    await win.screenshot({ path: path.join(OUT_DIR, "eval-suite2.png") });
    // 切り戻し: 第 1 組の表示は第 1 組の最新（14/16）
    await win.getByTestId("assistant-eval-suite").selectOption("basic");
    check(/14\s*\/\s*16/.test((await win.getByTestId("assistant-eval-score").textContent()) ?? ""), "第 1 組に戻すと第 1 組の最新（14/16）が出る");
    check((await win.getByTestId("assistant-eval-k").inputValue()) === "1", "第 1 組の反復の既定は 1");

    // --- 4. メイン窓から ---
    console.log("\n[4] メイン窓からは forbidden");
    const before = lines(evalFile).length;
    const fa = await page.evaluate(() => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.assistantEvalAppend({ suite: "basic", suiteVersion: 1, meta: {}, cases: [{ id: "x", pass: true }] }));
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

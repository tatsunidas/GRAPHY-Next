/*
 * クラウドの Gemini（gemini-2.5-flash と、移行先の gemini-3.5-flash-lite）に、アシスタントの回帰評価を同じ条件で走らせて比べる。
 * 思考の深さ（minimal/low/medium/high）の既定を、合格数・応答時間・トークン数で決めるための測定。
 *
 * 実行:  cd automator && GRAPHY_SPIKE_GEMINI_KEY=<API キー> MODEL_ID=gemini-3.5-flash-lite THINKING_LEVEL=medium \
 *          npx tsx src/spike/assistantEvalGeminiModel.ts
 *   任意: SUITES（既定 basic,basic-b,plugin-pos）、EVAL_K（既定 3。Gemini 3 系は temperature を無視するので揺れる）、
 *         RUN_TAG、GEMINI_ENDPOINT（既定は Google。試験用に loopback の偽サーバーを指せる）、
 *         FAKE_GEMINI=1（何でも「了解」と返す偽サーバーを自分で立てる。道具立ての確認用で、合否には意味が無い）
 *
 * 🔑 鍵は環境変数だけで受け、画面の鍵欄に入れて保存し、終わったら消す。コード・ログ・結果ファイルに出さない。
 * 外部送信になる: 評価の質問（合成の短文・患者情報なし）を Google へ送る。費用は 1 回で数十リクエスト・合計数十万トークン程度の見込み。
 * 合否は測った値を記録するだけで、閾値は置かない。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Page } from "playwright";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { clickDismissing, dismissUpdateDialog } from "./dismissUpdateDialog.js";

const KEY = process.env.GRAPHY_SPIKE_GEMINI_KEY ?? "";
const FAKE = process.env.FAKE_GEMINI === "1";
if (!KEY && !FAKE) throw new Error("環境変数 GRAPHY_SPIKE_GEMINI_KEY が要ります（偽サーバーの確認なら FAKE_GEMINI=1）");
const MODEL_ID = process.env.MODEL_ID ?? "gemini-3.5-flash-lite";
const LEVEL = process.env.THINKING_LEVEL ?? "";
const K = Number(process.env.EVAL_K ?? 3);
const SUITES = (process.env.SUITES ?? "basic,basic-b,plugin-pos").split(",").map((x) => x.trim()).filter(Boolean);
const TAG = process.env.RUN_TAG ?? "";
const PORTS = { http: 19570, scp: 19571, vite: 19573 };
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-eval-gemini");
const PID = "gemini-eval";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 最近順位法（p = ⌈q·n⌉ 番目）。 */
const nearestRank = (xs: number[], q: number): number | null => (xs.length ? [...xs].sort((a, b) => a - b)[Math.max(1, Math.ceil(q * xs.length)) - 1] : null);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

/** 道具立ての確認用。どの要求にも文章で「了解」と返す。 */
function startFake(port: number) {
  const server = http.createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      const payload = { candidates: [{ content: { role: "model", parts: [{ text: "了解" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 3 }, modelVersion: `${MODEL_ID}-fake` };
      if ((req.url ?? "").includes(":streamGenerateContent")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify(payload)}\n\n`);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      }
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let endpoint = process.env.GEMINI_ENDPOINT ?? "https://generativelanguage.googleapis.com";
  let fake: http.Server | null = null;
  if (FAKE) {
    const p = await freePort();
    fake = startFake(p);
    endpoint = `http://127.0.0.1:${p}`;
  }
  const driver = new DesktopDriver(PORTS);
  const result: Record<string, unknown> = { model: MODEL_ID, thinkingLevel: LEVEL || "(既定)", k: K, endpointHost: new URL(endpoint).host, fake: FAKE };
  let dataDir = "";
  const cleanFiles = () => { for (const f of ["ai-providers.json", "secrets.enc.json"]) if (dataDir) fs.rmSync(path.join(dataDir, f), { force: true }); };
  try {
    await driver.start();
    const info = await driver.app.evaluate(({ app, dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return { dataDir: process.cwd(), userData: app.getPath("userData") };
    });
    dataDir = info.dataDir;
    cleanFiles();
    const evalFile = path.join(info.userData, "ai-eval.jsonl");
    const reqFile = path.join(info.userData, "ai-requests.jsonl");
    for (const f of [evalFile, `${evalFile}.1`, reqFile, `${reqFile}.1`]) fs.rmSync(f, { force: true });
    await driver.page.reload({ waitUntil: "domcontentloaded" });
    const page: Page = driver.page;
    const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

    const provider = { id: PID, label: "Gemini（評価）", kind: "gemini", endpoint, models: { "text-to-text": MODEL_ID }, ...(LEVEL ? { thinkingLevel: LEVEL } : {}) };
    const set = await page.evaluate((cfg) => (window as unknown as { graphyDesktop: { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean; problems: string[] }> } }).graphyDesktop.aiProvidersSet(cfg), { providers: [provider], defaults: { "text-to-text": PID } });
    if (!set.ok) throw new Error(`提供元を保存できない: ${JSON.stringify(set)}`);

    // 鍵は画面の鍵欄から保存する（保存先は main の暗号化ストア）
    await dismissUpdateDialog(page, 3000);
    await clickDismissing(page, page.getByTestId("mainscreen-menu-system"));
    await clickDismissing(page, page.getByTestId("menu-item-settings"));
    await page.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("settings-cat-ai").click();
    await page.getByTestId("ai-panel").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId(`ai-key-input-${PID}`).fill(KEY || "dummy-key-for-fake");
    await page.getByTestId(`ai-key-save-${PID}`).click();
    await sleep(800);
    await page.getByTestId("dialog-close-button").click();

    const win = await driver.waitForNewPage(async () => {
      await dismissUpdateDialog(page, 1500);
      await clickDismissing(page, page.getByTestId("mainscreen-menu-system"));
      await clickDismissing(page, page.getByTestId("menu-item-assistant"));
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.setViewportSize({ width: 680, height: 900 });
    await win.getByTestId("assistant-requestlog-toggle").click();
    await win.getByTestId("assistant-eval").waitFor({ state: "visible", timeout: 10_000 });

    const suites: Record<string, unknown> = {};
    for (const suite of SUITES) {
      console.log(`\n[${suite}] k=${K}  model=${MODEL_ID} level=${LEVEL || "(既定)"}`);
      const before = lines(evalFile).length;
      const reqBefore = lines(reqFile).length;
      await win.getByTestId("assistant-eval-suite").selectOption(suite);
      await win.getByTestId("assistant-eval-k").fill(String(K));
      const t0 = Date.now();
      await win.getByTestId("assistant-eval-run").click();
      const deadline = Date.now() + 60 * 60_000;
      while (Date.now() < deadline) {
        if (lines(evalFile).length > before && !(await win.getByTestId("assistant-eval-progress").isVisible())) break;
        if (await win.getByTestId("assistant-eval-error").isVisible()) throw new Error(`評価が失敗: ${await win.getByTestId("assistant-eval-error").textContent()}`);
        await sleep(2000);
      }
      const row = lines(evalFile).at(-1);
      if (!row || lines(evalFile).length <= before) throw new Error(`${suite}: 結果が保存されなかった`);
      const reqs = lines(reqFile).slice(reqBefore) as { outcome?: string; latencyMs?: number; usage?: { in?: number; out?: number }; modelVersion?: string }[];
      const ok = reqs.filter((r) => r.outcome === "ok").map((r) => r.latencyMs as number);
      const cases = row.cases as { id: string; pass: boolean; passes: number; n: number; latencyMs?: number }[];
      suites[suite] = {
        suiteVersion: row.suiteVersion,
        questions: row.total,
        questionsAllPass: row.passed,
        passes: cases.reduce((a, c) => a + c.passes, 0),
        n: cases.reduce((a, c) => a + c.n, 0),
        wallSeconds: Math.round((Date.now() - t0) / 1000),
        requests: reqs.length,
        requestsNotOk: reqs.length - ok.length,
        outcomes: reqs.reduce<Record<string, number>>((m, r) => { const k = String(r.outcome); m[k] = (m[k] ?? 0) + 1; return m; }, {}),
        tokens: { in: reqs.reduce((a, r) => a + (r.usage?.in ?? 0), 0), out: reqs.reduce((a, r) => a + (r.usage?.out ?? 0), 0) },
        modelVersions: [...new Set(reqs.map((r) => r.modelVersion).filter(Boolean))],
        requestLatencyMs: { n: ok.length, p50: nearestRank(ok, 0.5), p95: nearestRank(ok, 0.95) },
        perQuestion: cases.map((c) => ({ id: c.id, passes: c.passes, n: c.n, meanMs: c.latencyMs ?? null })),
        failedRows: await win.getByTestId("assistant-eval-failed-row").allTextContents(),
      };
      await win.screenshot({ path: path.join(OUT_DIR, `${MODEL_ID}-${LEVEL || "default"}${TAG}-${suite}.png`) });
    }
    result.suites = suites;
    // 検査用の鍵を残さない
    await page.getByTestId("mainscreen-menu-system").click().catch(() => undefined);
  } finally {
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT_DIR, `${MODEL_ID}-${LEVEL || "default"}${TAG}.json`), JSON.stringify(result, null, 2));
    await driver.stop();
    cleanFiles(); // ai-providers.json と、鍵を入れた secrets.enc.json（使い捨ての設定ディレクトリ）
    if (fake) fake.close();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message.replace(KEY || "\u0000", "***") : e); process.exit(1); });

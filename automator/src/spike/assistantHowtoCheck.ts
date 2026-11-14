/*
 * アシスタントが「操作の手順」を、文書（docs/*.md）に基づいて正しく説明できるかを、本物の Electron のアシスタント窓で測る。
 *
 * 実行:
 *   ローカル: cd automator && PROVIDER=local LLAMA_SERVER=<llama-server> MODEL_GGUF=<.gguf> MODEL_ID=<manifest の id> npx tsx src/spike/assistantHowtoCheck.ts
 *   Gemini:   cd automator && PROVIDER=gemini GRAPHY_SPIKE_GEMINI_KEY_FILE=<鍵ファイル> [MODEL_ID=gemini-3.5-flash-lite] npx tsx src/spike/assistantHowtoCheck.ts
 *   PROFILE=guide: アプリと llama-server の間の書き換えプロキシで、道具を propose_steps だけに、system プロンプトを短い「案内役」に差し替える（資料 DOCUMENTS はそのまま）。製品は変えずに、役割分割の効き目だけを測る。既定 full は素通し。
 *   任意: SUITE（dev|b。b は保留セット）、REPEATS（既定 3）、RUN_TAG、ONLY（case id をカンマ区切り）、LLAMA_EXTRA、LOCAL_PORT（既定 19430）、CPU_THREADS
 *
 * 質問と判定は assistantHowtoJudge.ts。UI は日本語（localStorage graphy.locale=ja）。2D 窓は開かない（メイン画面から尋ねる状況）。
 * 鍵は実行時にファイルから読むだけ（表示・記録しない）。送るのは合成の質問だけ（患者名は架空）。
 * 合否は記録するだけで閾値は置かない。要求が失敗した質問は「未達」と数え、合格・失敗に混ぜない。
 */
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { clickDismissing, dismissUpdateDialog } from "./dismissUpdateDialog.js";
import { HOWTO_CASES, HOWTO_CASES_B, hasRawToolCall, judgeHowto } from "./assistantHowtoJudge.js";

const require = createRequire(import.meta.url);
const L = require("../../../desktop/localLlm.js") as {
  serverArgs: (o: Record<string, unknown>) => string[];
  defaultThreads: (n: number) => number;
  newMark: () => string;
};
const MANIFEST = JSON.parse(fs.readFileSync(path.join(AUTOMATOR_ROOT, "..", "desktop", "localAiManifest.json"), "utf8")) as { models: { id: string; toolMode?: string; reasoning?: string }[] };

const PROVIDER = process.env.PROVIDER ?? "local";
if (PROVIDER !== "local" && PROVIDER !== "gemini") throw new Error("PROVIDER は local か gemini");
const need = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`環境変数 ${k} が要ります`); return v; };
const K = Number(process.env.REPEATS ?? 3);
const TAG = process.env.RUN_TAG ?? "";
const PROFILE = process.env.PROFILE ?? "full";
if (PROFILE !== "full" && PROFILE !== "guide") throw new Error("PROFILE は full か guide");
const SUITE = process.env.SUITE ?? "dev";   // dev: 開発セット／b: 保留セット
const ONLY = (process.env.ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const LOCAL_PORT = Number(process.env.LOCAL_PORT ?? 19430);
const EXTRA = (process.env.LLAMA_EXTRA ?? "").split(/\s+/).filter(Boolean);
const PORTS = { http: 19540, scp: 19541, vite: 19543 };
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-howto");
const MODEL_ID = process.env.MODEL_ID ?? (PROVIDER === "gemini" ? "gemini-3.5-flash-lite" : need("MODEL_ID"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const GUIDE_PROMPT = [
  "You are the in-app help assistant of GRAPHY-Next, a DICOM viewer for medical imaging.",
  "Answer in 日本語, concisely. You cannot operate the application; explain how the user can do it.",
  "When the user asks how to do something that takes several steps, call propose_steps with the steps, using only the screen terms found in the DOCUMENTS below.",
  "Base answers on the DOCUMENTS below. If they do not cover the question, say that the documentation does not cover it rather than guessing menu names or features.",
  "This is not a diagnostic tool.",
].join("\n");

/** 1 回目の要求の大きさ（役割で本当に短くなったかの確認用）。 */
const reqStats: { sysChars: number; tools: number }[] = [];

function startRewriteProxy(upstream: number, port: number): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.method === "POST" && req.url?.includes("/v1/chat/completions")) {
        const j = JSON.parse(body.toString("utf8")) as { messages: { role: string; content: unknown }[]; tools?: { function?: { name?: string } }[] };
        if (PROFILE === "guide") {
          const keep = (j.tools ?? []).filter((t) => t.function?.name === "propose_steps");
          if (keep.length) j.tools = keep; else delete j.tools;
          const sys = j.messages[0];
          const text = typeof sys.content === "string" ? sys.content : (sys.content as { text?: string }[]).map((p) => p.text ?? "").join("");
          const i = text.indexOf("\n\nDOCUMENTS:");
          sys.content = GUIDE_PROMPT + (i >= 0 ? text.slice(i) : "");
          body = Buffer.from(JSON.stringify(j), "utf8");
        }
        const sys0 = j.messages[0]?.content;
        reqStats.push({ sysChars: typeof sys0 === "string" ? sys0.length : JSON.stringify(sys0).length, tools: j.tools?.length ?? 0 });
      }
      const headers = { ...req.headers, "content-length": String(body.length) };
      const up = http.request({ host: "127.0.0.1", port: upstream, path: req.url, method: req.method, headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
      up.on("error", () => { res.statusCode = 502; res.end(); });
      up.end(body);
    });
  });
  return new Promise((ok) => srv.listen(port, "127.0.0.1", () => ok(srv)));
}

const KEY = PROVIDER === "gemini" ? fs.readFileSync(need("GRAPHY_SPIKE_GEMINI_KEY_FILE"), "utf8").replace(/[\r\n]/g, "") : "";
const md = PROVIDER === "local" ? MANIFEST.models.find((m) => m.id === MODEL_ID) : undefined;
if (PROVIDER === "local" && !md) throw new Error(`マニフェストに ${MODEL_ID} が無い`);

async function waitHealth(port: number, ms: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* まだ */ } await sleep(1000); }
  throw new Error("llama-server が起動しない");
}

interface Row { sysChars: number; tools: number; id: string; rep: number; ask: string; verdict: "pass" | "fail" | "unreached"; reasons: string[]; rounds: number; stepsCard: boolean; rawCall: boolean; seconds: number; text: string }

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let server: ChildProcess | null = null;
  let proxy: http.Server | null = null;
  const out: Record<string, unknown> = { profile: PROFILE, suite: SUITE, provider: PROVIDER, model: MODEL_ID, k: K, extra: EXTRA, startedAt: new Date().toISOString() };
  if (PROVIDER === "local") {
    const threads = Number(process.env.CPU_THREADS ?? L.defaultThreads(require("node:os").availableParallelism()));
    const args = [...L.serverArgs({ modelPath: need("MODEL_GGUF"), port: LOCAL_PORT, mark: L.newMark(), jinja: md!.toolMode === "native", reasoning: md!.reasoning ?? null, threads }), ...EXTRA];
    const bin = need("LLAMA_SERVER");
    server = spawn(bin, args, { stdio: ["ignore", "ignore", "ignore"], cwd: path.dirname(bin), env: { ...process.env, LD_LIBRARY_PATH: path.dirname(bin) } });
    out.threads = threads;
    proxy = await startRewriteProxy(LOCAL_PORT, LOCAL_PORT + 1);
  }
  const driver = new DesktopDriver(PORTS);
  const rows: Row[] = [];
  let dataDir = "";
  try {
    if (server) await waitHealth(LOCAL_PORT, 10 * 60_000);
    await driver.start();
    const info = await driver.app.evaluate(({ app, dialog }) => { dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync; return { dataDir: process.cwd(), userData: app.getPath("userData") }; });
    dataDir = info.dataDir;
    for (const f of ["ai-providers.json", "secrets.enc.json"]) fs.rmSync(path.join(dataDir, f), { force: true });
    const reqFile = path.join(info.userData, "ai-requests.jsonl");
    for (const f of [reqFile, `${reqFile}.1`]) fs.rmSync(f, { force: true });
    const main = driver.page;
    await main.evaluate(() => localStorage.setItem("graphy.locale", "ja"));
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });

    const PID = PROVIDER === "gemini" ? "gemini-howto" : "local";
    const provider = PROVIDER === "gemini"
      ? { id: PID, label: "Gemini（測定）", kind: "gemini", endpoint: "https://generativelanguage.googleapis.com", models: { "text-to-text": MODEL_ID } }
      : { id: PID, label: "ローカル LLM", kind: "openai", endpoint: `http://127.0.0.1:${LOCAL_PORT + 1}`, auth: "none", toolMode: md!.toolMode === "native" ? "native" : "none", models: { "text-to-text": MODEL_ID } };
    const set = await main.evaluate((cfg) => (window as unknown as { graphyDesktop: { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean }> } }).graphyDesktop.aiProvidersSet(cfg), { providers: [provider], defaults: { "text-to-text": PID } });
    if (!set.ok) throw new Error(`提供元を保存できない: ${JSON.stringify(set)}`);
    if (PROVIDER === "gemini") {   // 鍵は画面の鍵欄から保存する（main の暗号化ストア）
      await dismissUpdateDialog(main, 3000);
      await clickDismissing(main, main.getByTestId("mainscreen-menu-system"));
      await clickDismissing(main, main.getByTestId("menu-item-settings"));
      await main.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
      await main.getByTestId("settings-cat-ai").click();
      await main.getByTestId("ai-panel").waitFor({ state: "visible", timeout: 10_000 });
      await main.getByTestId(`ai-key-input-${PID}`).fill(KEY);
      await main.getByTestId(`ai-key-save-${PID}`).click();
      await sleep(800);
      await main.getByTestId("dialog-close-button").click();
    }
    await dismissUpdateDialog(main, 1500);
    const win = await driver.waitForNewPage(async () => {
      await clickDismissing(main, main.getByTestId("mainscreen-menu-system"));
      await clickDismissing(main, main.getByTestId("menu-item-assistant"));
    }, (u) => u.includes("#assistant"));
    await win.setViewportSize({ width: 680, height: 900 });
    const reqLines = () => (fs.existsSync(reqFile) ? fs.readFileSync(reqFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { toolCalls?: string[]; outcome?: string }) : []);
    const fresh = async () => { await win.reload({ waitUntil: "domcontentloaded" }); await win.getByTestId("assistant-input").waitFor({ state: "visible", timeout: 20_000 }); await sleep(600); };

    const cases = (SUITE === "b" ? HOWTO_CASES_B : HOWTO_CASES).filter((c) => ONLY.length === 0 || ONLY.includes(c.id));
    for (let rep = 1; rep <= K; rep++) {
      for (const c of cases) {
        await fresh();   // 質問ごとに会話を切る
        const before = reqLines().length; const statsBefore = reqStats.length; const t0 = Date.now();
        await win.getByTestId("assistant-input").fill(c.ask);
        await win.getByTestId("assistant-send").click();
        await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 5 * 60_000 });
        await sleep(400);
        const reqs = reqLines().slice(before);
        const text = (await win.getByTestId("assistant-msg-bot").last().evaluate((e) => (e as HTMLElement).innerText).catch(() => "")).replace(/\s+/g, " ").trim();
        const stepsCard = reqs.some((r) => r.toolCalls?.includes("propose_steps"));
        const failedReq = reqs.length === 0 || reqs.some((r) => r.outcome !== "ok") || text.length === 0;
        const j = judgeHowto(c, text, stepsCard);
        const st = reqStats[statsBefore];
        const row: Row = { sysChars: st?.sysChars ?? 0, tools: st?.tools ?? 0, id: c.id, rep, ask: c.ask, verdict: failedReq ? "unreached" : j.verdict, reasons: failedReq ? [`要求が成功していない（${JSON.stringify(reqs.map((r) => r.outcome))}）`] : j.reasons, rounds: reqs.length, stepsCard, rawCall: hasRawToolCall(text), seconds: Math.round((Date.now() - t0) / 100) / 10, text: text.slice(0, 3000) };
        rows.push(row);
        console.log(`[${rep}] ${c.id}: ${row.verdict}${row.reasons.length ? " — " + row.reasons.join(" / ") : ""}（${row.seconds}s・system ${row.sysChars} 字・道具 ${row.tools}・往復 ${row.rounds}・手順カード ${stepsCard ? "有" : "無"}）`);
        if (rep === 1 && (c.id === "h-open-ct-today" || c.id === "a-report-print")) await win.screenshot({ path: path.join(OUT_DIR, `${PROVIDER}-${MODEL_ID}${TAG}-${c.id}.png`) });
      }
    }
    const n = (v: string) => rows.filter((r) => r.verdict === v).length;
    out.summary = { pass: n("pass"), fail: n("fail"), unreached: n("unreached"), total: rows.length };
    const byCase = new Map<string, { pass: number; runs: number }>();
    for (const r of rows) { const e = byCase.get(r.id) ?? { pass: 0, runs: 0 }; e.runs++; if (r.verdict === "pass") e.pass++; byCase.set(r.id, e); }
    out.perCase = [...byCase].map(([id, v]) => ({ id, ...v }));
    console.log(`\n合格 ${n("pass")} / 失敗 ${n("fail")} / 未達 ${n("unreached")}（全 ${rows.length} 回）`);
  } finally {
    await driver.page.screenshot({ path: path.join(OUT_DIR, `${PROVIDER}-${MODEL_ID}${TAG}-main-at-exit.png`) }).catch(() => undefined);
    out.rows = rows;
    out.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT_DIR, `${PROVIDER}-${MODEL_ID}${TAG}.json`), JSON.stringify(out, null, 2));
    for (const f of ["ai-providers.json", "secrets.enc.json"]) if (dataDir) fs.rmSync(path.join(dataDir, f), { force: true });   // 鍵を入れた使い捨ての設定は残さない
    proxy?.close();
    server?.kill("SIGTERM");
    await driver.stop();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message.split(KEY || "\u0000").join("***") : e); process.exit(1); });

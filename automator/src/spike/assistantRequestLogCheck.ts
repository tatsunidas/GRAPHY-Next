/*
 * AI への要求の記録（本文なし）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantRequestLogCheck.ts
 *
 * 本物の Electron ＋ backend ＋ loopback の偽 OpenAI 互換サーバー。アシスタント窓（#assistant）から会話して確かめる:
 *   1. 会話 1 回で userData/ai-requests.jsonl に 1 行。提供元・モデル・版・トークン数（偽サーバーの値と一致）・所要時間・結果が揃う
 *   2. 🔴 質問文に入れた目印（患者らしい文字列）は偽サーバーには届くが、記録のファイルには 0 件（先に届いていることを確かめる）
 *   3. usage を返さない（ストリーム）応答は usage が null（0 ではない）。ツール呼び出しは名前だけ
 *   4. 失敗（429、本文に目印）も 1 行で、結果はコード。本文は入らない
 *   5. summary / clear は #assistant 窓だけ。メイン窓からは forbidden で、ファイルに触れない
 * 偽サーバーが確かめるのは「取り出しと書き出し」。各社の実応答の usage 形式は確かめない（未達）。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-request-log-check");
const PORTS = { http: 19480, scp: 19481, vite: 19483 };
const { check, summary } = createChecker();
const MARK = "PATIENT-YAMADA-MRN-5551234";

type Mode = { status: number };
function startFake(port: number): { server: http.Server; seen: string[]; mode: Mode } {
  const seen: string[] = [];
  const mode: Mode = { status: 200 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push(raw);
      let body: { stream?: boolean } = {};
      try { body = JSON.parse(raw); } catch { /* 無視 */ }
      if (mode.status !== 200) {
        res.writeHead(mode.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `rate limit for ${MARK}` } }));
        return;
      }
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const ev = [
          { model: "fake-stream", choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "fit", arguments: '{"tile":1}' } }] }, finish_reason: "tool_calls" }] },
        ];
        for (const e of ev) res.write(`data: ${JSON.stringify(e)}\n\n`);
        res.write("data: [DONE]\n\n"); // usage を送らない提供元
        res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ model: "fake-2026-10-26", usage: { prompt_tokens: 77, completion_tokens: 11 }, choices: [{ finish_reason: "stop", message: { content: `返答 ${MARK}` } }] }));
    });
  });
  server.listen(port, "127.0.0.1");
  return { server, seen, mode };
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  s.on("error", reject);
});

type Row = Record<string, unknown> & { usage: { in: number | null; out: number | null } | null; toolCalls: string[] };
type Bridge = {
  aiProvidersGet: () => Promise<{ providers: unknown[]; defaults: Record<string, string> }>;
  aiProvidersSet: (cfg: unknown) => Promise<{ ok: boolean; problems: string[] }>;
  aiChat: (req: unknown) => Promise<Record<string, unknown>>;
  assistantRequestLogSummary: () => Promise<{ ok: boolean; error?: string; count?: number; byModel?: { model: string; requests: number; tokensIn: number; tokensOut: number; unknownUsage: number }[] }>;
  assistantRequestLogClear: () => Promise<{ ok: boolean; error?: string }>;
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
    for (const f of ["ai-providers.json", "secrets.enc.json"]) {
      const p = path.join(info.dataDir, f);
      if (fs.existsSync(p)) fs.rmSync(p);
    }
    const logFile = path.join(info.userData, "ai-requests.jsonl");
    for (const f of [logFile, `${logFile}.1`]) fs.rmSync(f, { force: true });
    await driver.page.reload({ waitUntil: "domcontentloaded" });
    const page = driver.page;
    const rows = (): Row[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

    // 前提: 偽サーバーの提供元（鍵なし・ループバック）を既定にする
    const local = { id: "local", label: "ローカル LLM", kind: "openai", endpoint: `http://127.0.0.1:${fakePort}`, auth: "none", models: { "text-to-text": "tiny" } };
    const set = await page.evaluate(
      (cfg) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiProvidersSet(cfg),
      { providers: [local], defaults: { "text-to-text": "local" } },
    );
    check(set.ok === true, "前提: 偽サーバーの提供元を保存できた", set);
    check(rows().length === 0, "前提: 記録は空から始まる");

    const origHash = await page.evaluate(() => window.location.hash);
    await page.evaluate(() => { window.location.hash = "#assistant"; });
    await page.waitForFunction(() => window.location.hash === "#assistant");

    // --- 1・2. 会話 → 1 行 ---
    console.log("\n[1] 会話 1 回 → 記録 1 行");
    const r1 = await page.evaluate(
      (req) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiChat(req),
      { sessionId: "s-log-1", temperature: 0.3, messages: [{ role: "user", text: `患者 ${MARK} の画像を見て` }] },
    );
    check(r1.ok === true, "会話が成功する", r1);
    const a = rows();
    check(a.length === 1, "記録が 1 行（実在する）", a.length);
    const row = a[0];
    check(row?.provider === "local" && row?.kind === "openai" && row?.modelId === "tiny" && row?.modelVersion === "fake-2026-10-26", "提供元・モデル・応答側の版が揃う", row);
    check(row?.usage?.in === 77 && row?.usage?.out === 11, "🔴 トークン数が偽サーバーの値と一致（77 / 11）", row?.usage);
    check(row?.destination === "local" && row?.outcome === "ok" && typeof row?.latencyMs === "number" && row.latencyMs >= 0, "宛先=local・結果=ok・所要時間が数値", row);
    check(row?.sessionId === "s-log-1" && (row?.params as { temperature?: number })?.temperature === 0.3, "セッション ID と temperature");
    console.log("\n[2] 本文は記録に入らない");
    check(fake.seen.some((s) => s.includes(MARK)), "前提: 目印は偽サーバーには届いている（検出できる状態）");
    const raw1 = fs.readFileSync(logFile, "utf8");
    check(!raw1.includes(MARK) && !raw1.includes("画像を見て") && !raw1.includes("返答"), "🔴 記録のファイルに質問・返答の本文が 0 件", raw1.length);

    // --- 3. usage なし・ツール呼び出し ---
    console.log("\n[3] usage を返さない応答・ツール呼び出し");
    const r2 = await page.evaluate(
      (req) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiChat(req),
      { sessionId: "s-log-2", stream: true, messages: [{ role: "user", text: "ツールを使って" }], tools: [{ name: "fit", description: "d", parameters: { type: "object", properties: {} } }, { name: "zoom", description: "d", parameters: { type: "object", properties: {} } }] },
    );
    check(r2.ok === true, "ストリームの会話が成功する", r2);
    const b = rows();
    check(b.length === 2, "記録が 2 行になった", b.length);
    check(b[1]?.usage === null, "🔴 usage を返さない応答は null（0 ではない）", b[1]?.usage);
    check(JSON.stringify(b[1]?.toolCalls) === '["fit"]' && b[1]?.toolsOffered === 2, "ツール呼び出しは名前だけ・提示したツール数 2", b[1]);

    // --- 4. 失敗 ---
    console.log("\n[4] 失敗（429・本文に目印）");
    fake.mode.status = 429;
    const r3 = await page.evaluate(
      (req) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiChat(req),
      { sessionId: "s-log-3", messages: [{ role: "user", text: "もう一度" }] },
    );
    fake.mode.status = 200;
    check(r3.ok === false, "失敗として返る", r3);
    const c = rows();
    check(c.length === 3 && /^[a-z0-9-]{1,40}$/.test(String(c[2]?.outcome)) && c[2]?.outcome !== "ok", "失敗も 1 行で、結果はコード", c[2]?.outcome);
    check(!fs.readFileSync(logFile, "utf8").includes(MARK), "🔴 エラー本文（目印入り）は記録に入らない");

    // --- 5. summary / clear と窓の制限 ---
    console.log("\n[5] summary / clear");
    const s = await page.evaluate(() => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.assistantRequestLogSummary());
    check(s.ok === true && s.count === 3, "summary の件数が記録と一致（3）", s);
    const m = s.byModel?.find((x) => x.model === "fake-2026-10-26");
    check(m?.requests === 1 && m?.tokensIn === 77 && m?.tokensOut === 11 && m?.unknownUsage === 0, "モデル別の合計がトークン数と一致", s.byModel);
    check((s.byModel ?? []).reduce((n, x) => n + x.unknownUsage, 0) === 2, "usage 不明の件数が数えられる（ストリームと失敗の 2 件）", s.byModel);
    await page.evaluate((h) => { window.location.hash = h; }, origHash);
    await page.waitForFunction((h) => window.location.hash === h, origHash);
    const fs1 = await page.evaluate(() => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.assistantRequestLogSummary());
    const fc1 = await page.evaluate(() => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.assistantRequestLogClear());
    check(fs1.ok === false && fs1.error === "forbidden" && fc1.ok === false && fc1.error === "forbidden", "🔴 メイン窓からの summary・clear は forbidden", [fs1, fc1]);
    check(rows().length === 3, "forbidden の clear では消えない");
    await page.evaluate(() => { window.location.hash = "#assistant"; });
    await page.waitForFunction(() => window.location.hash === "#assistant");
    const cl = await page.evaluate(() => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.assistantRequestLogClear());
    check(cl.ok === true && rows().length === 0, "#assistant 窓の clear で空になる", cl);
    const s2 = await page.evaluate(() => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.assistantRequestLogSummary());
    check(s2.ok === true && s2.count === 0, "clear 後の summary は 0 件", s2);
  } finally {
    fake.server.close();
    await driver.stop();
  }
  const failed = summary();
  console.log("  [未達] 実クラウド（Gemini / OpenAI）の実応答での usage 形式の一致／モデルが黙って更新されたときの検出（段 3・実運用）／画面（段 2）");
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed, unreached: 3 }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

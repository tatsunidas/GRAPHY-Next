/*
 * AI ゲートウェイの「会話」（text-to-text・鍵なしローカル・ストリーミング・窓の制限）の実機検証。
 * 設計: fw/ai-routing-design.md §15。
 *
 * 実行:  cd automator && npx tsx src/spike/aiChatGatewayCheck.ts
 *
 * 本物の Electron ＋ 本物の backend ＋ loopback の偽 OpenAI 互換サーバー（SSE 対応）で確かめる。
 * 何を確かめるか:
 *   1. 設定＞AI に text-to-text の行が出る（出荷時の Gemini）。鍵が無いと接続テストは押せない
 *   2. 鍵なし(auth:none)のローカル提供元を保存できる。画面は「鍵は不要」と言い、接続テストが押せる。
 *      送った本文に画像は付かず、Authorization も付かない
 *   3. 画面から編集して保存し直しても auth:none・toolMode・fallbacks が残る（持ち回り）
 *   4. 負例: 院内アドレス(192.168.x.x)の鍵なしは保存されない。クラウドをフォールバックに入れても残らない
 *   5. 🔴 アシスタント窓(#assistant)以外から aiChat を呼ぶと forbidden で、偽サーバーに何も届かない
 *   6. #assistant 窓からの会話: 非ストリーム／ストリーム(差分が順に届く)／ツール呼び出し／中断
 *
 * 偽サーバーが確かめるのは「組み立てと往復」だけ。各社の実 API が受理するかは確かめない。
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）、frontend・desktop・automator の npm ci。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "ai-chat-gateway-check");
const PORTS = { http: 19300, scp: 19301, vite: 19303 };
const { check, summary } = createChecker();

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

/** 偽の OpenAI 互換サーバー。stream:true なら SSE で少しずつ返す。`slow` なら止まったままにして中断を試せる。 */
function startFake(port: number): { server: http.Server; seen: Seen[]; mode: { slow: boolean } } {
  const seen: Seen[] = [];
  const mode = { slow: false };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw });
      let body: { stream?: boolean; tools?: unknown[] } = {};
      try { body = JSON.parse(raw); } catch { /* GET など */ }
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const events = [
          { choices: [{ delta: { content: "ロー" } }] },
          { choices: [{ delta: { content: "カル" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "fit", arguments: '{"ti' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'le":1}' } }] }, finish_reason: "tool_calls" }] },
        ];
        let i = 0;
        const timer = setInterval(() => {
          if (mode.slow && i >= 1) return; // 1 つ送ったあと止まる（中断の検査用）
          if (i < events.length) res.write(`data: ${JSON.stringify(events[i++])}\n\n`);
          else { res.write("data: [DONE]\n\n"); res.end(); clearInterval(timer); }
        }, 30);
        // 🔴 req ではなく res。Node は本文を読み終えた時点で req の close を出すので、req だと最初の送信前に止まる。
        res.on("close", () => clearInterval(timer));
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "非ストリームの返答" } }] }));
    });
  });
  server.listen(port, "127.0.0.1");
  return { server, seen, mode };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Bridge = {
  aiProvidersGet: () => Promise<{ providers: { id: string; auth?: unknown; toolMode?: string; keyless?: boolean }[]; defaults: Record<string, string>; fallbacks?: Record<string, string[]>; problems: string[] }>;
  aiProvidersSet: (cfg: unknown) => Promise<{ ok: boolean; problems: string[] }>;
  aiDefaultsSet: (d: Record<string, string>) => Promise<{ ok: boolean }>;
  aiChat: (req: unknown) => Promise<Record<string, unknown>>;
  aiChatCancel: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onAiChatEvent: (cb: (e: { sessionId: string; text: string }) => void) => () => void;
};

async function openAiPanel(driver: DesktopDriver): Promise<void> {
  const page = driver.page;
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("settings-cat-ai").click();
  await page.getByTestId("ai-panel").waitFor({ state: "visible", timeout: 10_000 });
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fakePort = await freePort();
  const fake = startFake(fakePort);
  const driver = new DesktopDriver(PORTS);
  let dataDir = "";
  try {
    await driver.start();
    dataDir = await driver.app.evaluate(({ dialog }) => {
      // 送信先の追加・変更の確認ダイアログは常に「許可」で答える（main の showMessageBoxSync を差し替える）。
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return process.cwd();
    });
    for (const f of ["ai-providers.json", "secrets.enc.json"]) {
      const p = path.join(dataDir, f);
      if (fs.existsSync(p)) fs.rmSync(p);
    }
    await driver.page.reload({ waitUntil: "domcontentloaded" });
    const page = driver.page;
    const call = <T,>(fn: (b: Bridge) => Promise<T>) =>
      page.evaluate(`(${fn.toString()})(window.graphyDesktop)`) as Promise<T>;

    // --- 1. 出荷時: text-to-text の行 ---
    console.log("\n[1] 出荷時の構成");
    await openAiPanel(driver);
    check(await page.getByTestId("ai-default-text-to-text").isVisible(), "設定＞AI に text-to-text（会話）の行が出る");
    check(await page.getByTestId("ai-test-gemini-public-text-to-text").isDisabled(), "鍵が無いと Gemini の text-to-text 接続テストは押せない");
    const cfg0 = await call((b) => b.aiProvidersGet());
    check(cfg0.defaults["text-to-text"] === "gemini-public", "text-to-text の既定は出荷時の Gemini", cfg0.defaults);
    await page.screenshot({ path: path.join(OUT_DIR, "1-default.png") });

    // --- 2. 鍵なしのローカル提供元 ---
    console.log("\n[2] 鍵なし(auth:none)のローカル提供元");
    const local = {
      id: "local", label: "ローカル LLM", kind: "openai", endpoint: `http://127.0.0.1:${fakePort}`,
      auth: "none", toolMode: "none", models: { "text-to-text": "tiny" },
    };
    const gemini = cfg0.providers.find((p) => p.id === "gemini-public");
    // 設定画面が保存するのと同じ口（aiProvidersSet）。fallbacks は画面から渡さない項目なので、ここでは入れて残るかを後で見る。
    const set1 = await page.evaluate(
      (cfg) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiProvidersSet(cfg),
      { providers: [gemini, local], defaults: { "text-to-text": "gemini-public" }, fallbacks: { "text-to-text": ["local"] } },
    );
    check(set1.ok === true, "鍵なしのローカル提供元を保存できる", set1);
    await page.getByTestId("dialog-close-button").click();
    await page.getByTestId("settings-dialog").waitFor({ state: "detached", timeout: 5_000 });
    await openAiPanel(driver);
    check(await page.getByTestId("ai-provider-local").isVisible(), "一覧にローカル提供元が出る");
    const keyState = ((await page.getByTestId("ai-key-state-local").textContent()) ?? "").trim();
    check(/鍵は不要|No key needed/.test(keyState), "鍵の状態は『鍵は不要』", keyState);
    check(!(await page.getByTestId("ai-test-local-text-to-text").isDisabled()), "鍵が無くても接続テストが押せる（正例）");
    await page.getByTestId("ai-test-local-text-to-text").click();
    await page.getByTestId("ai-test-verdict-local").waitFor({ state: "visible", timeout: 30_000 });
    const verdict = ((await page.getByTestId("ai-test-verdict-local").textContent()) ?? "").trim();
    check(/Connected|到達|reachable|接続できました/i.test(verdict), "偽サーバーへ到達する", verdict);
    const s1 = fake.seen[0];
    check(fake.seen.length === 1 && s1.url === "/v1/chat/completions", "POST /v1/chat/completions が 1 回届いた", fake.seen.map((s) => s.url));
    check(!Object.keys(s1.headers).some((k) => /^(authorization|x-api-key|api-key)$/i.test(k)), "🔴 認証ヘッダを付けていない", Object.keys(s1.headers));
    check(JSON.parse(s1.body).model === "tiny", "モデル名は text-to-text のもの", JSON.parse(s1.body).model);
    check(!s1.body.includes("image_url"), "🔴 接続テストに画像は付かない（text-to-text）");
    await page.screenshot({ path: path.join(OUT_DIR, "2-keyless-test.png") });

    // --- 3. 画面から保存し直しても残る ---
    console.log("\n[3] 持ち回り");
    await page.getByTestId("ai-provider-edit-local").click();
    await page.getByTestId("ai-provider-form-save").click();
    await sleep(800);
    const cfg3 = await call((b) => b.aiProvidersGet());
    const l3 = cfg3.providers.find((p) => p.id === "local");
    check(l3?.auth === "none" && l3?.keyless === true, "🔴 編集して保存し直しても auth:none が残る", l3);
    check(l3?.toolMode === "none", "🔴 toolMode が残る", l3);
    check(JSON.stringify(cfg3.fallbacks?.["text-to-text"]) === '["local"]', "🔴 画面から保存し直しても fallbacks（画面に出ない項目）が残る", cfg3.fallbacks);
    const set3 = await page.evaluate(
      (cfg) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiProvidersSet(cfg),
      { providers: cfg3.providers, defaults: cfg3.defaults },
    );
    check(set3.ok === true, "fallbacks を渡さない保存が通る");
    const cfg3b = await call((b) => b.aiProvidersGet());
    check(cfg3b.providers.find((p) => p.id === "local")?.auth === "none", "🔴 fallbacks を渡さずに保存しても auth:none が残る");
    check(JSON.stringify(cfg3b.fallbacks?.["text-to-text"]) === '["local"]', "🔴 fallbacks を渡さずに保存しても fallbacks が残る", cfg3b.fallbacks);

    // --- 4. 負例 ---
    console.log("\n[4] 負例");
    const lan = { ...local, id: "lan", endpoint: "http://192.168.1.50:8080" };
    const set4 = await page.evaluate(
      (cfg) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiProvidersSet(cfg),
      {
        providers: [...cfg3b.providers, lan, { id: "cloud2", kind: "openai", endpoint: "https://api.example.test", auth: "api-key", models: { "text-to-text": "m" } }],
        defaults: cfg3b.defaults,
        fallbacks: { "text-to-text": ["local", "cloud2"] },
      },
    );
    const cfg4 = await call((b) => b.aiProvidersGet());
    check(!cfg4.providers.some((p) => p.id === "lan"), "🔴 院内アドレスの鍵なしは保存されない", set4);
    check(cfg4.problems.some((p) => p.includes("auth-none-needs-loopback")) || set4.problems.some((p) => p.includes("auth-none-needs-loopback")),
      "理由(auth-none-needs-loopback)が返る", [cfg4.problems, set4.problems]);
    check(!(cfg4.fallbacks?.["text-to-text"] ?? []).includes("cloud2"), "🔴 クラウドはフォールバックに入らない", cfg4.fallbacks);
    check(JSON.stringify(cfg4.fallbacks?.["text-to-text"]) === '["local"]', "ローカルは鎖に残る（クラウドだけが落ちる）", cfg4.fallbacks);
    // 後始末: 検査用に足したクラウドを外す
    await page.evaluate(
      (cfg) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiProvidersSet(cfg),
      { providers: cfg3b.providers, defaults: cfg3b.defaults, fallbacks: { "text-to-text": ["local"] } },
    );

    // --- 5. 窓の制限 ---
    console.log("\n[5] アシスタント窓以外は会話の口を呼べない");
    const before = fake.seen.length;
    const forbidden = await page.evaluate(
      (req) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiChat(req),
      { sessionId: "s-main", messages: [{ role: "user", text: "こんにちは" }] },
    );
    check(forbidden.ok === false && forbidden.error === "forbidden", "🔴 メイン窓からの aiChat は forbidden", forbidden);
    const cancelForbidden = await page.evaluate(() => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiChatCancel("s-main"));
    check(cancelForbidden.error === "forbidden", "🔴 aiChatCancel も forbidden", cancelForbidden);
    await sleep(300);
    check(fake.seen.length === before, "偽サーバーに何も届いていない", fake.seen.length - before);

    // --- 6. #assistant 窓からの会話 ---
    console.log("\n[6] #assistant 窓からの会話");
    await call((b) => b.aiDefaultsSet({ "text-to-text": "local" }));
    const cfg6 = await call((b) => b.aiProvidersGet());
    check(cfg6.defaults["text-to-text"] === "local", "会話の既定をローカルにした（検査の前提）", cfg6.defaults);
    check(JSON.stringify(cfg6.fallbacks?.["text-to-text"]) === '["local"]', "既定を変えても fallbacks の並びは失われない", cfg6.fallbacks);
    const origUrl = page.url();
    await page.evaluate(() => { window.location.hash = "#assistant"; });
    await page.waitForFunction(() => window.location.hash === "#assistant");
    const chatPlain = await page.evaluate(
      (req) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiChat(req),
      { sessionId: "s-plain", messages: [{ role: "user", text: "こんにちは" }] },
    );
    check(chatPlain.ok === true && chatPlain.text === "非ストリームの返答", "非ストリームの会話が返る", chatPlain);
    check((chatPlain.provenance as { providerId: string }).providerId === "local", "由来に提供元が入る", chatPlain.provenance);

    const streamed = await page.evaluate(async () => {
      const g = (window as unknown as { graphyDesktop: Bridge }).graphyDesktop;
      const deltas: string[] = [];
      const off = g.onAiChatEvent((e) => { if (e.sessionId === "s-stream") deltas.push(e.text); });
      const r = await g.aiChat({
        sessionId: "s-stream", stream: true,
        messages: [{ role: "user", text: "ツールを使って" }],
        tools: [{ name: "fit", description: "フィット", parameters: { type: "object", properties: { title: { type: "number" } } } }],
      });
      off();
      return { r, deltas };
    });
    check(JSON.stringify(streamed.deltas) === JSON.stringify(["ロー", "カル"]), "差分が順に届く", streamed.deltas);
    check(streamed.r.ok === true && streamed.r.text === "ローカル", "最終結果は差分の連結と一致する", streamed.r);
    const calls = streamed.r.toolCalls as { id: string; name: string; args: unknown }[];
    check(Array.isArray(calls) && calls.length === 1 && calls[0].name === "fit" && JSON.stringify(calls[0].args) === '{"tile":1}',
      "断片で届いたツール引数が 1 つの呼び出しに組み立てられる", calls);
    const sentTools = fake.seen.filter((s) => s.body.includes('"stream":true'));
    check(sentTools.length === 1 && !sentTools[0].body.includes('"tools"'), "toolMode:none の提供元にはツールを送らない（呼び出し側が代替する）");

    fake.mode.slow = true;
    const cancelled = await page.evaluate(async () => {
      const g = (window as unknown as { graphyDesktop: Bridge }).graphyDesktop;
      const running = g.aiChat({ sessionId: "s-cancel", stream: true, messages: [{ role: "user", text: "長い" }] });
      await new Promise((r) => setTimeout(r, 400));
      const c = await g.aiChatCancel("s-cancel");
      return { c, r: await running };
    });
    fake.mode.slow = false;
    check(cancelled.c.ok === true && cancelled.r.error === "canceled", "中断すると canceled で返る", cancelled);
    const again = await page.evaluate(
      (req) => (window as unknown as { graphyDesktop: Bridge }).graphyDesktop.aiChat(req),
      { sessionId: "s-cancel", messages: [{ role: "user", text: "もう一度" }] },
    );
    check(again.ok === true, "中断のあと同じセッションで再び送れる（錠が解放されている）", again);

    await page.evaluate((u) => { window.location.hash = new URL(u).hash || "#"; }, origUrl);
  } finally {
    await driver.stop();
    fake.server.close();
    for (const f of ["ai-providers.json", "secrets.enc.json"]) {
      if (dataDir && fs.existsSync(path.join(dataDir, f))) fs.rmSync(path.join(dataDir, f));
    }
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

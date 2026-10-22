/*
 * AI アシスタント窓（#assistant）の実機検証。設計: fw/ai-routing-design.md §16（S1）。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantWindowCheck.ts
 *
 * 本物の Electron ＋ backend ＋ loopback の偽 OpenAI 互換サーバー（SSE）で確かめる。
 *   1. メニューから別窓が 1 枚開く／もう一度押しても増えない
 *   2. 未設定（出荷時の Gemini で鍵なし）では入力できず、案内が出る
 *   3. ローカル(鍵なし)を設定 → 送信 → 逐次表示 → Markdown が整形される → 資料の出典が出る
 *   4. 無関係な質問には資料を添えない（system プロンプトで確認）
 *   5. 中止できる／中止後に再送できる
 *   6. 画像添付 → image-to-text のモデルで送られる／画像でないファイルは弾く
 *   7. 失敗の表示（偽サーバーが 500）
 *   8. メイン窓からの aiChat は forbidden のまま
 * 未達として残すもの: degraded バッジの実機（https のクラウドを落とす経路が要る）。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Page } from "playwright";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-window-check");
const PORTS = { http: 19310, scp: 19311, vite: 19313 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Seen { body: string }

function startFake(port: number) {
  const seen: Seen[] = [];
  const mode = { slow: false, fail: false };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({ body: raw });
      let body: { stream?: boolean } = {};
      try { body = JSON.parse(raw); } catch { /* */ }
      if (mode.fail) { res.writeHead(500); res.end("boom"); return; }
      if (!body.stream) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "OK" } }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const parts = ["**太", "字** です。\n\n1. 手順一\n2. 手順二\n\n", "`code` と末尾"];
      let i = 0;
      const timer = setInterval(() => {
        if (mode.slow && i >= 1) return;
        if (i < parts.length) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] })}\n\n`);
        else { res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`); res.end(); clearInterval(timer); }
      }, 60);
      res.on("close", () => clearInterval(timer));
    });
  });
  server.listen(port, "127.0.0.1");
  return { server, seen, mode };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

// 1x1 の PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fake = startFake(await freePort().then((p) => { fakePort = p; return p; }));
  const driver = new DesktopDriver(PORTS);
  let dataDir = "";
  const clean = () => {
    for (const f of ["ai-providers.json", "secrets.enc.json"]) {
      if (dataDir && fs.existsSync(path.join(dataDir, f))) fs.rmSync(path.join(dataDir, f));
    }
  };
  try {
    await driver.start();
    dataDir = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return process.cwd();
    });
    clean();
    await driver.page.reload({ waitUntil: "domcontentloaded" });
    const main: Page = driver.page;
    const wins = () => driver.app.windows().filter((w) => w.url().includes("#assistant"));

    // --- 1. 窓が開く ---
    console.log("\n[1] メニューから開く");
    const open = () => driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    let win = await open();
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    check(wins().length === 1, "別窓が 1 枚開く");
    await main.getByTestId("mainscreen-menu-system").click();
    await main.getByTestId("menu-item-assistant").click();
    await sleep(1200);
    check(wins().length === 1, "もう一度押しても増えない（シングルトン）", wins().length);

    // --- 2. 未設定 ---
    console.log("\n[2] 未設定");
    await win.getByTestId("assistant-not-configured").waitFor({ state: "visible", timeout: 10_000 });
    check(await win.getByTestId("assistant-input").isDisabled(), "🔴 未設定では入力できない");
    await win.screenshot({ path: path.join(OUT_DIR, "1-not-configured.png") });

    // --- 3. ローカルを設定して会話 ---
    console.log("\n[3] 設定 → 会話");
    const local = {
      id: "local", label: "ローカル LLM", kind: "openai", endpoint: `http://127.0.0.1:${fakePort}`,
      auth: "none", toolMode: "none", models: { "text-to-text": "tiny", "image-to-text": "tiny-vision" },
    };
    const set = await main.evaluate(
      (cfg) => (window as unknown as { graphyDesktop: { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean }> } }).graphyDesktop.aiProvidersSet(cfg),
      { providers: [local], defaults: { "text-to-text": "local", "image-to-text": "local" } },
    );
    check(set.ok === true, "ローカル提供元を保存できる", set);
    await win.reload({ waitUntil: "domcontentloaded" });
    await win.getByTestId("assistant-input").waitFor({ state: "visible", timeout: 10_000 });
    await sleep(500);
    check(!(await win.getByTestId("assistant-input").isDisabled()), "設定後は入力できる");
    check(((await win.getByTestId("assistant-via").textContent()) ?? "").includes("tiny"), "使うモデルがヘッダに出る");

    const ask = async (q: string) => {
      await win.getByTestId("assistant-input").fill(q);
      await win.getByTestId("assistant-send").click();
    };
    await ask("プラグインの作り方を教えてください");
    await win.getByTestId("assistant-msg-bot").first().locator("strong").waitFor({ state: "visible", timeout: 15_000 });
    await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 15_000 });
    const bot = win.getByTestId("assistant-msg-bot").first();
    check((await bot.locator("strong").textContent()) === "太字", "🔴 Markdown が整形される（太字）");
    check((await bot.locator("ol > li").count()) === 2, "番号付き手順が 2 項目になる");
    check(((await bot.textContent()) ?? "").includes("末尾"), "ストリームの最後まで表示される");
    const src = ((await win.getByTestId("assistant-sources").textContent()) ?? "");
    check(src.includes("plugins.md"), "資料の出典（plugins.md）が出る", src);
    const req1 = JSON.parse(fake.seen[fake.seen.length - 1].body);
    check(req1.stream === true && !("tools" in req1), "stream で送り tools は送らない（S1 は案内のみ）");
    check(req1.messages[0].role === "system" && /DOCUMENTS:/.test(req1.messages[0].content) && req1.messages[0].content.includes("plugins.md"),
      "system に該当資料が添えられている");
    check(JSON.stringify(req1).includes("image_url") === false, "画像は付かない");
    await win.screenshot({ path: path.join(OUT_DIR, "2-answer.png") });

    // --- 4. 無関係な質問 ---
    console.log("\n[4] 無関係な質問");
    await ask("今日の天気と夕食のレシピを教えて");
    await win.getByTestId("assistant-msg-bot").nth(1).locator("strong").waitFor({ state: "visible", timeout: 15_000 });
    await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 15_000 });
    const req2 = JSON.parse(fake.seen[fake.seen.length - 1].body);
    check(/no relevant document/.test(req2.messages[0].content), "🔴 無関係な質問には資料を添えない");
    check(req2.messages.length === 4 && req2.messages[1].role === "user" && req2.messages[2].role === "assistant", "履歴（前の質問と答え）が送られる", req2.messages.map((m: { role: string }) => m.role));
    check((await win.getByTestId("assistant-sources").count()) === 1, "資料なしの回答には出典欄が出ない（1 件目だけ）");

    // --- 5. 中止 ---
    console.log("\n[5] 中止");
    fake.mode.slow = true;
    await ask("長く答えて");
    await win.getByTestId("assistant-stop").waitFor({ state: "visible", timeout: 10_000 });
    await sleep(500);
    await win.getByTestId("assistant-stop").click();
    await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 10_000 });
    fake.mode.slow = false;
    const lastBot = win.getByTestId("assistant-msg-bot").last();
    check(/中止|canceled/.test((await lastBot.textContent()) ?? ""), "中止と表示される");
    await win.getByTestId("assistant-input").fill("もう一度");
    check(!(await win.getByTestId("assistant-send").isDisabled()), "中止のあと再送できる");
    await win.screenshot({ path: path.join(OUT_DIR, "3-canceled.png") });

    // --- 6. 画像 ---
    console.log("\n[6] 画像");
    const imgFile = path.join(OUT_DIR, "pixel.png");
    fs.writeFileSync(imgFile, PNG);
    const txtFile = path.join(OUT_DIR, "note.txt");
    fs.writeFileSync(txtFile, "hello");
    await win.locator('input[type="file"]').setInputFiles(txtFile);
    await sleep(300);
    check((await win.getByText(/画像ファイルではありません|Not an image file/).count()) === 1, "🔴 画像でないファイルは弾いて理由を出す");
    await win.locator('input[type="file"]').setInputFiles(imgFile);
    await sleep(300);
    check((await win.locator("img").count()) === 1, "画像のサムネイルが出る");
    await ask("この画像は何ですか");
    await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 15_000 });
    const req3 = JSON.parse(fake.seen[fake.seen.length - 1].body);
    check(JSON.stringify(req3).includes("image_url"), "画像が送られる");
    check(req3.model === "tiny-vision", "🔴 画像つきは image-to-text のモデルで送る", req3.model);
    await win.screenshot({ path: path.join(OUT_DIR, "4-image.png") });

    // --- 7. 失敗 ---
    console.log("\n[7] 失敗の表示");
    fake.mode.fail = true;
    await ask("失敗させる");
    await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 15_000 });
    fake.mode.fail = false;
    const errText = ((await win.getByTestId("assistant-msg-bot").last().textContent()) ?? "");
    check(/失敗しました|Failed/.test(errText), "失敗が画面に出る", errText);

    // --- 8. メイン窓からは呼べない ---
    console.log("\n[8] 他の窓から");
    const forbidden = await main.evaluate(
      () => (window as unknown as { graphyDesktop: { aiChat: (r: unknown) => Promise<{ error?: string }> } }).graphyDesktop.aiChat({ sessionId: "x", messages: [{ role: "user", text: "hi" }] }),
    );
    check(forbidden.error === "forbidden", "🔴 メイン窓からの aiChat は forbidden のまま", forbidden);
    console.log("\n未達: degraded バッジの実機（https のクラウドを 5xx にする経路が無い。状態遷移は chatState.test.ts のみ）");
  } finally {
    await driver.stop();
    fake.server.close();
    clean();
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

let fakePort = 0;
main().catch((e) => { console.error(e); process.exit(1); });

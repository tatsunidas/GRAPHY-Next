/*
 * 設定＞AI（提供元の追加・鍵・接続テスト・既定の切替・削除）の実機検証。設計: fw/ai-routing-design.md §14.5。
 *
 * 実行:  cd automator && npx tsx src/spike/aiProvidersUiCheck.ts
 *        （実 Gemini も確かめるときは GRAPHY_SPIKE_GEMINI_KEY を環境変数で渡す。鍵はコード・ログに出さない）
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend ＋ loopback の偽 AI サーバー）:
 *   1. 追加で main が確認ダイアログを出し、宛先 URL が載る。平文 http の印が出る
 *   2. 鍵を保存すると「設定済み」になり、GET /api/settings・ai-providers.json・画面に鍵が出ない
 *   3. 接続テスト: 偽 200 で reachable。偽サーバーが受けたパス・認証・本文が意図どおり
 *   4. 負例: 偽 401・サーバー断で成功と表示しない。画面に鍵を出さない
 *   5. 既定の切替では確認ダイアログを出さず、設定に反映される
 *   6. 再起動しても提供元が残る（正例）。削除すると鍵も消え、再起動後も戻らない（負例側）
 *   7. （任意）実 Gemini の接続テスト。鍵が無ければ「未達」と数える
 *
 * 偽サーバーが確かめるのは「組み立て」だけ。各社の実 API が受理するかは確かめない（実送信は別に数える）。
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）、frontend・desktop の npm ci。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "ai-providers-ui-check");
const PORTS = { http: 19290, scp: 19291, vite: 19293 };
const PROVIDER_ID = "spike-openai";
const MODEL = "spike-model";
const CAP = "image-to-text";
const SPIKE_KEY = `spike-${crypto.randomBytes(12).toString("hex")}`;
const GEMINI_KEY = process.env.GRAPHY_SPIKE_GEMINI_KEY ?? "";

const { check, summary } = createChecker();
const pending: string[] = [];
function pend(label: string, why: string): void {
  console.log(`  [未達] ${label} — ${why}`);
  pending.push(label);
}

type Mode = "ok" | "401" | "drop";
interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

/** 偽の OpenAI 互換サーバー。モードで 200 / 401 / 接続断を切り替え、受けた要求を残す。 */
function startFake(port: number): { server: http.Server; seen: Seen[]; mode: { value: Mode } } {
  const seen: Seen[] = [];
  const mode = { value: "ok" as Mode };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (mode.value === "drop") return void req.socket.destroy();
      res.setHeader("Content-Type", "application/json");
      if (mode.value === "401") {
        res.statusCode = 401;
        return void res.end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        return void res.end(JSON.stringify({ data: [{ id: "fake-model-b" }, { id: "fake-model-a" }] }));
      }
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
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

/** 成功の表示か（画面の言語に依らないよう、日英の語で見る）。負例の検査も同じ判定を使う。 */
const isGood = (verdict: string) => /Connected|到達|reachable|接続できました/i.test(verdict);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function installDialogCapture(driver: DesktopDriver): Promise<string> {
  return driver.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __dlg: unknown[] };
    g.__dlg = [];
    dialog.showMessageBoxSync = ((...args: unknown[]) => {
      g.__dlg.push(args[args.length - 1]);
      return 0;
    }) as typeof dialog.showMessageBoxSync;
    return process.cwd();
  });
}
const dialogs = (driver: DesktopDriver) =>
  driver.app.evaluate(() => (globalThis as unknown as { __dlg: { title?: string; detail?: string }[] }).__dlg);

async function openAiPanel(driver: DesktopDriver): Promise<void> {
  const page = driver.page;
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("settings-cat-ai").click();
  await page.getByTestId("ai-panel").waitFor({ state: "visible", timeout: 10_000 });
}

async function secretHasValue(driver: DesktopDriver, key: string): Promise<boolean> {
  return driver.page.evaluate(
    (k) => (window as unknown as { graphyDesktop: { secretStatus: (x: string) => Promise<{ hasValue: boolean }> } })
      .graphyDesktop.secretStatus(k).then((s) => s.hasValue),
    key,
  );
}
async function providersConfig(driver: DesktopDriver): Promise<{ providers: { id: string; hasApiKey: boolean; secretKey?: string }[]; defaults: Record<string, string> }> {
  return driver.page.evaluate(() =>
    (window as unknown as { graphyDesktop: { aiProvidersGet: () => Promise<never> } }).graphyDesktop.aiProvidersGet());
}

async function runTest(driver: DesktopDriver, id: string, cap: string): Promise<{ verdict: string; text: string }> {
  const page = driver.page;
  await page.getByTestId(`ai-test-${id}-${cap}`).click();
  await page.getByTestId(`ai-test-verdict-${id}`).waitFor({ state: "visible", timeout: 30_000 });
  const verdict = ((await page.getByTestId(`ai-test-verdict-${id}`).textContent()) ?? "").trim();
  const text = (await page.getByTestId(`ai-test-result-${id}`).textContent()) ?? "";
  return { verdict, text };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fakePort = await freePort();
  const fake = startFake(fakePort);
  const fakeUrl = `http://127.0.0.1:${fakePort}`;
  let driver = new DesktopDriver(PORTS);
  let dataDir = "";
  let providersFile = "";
  const secretKeyOf = `ai.provider.${PROVIDER_ID}.apiKey`;

  try {
    await driver.start();
    dataDir = await installDialogCapture(driver);
    providersFile = path.join(dataDir, "ai-providers.json");
    // 前回の残りがあると「追加」の前提が崩れる。このスパイクの作業場所（desktop の CWD）だけを掃除する
    for (const f of ["ai-providers.json", "secrets.enc.json"]) {
      const p = path.join(dataDir, f);
      if (fs.existsSync(p)) fs.rmSync(p);
    }
    await driver.page.reload({ waitUntil: "domcontentloaded" });
    driver.page.on("dialog", (d) => void d.accept()); // window.confirm（鍵の消去・提供元の削除）
    const page = driver.page;

    // --- 1. 出荷時の構成 ---
    console.log("\n[1] 出荷時の構成");
    await openAiPanel(driver);
    const cfg0 = await providersConfig(driver);
    check(cfg0.providers.length === 1 && cfg0.providers[0].id === "gemini-public", "出荷時は Gemini だけ", cfg0.providers.map((p) => p.id));
    check(cfg0.defaults[CAP] === "gemini-public", "画像から文章の既定は Gemini", cfg0.defaults);
    check(await page.getByTestId("ai-test-gemini-public-image-to-text").isDisabled(), "鍵が無いと Gemini の接続テストは押せない");
    check(await page.getByTestId("ai-privacy-notice").isVisible(), "送信に関する注意書きが畳まれず出ている");
    await page.screenshot({ path: path.join(OUT_DIR, "1-default.png") });

    // --- 1b. ダイアログの外側をクリックしても閉じない ---
    console.log("\n[1b] 外側のクリック");
    await page.getByTestId("ai-key-input-gemini-public").fill("outside-click-draft");
    const outside = { x: 30, y: 300 };
    check(await page.evaluate(({ x, y }) => !document.querySelector('[data-testid="settings-dialog"]')?.contains(document.elementFromPoint(x, y)), outside),
      "クリックする位置はダイアログの外（検査の前提）");
    await page.mouse.click(outside.x, outside.y);
    await sleep(400);
    check(await page.getByTestId("settings-dialog").isVisible(), "🔴 外側をクリックしてもダイアログは閉じない");
    check((await page.getByTestId("ai-key-input-gemini-public").inputValue()) === "outside-click-draft", "入力途中の内容が残る");
    await page.getByTestId("ai-key-input-gemini-public").fill("");
    await page.getByTestId("dialog-close-button").click();
    await page.getByTestId("settings-dialog").waitFor({ state: "detached", timeout: 5_000 });
    check(true, "✕ では閉じる（閉じる経路は生きている）");
    await openAiPanel(driver);

    // --- 2. 提供元を追加 ---
    console.log("\n[2] 提供元の追加");
    await page.getByTestId("ai-provider-add").click();
    check(await page.getByTestId("ai-provider-field-endpoint").count() === 0, "提供元を選ぶまで入力欄は出ない");
    check(await page.getByTestId("ai-provider-form-save").count() === 0, "提供元を選ぶまで保存は押せない（欄ごと無い）");
    await page.getByTestId("ai-provider-preset").selectOption("other");
    await page.getByTestId("ai-provider-field-id").fill(PROVIDER_ID);
    await page.getByTestId("ai-provider-field-label").fill("Spike OpenAI 互換");
    await page.getByTestId("ai-provider-field-kind").selectOption("openai");
    await page.getByTestId("ai-provider-field-endpoint").fill(fakeUrl);
    await page.getByTestId(`ai-provider-field-model-${CAP}`).fill(MODEL);
    await page.getByTestId("ai-provider-form-save").click();
    await page.getByTestId(`ai-provider-${PROVIDER_ID}`).waitFor({ state: "visible", timeout: 10_000 });
    const d1 = await dialogs(driver);
    check(d1.length === 1 && String(d1[0].detail).includes(fakeUrl), "🔴 main が確認ダイアログを出し、宛先の URL が載る", d1);
    check(await page.getByTestId(`ai-plaintext-${PROVIDER_ID}`).isVisible(), "平文 http の印が出る");
    check((await page.getByTestId(`ai-test-${PROVIDER_ID}-${CAP}`).count()) === 1
      && (await page.getByTestId(`ai-test-${PROVIDER_ID}-image-to-image`).count()) === 0,
    "モデルを書いた用途だけ接続テストのボタンが出る");
    check(await page.getByTestId(`ai-test-${PROVIDER_ID}-${CAP}`).isDisabled(), "鍵が無い間は接続テストを押せない");
    check(fake.seen.length === 0, "鍵を入れるまで偽サーバーには何も届いていない", fake.seen.length);

    // --- 3. 鍵 ---
    console.log("\n[3] 鍵");
    await page.getByTestId(`ai-key-input-${PROVIDER_ID}`).fill(SPIKE_KEY);
    await page.getByTestId(`ai-key-save-${PROVIDER_ID}`).click();
    await page.waitForFunction((id) => !document.querySelector(`[data-testid="ai-test-${id}-image-to-text"]`)?.hasAttribute("disabled"),
      PROVIDER_ID, { timeout: 10_000 });
    check(true, "鍵を保存すると接続テストが押せるようになる");
    const settings = await (await fetch(`http://localhost:${PORTS.http}/api/settings`)).text();
    check(!settings.includes(SPIKE_KEY), "🔴 GET /api/settings に鍵が含まれない");
    check(fs.existsSync(providersFile), "提供元の設定ファイルが書かれている（検査の前提）", providersFile);
    check(!fs.readFileSync(providersFile, "utf8").includes(SPIKE_KEY), "🔴 ai-providers.json に鍵が書かれない");
    check(!((await page.getByTestId("ai-panel").textContent()) ?? "").includes(SPIKE_KEY), "🔴 画面に鍵が出ない");
    const cfg1 = await providersConfig(driver);
    check(JSON.stringify(cfg1).includes(SPIKE_KEY) === false, "🔴 aiProvidersGet（プラグインへ返る）に鍵が含まれない");
    const persisted = await secretHasValue(driver, secretKeyOf);
    check(persisted, "鍵が保持されている（このセッション中）");
    const msg = (await page.getByTestId("ai-message").textContent().catch(() => "")) ?? "";
    console.log(`    → 保存の表示: ${msg}`);
    const sessionOnly = /この起動|session|再起動/.test(msg);

    // --- 4. 接続テスト（正例）---
    console.log("\n[4] 接続テスト");
    const r1 = await runTest(driver, PROVIDER_ID, CAP);
    check(fake.seen.length === 1, "偽サーバーが 1 回受けた（検査の前提）", fake.seen.length);
    check(isGood(r1.verdict), "偽 200 で到達の表示になる", r1.verdict);
    check(r1.text.includes(`POST http://127.0.0.1:${fakePort}/v1/chat/completions`), "リクエストラインが出る", r1.text.slice(0, 200));
    check(!r1.text.includes(SPIKE_KEY), "🔴 結果表示に鍵が出ない");
    const s1 = fake.seen[0];
    check(s1?.method === "POST" && s1.url === "/v1/chat/completions", "パスは /v1/chat/completions", s1?.url);
    check(s1?.headers.authorization === `Bearer ${SPIKE_KEY}`, "🔴 Authorization は Bearer <鍵>");
    const body = JSON.parse(s1?.body ?? "{}");
    check(body.model === MODEL && Array.isArray(body.messages) && body.messages.length >= 1, "本文に model と messages", Object.keys(body));
    check(JSON.stringify(body).includes("data:image") || JSON.stringify(body).includes("image_url"), "1×1 の画像が載る（患者画像ではない固定画像）");
    await page.screenshot({ path: path.join(OUT_DIR, "2-test-ok.png") });

    // --- 5. 負例 ---
    console.log("\n[5] 負例");
    await sleep(3500); // 連打の間隔（main が 3 秒空けさせる）
    fake.mode.value = "401";
    const r401 = await runTest(driver, PROVIDER_ID, CAP);
    check(fake.seen.length === 2, "401 のときも偽サーバーが受けた（検査の前提）", fake.seen.length);
    check(!isGood(r401.verdict) && r401.verdict !== r1.verdict && r401.text.includes("401"), "🔴 401 を成功と表示しない（HTTP 401 が出る）", r401.verdict);
    check(!r401.text.includes(SPIKE_KEY), "🔴 失敗表示にも鍵が出ない");
    await page.screenshot({ path: path.join(OUT_DIR, "3-test-401.png") });
    await sleep(3500);
    fake.mode.value = "drop";
    const rDrop = await runTest(driver, PROVIDER_ID, CAP);
    check(fake.seen.length === 3, "接続断のときも偽サーバーに届いた（検査の前提）", fake.seen.length);
    check(!isGood(rDrop.verdict) && rDrop.verdict !== r1.verdict, "🔴 接続断を成功と表示しない", rDrop.verdict);
    check(!rDrop.text.includes(SPIKE_KEY), "🔴 接続断の表示にも鍵が出ない");
    fake.mode.value = "ok";

    // --- 6. 既定の切替 ---
    console.log("\n[6] 既定の切替");
    const before = (await dialogs(driver)).length;
    await page.getByTestId(`ai-default-${CAP}`).selectOption(PROVIDER_ID);
    await page.waitForFunction(async () => {
      const c = await (window as unknown as { graphyDesktop: { aiProvidersGet: () => Promise<{ defaults: Record<string, string> }> } }).graphyDesktop.aiProvidersGet();
      return c.defaults["image-to-text"] === "spike-openai";
    }, null, { timeout: 10_000 });
    check(true, "既定が切り替わり設定に反映される");
    check((await dialogs(driver)).length === before, "既定の切替では確認ダイアログを出さない");
    check(JSON.parse(fs.readFileSync(providersFile, "utf8")).defaults?.[CAP] === PROVIDER_ID, "ファイルにも既定が書かれる");
    pend("既定を切り替えた先へ、プラグイン経由の実呼び出しが向く", "本スパイクは設定への反映までを確かめた（呼び出し側は Art of Imaging 等のプラグインで別に確かめる）");

    // --- 6b. モデル一覧の取得（保存済みの提供元） ---
    console.log("\n[6b] モデル一覧");
    await page.getByTestId(`ai-provider-edit-${PROVIDER_ID}`).click();
    check((await page.getByTestId("ai-provider-field-apikey").count()) === 0, "編集フォームには API キー欄が出ない（負例）");
    const fetchBtn = page.getByTestId("ai-provider-models-fetch");
    check(await fetchBtn.isEnabled(), "鍵のある保存済みの提供元では一覧を取得できる");
    const seen0 = fake.seen.length;
    check((await page.locator("#ai-model-options option").count()) === 0, "取得の前は候補が空（検査の前提）");
    await fetchBtn.click();
    await page.getByTestId("ai-provider-models-count").waitFor({ state: "visible", timeout: 10_000 });
    const gets = fake.seen.slice(seen0);
    check(gets.length === 1 && gets[0].method === "GET" && gets[0].url === "/v1/models", "偽サーバーへ GET /v1/models が 1 回届く", gets.map((g) => `${g.method} ${g.url}`));
    check(gets[0]?.headers.authorization === `Bearer ${SPIKE_KEY}`, "🔴 保存済みの鍵で認証している");
    const opts = await page.locator("#ai-model-options option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    check(JSON.stringify(opts) === JSON.stringify(["fake-model-a", "fake-model-b"]), "候補に一覧が並ぶ（名前順）", opts);
    check(!((await page.getByTestId("ai-panel").textContent()) ?? "").includes(SPIKE_KEY), "🔴 画面に鍵が出ない");
    await page.getByTestId(`ai-provider-field-model-${CAP}`).fill("fake-model-a");
    check((await page.getByTestId("ai-provider-models-notinlist").count()) === 0, "一覧にある名前では注意が出ない");
    await page.getByTestId(`ai-provider-field-model-${CAP}`).fill("zzz-not-listed");
    check((await page.getByTestId("ai-provider-models-notinlist").count()) === 1, "🔴 一覧にない名前には注意が出る（負例）");
    await page.screenshot({ path: path.join(OUT_DIR, "8-model-list.png") });
    await sleep(1200); // main が続けて取るのを 1 秒空けさせる
    fake.mode.value = "401";
    await fetchBtn.click();
    await page.getByTestId("ai-provider-models-error").waitFor({ state: "visible", timeout: 10_000 });
    check((await page.getByTestId("ai-provider-models-count").count()) === 0, "🔴 401 を成功（件数）と表示しない");
    check((await page.locator("#ai-model-options option").count()) === 0, "失敗したら古い候補を残さない");
    check(!((await page.getByTestId("ai-panel").textContent()) ?? "").includes(SPIKE_KEY), "🔴 失敗表示にも鍵が出ない");
    fake.mode.value = "ok";
    await page.getByTestId("ai-provider-form-cancel").click();

    // --- 7. 再起動しても残る（正例の対照）---
    console.log("\n[7] 再起動（残る側）");
    await driver.stop();
    driver = new DesktopDriver(PORTS);
    await driver.start();
    await installDialogCapture(driver);
    driver.page.on("dialog", (d) => void d.accept());
    const cfg2 = await providersConfig(driver);
    check(cfg2.providers.some((p) => p.id === PROVIDER_ID), "再起動後も提供元が残る（これが無いと次の『消えた』が証拠にならない）", cfg2.providers.map((p) => p.id));
    check(cfg2.defaults[CAP] === PROVIDER_ID, "再起動後も既定が残る");
    const keyAfterRestart = await secretHasValue(driver, secretKeyOf);
    if (sessionOnly) {
      pend("再起動後も鍵が残る", "この環境では鍵を永続化できない（キーリング無し）。保存時に『この起動の間だけ』と表示された");
      check(!keyAfterRestart, "永続化できない環境では、再起動で鍵が消える（表示どおり）");
    } else {
      check(keyAfterRestart, "再起動後も鍵が残る");
    }

    // --- 8. 削除 ---
    console.log("\n[8] 削除");
    const page2 = driver.page;
    await openAiPanel(driver);
    if (sessionOnly) {
      await page2.getByTestId(`ai-key-input-${PROVIDER_ID}`).fill(SPIKE_KEY);
      await page2.getByTestId(`ai-key-save-${PROVIDER_ID}`).click();
      await page2.waitForFunction((k) => (window as never as { graphyDesktop: { secretStatus: (x: string) => Promise<{ hasValue: boolean }> } }).graphyDesktop.secretStatus(k).then((s) => s.hasValue), secretKeyOf);
    }
    check(await secretHasValue(driver, secretKeyOf), "削除の前に鍵がある（検査の前提）");
    const dlgBefore = (await dialogs(driver)).length;
    await page2.getByTestId(`ai-provider-delete-${PROVIDER_ID}`).click();
    await page2.getByTestId(`ai-provider-${PROVIDER_ID}`).waitFor({ state: "detached", timeout: 10_000 });
    check(!(await secretHasValue(driver, secretKeyOf)), "🔴 削除すると鍵も消える");
    const cfg3 = await providersConfig(driver);
    check(cfg3.defaults[CAP] === "gemini-public", "既定が Gemini に戻る", cfg3.defaults);
    const moved = (await page2.getByTestId("ai-message").textContent().catch(() => "")) ?? "";
    check(/Gemini/.test(moved), "既定が移った先を画面で言う", moved);
    check((await dialogs(driver)).length === dlgBefore, "削除では送信先の確認ダイアログを出さない");
    await page2.screenshot({ path: path.join(OUT_DIR, "4-deleted.png") });

    // --- 9. 再起動しても戻らない ---
    console.log("\n[9] 再起動（消えた側）");
    await driver.stop();
    driver = new DesktopDriver(PORTS);
    await driver.start();
    const cfg4 = await providersConfig(driver);
    check(!cfg4.providers.some((p) => p.id === PROVIDER_ID), "🔴 再起動後に削除した提供元が戻らない", cfg4.providers.map((p) => p.id));
    check(!(await secretHasValue(driver, secretKeyOf)), "🔴 再起動後に鍵が残っていない");
    check(!fs.readFileSync(providersFile, "utf8").includes(SPIKE_KEY), "🔴 ファイルに鍵が無い");

    // --- 9b. 選んで鍵まで入れる追加 ---
    console.log("\n[9b] 提供元を選んで追加（鍵つき）");
    await openAiPanel(driver);
    await installDialogCapture(driver);
    const FORM_KEY = `form-${crypto.randomBytes(12).toString("hex")}`;
    const OPENAI_SECRET = "ai.provider.openai.apiKey";
    const pg = driver.page;
    pg.on("dialog", (dlg) => void dlg.accept()); // 再起動で作り直したページには、window.confirm の受け皿が無い
    check(!(await secretHasValue(driver, OPENAI_SECRET)), "追加の前に openai の鍵は無い（検査の前提）");
    await pg.getByTestId("ai-provider-add").click();
    await pg.getByTestId("ai-provider-preset").selectOption("openai");
    check(((await pg.getByTestId("ai-provider-field-id").textContent()) ?? "").trim() === "openai", "OpenAI を選ぶと識別子が入る");
    check(await pg.getByTestId("ai-provider-field-endpoint-select").inputValue() === "https://api.openai.com", "OpenAI を選ぶと接続先が入る（プルダウン）");
    check(await pg.getByTestId("ai-provider-field-kind").count() === 0, "選んだ提供元では種別の欄を出さない");
    check(await pg.getByTestId("ai-provider-form-save").isDisabled(), "🔴 モデル名が空のうちは保存できない（仮のモデル名を入れていない）");
    await pg.getByTestId("ai-provider-form").screenshot({ path: path.join(OUT_DIR, "6-preset-openai.png") });
    // tsx が evaluate 内の関数に __name を差し込むので、文字列で渡す
    const order = await pg.evaluate(`(function () {
      var q = function (id) { return document.querySelector('[data-testid="' + id + '"]'); };
      var ep = q("ai-provider-field-endpoint-select") || q("ai-provider-field-endpoint");
      var key = q("ai-provider-field-apikey");
      var model = q("ai-provider-field-model-image-to-text");
      var before = function (a, b) { return !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); };
      return { epKey: before(ep, key), keyModel: before(key, model) };
    })()`) as { epKey: boolean; keyModel: boolean };
    check(order.epKey && order.keyModel, "🔴 追加フォームの順序は Endpoint → API キー → モデル", order);
    check(await pg.getByTestId("ai-provider-models-fetch").isDisabled(), "鍵が空のうちは一覧を取得できない（公式ホストへも送らない）");
    await pg.getByTestId("ai-provider-field-apikey").fill(FORM_KEY);
    check(await pg.getByTestId("ai-provider-models-fetch").isEnabled(), "OpenAI＋鍵ありで一覧を取得できる（ここでは押さない＝実ネットワークに出さない）");
    await pg.getByTestId(`ai-provider-field-model-${CAP}`).fill("spike-model-b");
    // 負例: 確認ダイアログを「取り消す」にすると、提供元も鍵も保存されない
    await driver.app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = (() => 1) as typeof dialog.showMessageBoxSync; });
    await pg.getByTestId("ai-provider-form-save").click();
    await pg.waitForFunction(() => document.querySelector('[data-testid="ai-provider-form"]') === null, null, { timeout: 10_000 });
    check(!(await providersConfig(driver)).providers.some((p) => p.id === "openai"), "🔴 取り消すと提供元は保存されない");
    check(!(await secretHasValue(driver, OPENAI_SECRET)), "🔴 取り消すと鍵も保存されない");
    // 正例: 許可する
    await installDialogCapture(driver);
    await pg.getByTestId("ai-provider-add").click();
    await pg.getByTestId("ai-provider-preset").selectOption("openai");
    await pg.getByTestId(`ai-provider-field-model-${CAP}`).fill("spike-model-b");
    await pg.getByTestId("ai-provider-field-apikey").fill(FORM_KEY);
    await pg.getByTestId("ai-provider-form-save").click();
    await pg.getByTestId("ai-provider-openai").waitFor({ state: "visible", timeout: 10_000 });
    const d9 = await dialogs(driver);
    check(d9.length === 1 && String(d9[0].detail).includes("https://api.openai.com"), "main の確認ダイアログに宛先 https://api.openai.com が載る", d9);
    check(await secretHasValue(driver, OPENAI_SECRET), "🔴 追加フォームで入れた鍵が、保存された提供元の鍵として預かられる");
    check(((await pg.getByTestId("ai-key-state-openai").textContent()) ?? "").length > 0 && (await providersConfig(driver)).providers.find((p) => p.id === "openai")?.hasApiKey === true, "鍵の状態が「設定済み」になる");
    check(!fs.readFileSync(providersFile, "utf8").includes(FORM_KEY), "🔴 ai-providers.json に鍵が書かれない");
    check(!((await pg.getByTestId("ai-panel").textContent()) ?? "").includes(FORM_KEY), "🔴 画面に鍵が出ない");
    const optsCfg = await providersConfig(driver);
    const usableI2T = optsCfg.providers.filter((p) => (p as unknown as { models: Record<string, string> }).models[CAP]).map((p) => p.id);
    check(usableI2T.includes("openai"), "モデル名を入れた用途の選択肢に追加した提供元が出る", usableI2T);
    check((await pg.getByTestId(`ai-default-${CAP}`).locator("option").allTextContents()).some((x) => x.includes("spike-model-b")), "既定のプルダウンに「表示名 — モデル名」で並ぶ");
    check((await pg.getByTestId("ai-default-image-to-image").locator("option").allTextContents()).every((x) => !x.includes("spike-model-b")), "モデル名を空にした用途には出ない（負例）");
    // 重複: 2 つ目の OpenAI は openai-2
    await pg.getByTestId("ai-provider-add").click();
    await pg.getByTestId("ai-provider-preset").selectOption("openai");
    check(((await pg.getByTestId("ai-provider-field-id").textContent()) ?? "").trim() === "openai-2", "🔴 識別子が重なれば openai-2 になる（既存の鍵を上書きしない）");
    // 負例: その他 + パス付きの接続先は弾かれる
    await pg.getByTestId("ai-provider-preset").selectOption("other");
    await pg.getByTestId("ai-provider-field-id").fill("bad-path");
    check(await pg.getByTestId("ai-provider-models-fetch").isDisabled(), "🔴 「その他」の新規では一覧を取得できない（任意の宛先へ鍵を送らない）");
    await pg.getByTestId("ai-provider-field-endpoint").fill("https://example.com/v1");
    await pg.getByTestId(`ai-provider-field-model-${CAP}`).fill("m");
    await pg.getByTestId("ai-provider-form-error").waitFor({ state: "visible", timeout: 5_000 });
    check(await pg.getByTestId("ai-provider-form-save").isDisabled(), "🔴 パス付きの接続先は保存できない");
    await pg.screenshot({ path: path.join(OUT_DIR, "7-other-badpath.png") });
    await pg.getByTestId("ai-provider-form-cancel").click();
    // 後始末: 鍵ごと消えること
    await pg.getByTestId("ai-provider-delete-openai").click();
    await pg.getByTestId("ai-provider-openai").waitFor({ state: "detached", timeout: 10_000 });
    check(!(await secretHasValue(driver, OPENAI_SECRET)), "削除すると追加フォームで入れた鍵も消える");

    // --- 10. 実 Gemini ---
    console.log("\n[10] 実 Gemini");
    if (!GEMINI_KEY) {
      pend("実 Gemini の接続テスト（既定の提供元）", "GRAPHY_SPIKE_GEMINI_KEY が未設定");
    } else {
      await openAiPanel(driver);
      await driver.page.getByTestId("ai-key-input-gemini-public").fill(GEMINI_KEY);
      await driver.page.getByTestId("ai-key-save-gemini-public").click();
      await driver.page.waitForFunction(() => !document.querySelector('[data-testid="ai-test-gemini-public-image-to-text"]')?.hasAttribute("disabled"));
      const rg = await runTest(driver, "gemini-public", CAP);
      check(isGood(rg.verdict), "実 Gemini の接続テストが到達する（§12 の『未確認』が閉じる）", rg.verdict);
      check(!rg.text.includes(GEMINI_KEY), "🔴 結果表示に鍵が出ない");
      await driver.page.screenshot({ path: path.join(OUT_DIR, "5-gemini.png") });
      await driver.page.getByTestId("ai-key-clear-gemini-public").click(); // 検査用の鍵を残さない
    }
  } finally {
    await driver.stop();
    fake.server.close();
    for (const f of ["ai-providers.json", "secrets.enc.json"]) {
      if (dataDir && fs.existsSync(path.join(dataDir, f))) fs.rmSync(path.join(dataDir, f));
    }
  }
  const failed = summary();
  console.log(`未達 ${pending.length} 件: ${pending.join(" / ")}`);
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed, pending }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/*
 * 外部 AI ゲートウェイ（H40 / H41）の実機検証スパイク。設計: fw/art-of-imaging-design.md。
 *
 * 実行:  cd automator && npx tsx src/spike/artCheck.ts
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend ＋ 本物のプラグイン配信経路）:
 *   1. ai-egress を宣言していないプラグインは **同意ダイアログを出す前に** permission-denied で弾かれる
 *   2. 宣言しているプラグインには host.ai / host.file が渡る
 *   3. 鍵が未設定なら、同意を求める前に no-api-key で止まる（無駄な同意を取らない）
 *   4. 鍵を入れると同意ダイアログが出る。**送る画像とプロンプト全文**が表示される
 *   5. 確認チェックを入れるまで送信ボタンは押せない
 *   6. 取り消すと canceled が返り、**送信は起きない**
 *   7. 設定画面でキーを保存すると「設定済み」になり、GET /api/settings には**含まれない**
 *   8. 保存した秘密ファイルが**平文でない**
 *
 * ⚠ 実際に Gemini を叩くところまでは行かない。課金と外部依存を自動検証に持ち込まないため。
 *   実際の生成は手動（fw/art-of-imaging-design.md §9）で確かめること。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）と
 *       fixture ct-basic（`npx tsx src/cli.ts check-fixtures`）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

interface Probe {
  started?: boolean;
  pluginId?: string;
  hasAi?: boolean;
  hasFile?: boolean;
  pending?: boolean;
  outcome?: { ok: boolean; error?: string };
}

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "art-check");
const PLUGIN_IDS = ["ai-egress-check", "ai-egress-denied"];
/** 本物のキーは使わない。ゲートの検証に必要なのは「入っている」という状態だけ。 */
const DUMMY_KEY = "AUTOMATOR-DUMMY-KEY-NOT-A-REAL-CREDENTIAL";
const SECRET_FILE = path.join(DESKTOP_RUN_DATA_DIR, "secrets.enc.json");

function installVerificationPlugins(): void {
  for (const id of PLUGIN_IDS) {
    const src = path.join(AUTOMATOR_ROOT, "plugins", id);
    const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", id);
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) fs.copyFileSync(path.join(src, name), path.join(dst, name));
    console.log(`検証用プラグインを配置: ${dst}`);
  }
}

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

/** プラグインを起動し、window に置かれた結果を読む。 */
async function runProbe(page: Page, pluginId: string, globalName: string, waitForOutcome: boolean): Promise<Probe> {
  await page.evaluate((name) => {
    delete (window as unknown as Record<string, unknown>)[name];
  }, globalName);
  await page.getByTestId("viewer2d-menu-plugins").click();
  await page.getByTestId(`plugin-item-${pluginId}`).click();
  if (waitForOutcome) {
    await page.waitForFunction(
      (name) => (window as unknown as Record<string, Probe>)[name]?.outcome !== undefined,
      globalName,
      { timeout: 20_000 },
    );
  } else {
    await page.waitForFunction(
      (name) => (window as unknown as Record<string, Probe>)[name]?.started === true,
      globalName,
      { timeout: 20_000 },
    );
  }
  return page.evaluate((name) => (window as unknown as Record<string, Probe>)[name], globalName) as Promise<Probe>;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(SECRET_FILE, { force: true });
  installVerificationPlugins();

  const driver = new DesktopDriver();
  const recorder = createStepRecorder();
  await driver.start();
  let viewerPage: Page | null = null;
  try {
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");

    const mainPage = driver.page;
    mainPage.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
    });
    try {
      await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      await mainPage.reload({ waitUntil: "domcontentloaded" });
      await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    }

    // --- 1. 鍵を入れる前の状態を見る ---
    console.log("\n[1] 権限の強制（鍵なし）");
    await openFirstSeriesInViewer(mainPage, recorder);
    viewerPage = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewerPage.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 15_000 });
    await viewerPage.waitForTimeout(2000);

    const denied = await runProbe(viewerPage, "ai-egress-denied", "__aiEgressDenied", true);
    check(denied.hasAi === true, "権限が無くても host.ai は渡る（拒否は呼び出し時）", denied.hasAi);
    check(
      denied.outcome?.error === "permission-denied",
      "🔴 ai-egress 未宣言のプラグインは permission-denied で弾かれる",
      denied.outcome,
    );
    check(
      (await viewerPage.getByTestId("ai-egress-consent").count()) === 0,
      "🔴 権限が無いときは同意ダイアログを出さない（同意を取る前に弾く）",
    );

    const noKey = await runProbe(viewerPage, "ai-egress-check", "__aiEgressCheck", true);
    check(noKey.hasAi === true && noKey.hasFile === true, "ai / file の両ホスト API が渡る", noKey);
    check(
      noKey.outcome?.error === "no-api-key",
      "🔴 鍵が無ければ同意を求める前に no-api-key で止まる",
      noKey.outcome,
    );
    check(
      (await viewerPage.getByTestId("ai-egress-consent").count()) === 0,
      "鍵が無いときも同意ダイアログは出ない",
    );

    // --- 2. 設定画面で鍵を入れる ---
    console.log("\n[2] 鍵の保存（環境設定 ＞ 外部 AI）");
    await mainPage.getByTestId("mainscreen-menu-system").click();
    await mainPage.getByTestId("menu-item-settings").click();
    await mainPage.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await mainPage.getByTestId("settings-cat-ai").click();
    await mainPage.getByTestId("ai-panel").waitFor({ state: "visible", timeout: 10_000 });
    await mainPage.getByTestId("ai-key-input").fill(DUMMY_KEY);
    await mainPage.getByTestId("ai-key-save").click();
    await mainPage.getByTestId("ai-key-state").waitFor({ state: "visible" });
    await mainPage.waitForTimeout(500);
    const stateText = (await mainPage.getByTestId("ai-key-state").textContent()) ?? "";
    check(/設定済み|Configured/.test(stateText), "鍵を保存すると『設定済み』になる", stateText);
    await mainPage.screenshot({ path: path.join(OUT_DIR, "2-ai-panel.png") });

    // 🔴 設定 API に鍵が載っていないこと。ここが漏れると全部が無意味になる。
    const settings = await (await fetch(`http://localhost:${driver.ports.http}/api/settings`)).text();
    check(!settings.includes(DUMMY_KEY), "🔴 GET /api/settings に鍵が含まれない", settings.length);

    // 🔴 ディスク上でも平文でないこと。
    const onDisk = fs.existsSync(SECRET_FILE) ? fs.readFileSync(SECRET_FILE, "utf8") : "";
    check(onDisk.length > 0, "秘密ファイルが作られる", SECRET_FILE);
    check(!onDisk.includes(DUMMY_KEY), "🔴 秘密ファイルが平文でない", onDisk.slice(0, 80));

    await mainPage.getByTestId("dialog-close-button").click();

    // --- 3. 同意ダイアログ ---
    console.log("\n[3] 送信前の同意");
    await viewerPage.evaluate(() => {
      delete (window as unknown as Record<string, unknown>).__aiEgressCheck;
    });
    await viewerPage.getByTestId("viewer2d-menu-plugins").click();
    await viewerPage.getByTestId("plugin-item-ai-egress-check").click();

    const consent = viewerPage.getByTestId("ai-egress-consent");
    await consent.waitFor({ state: "visible", timeout: 20_000 });
    check(true, "🔴 鍵があると同意ダイアログが出る");

    const host = (await viewerPage.getByTestId("ai-egress-host").textContent()) ?? "";
    check(host.includes("generativelanguage.googleapis.com"), "宛先ホストが表示される", host);
    const prompt = (await viewerPage.getByTestId("ai-egress-prompt").textContent()) ?? "";
    check(prompt.includes("AUTOMATOR PROBE"), "🔴 プロンプト全文が表示される", prompt.slice(0, 60));
    check(
      (await viewerPage.getByTestId("ai-egress-image").count()) === 1,
      "🔴 送信する画像そのものが表示される",
    );
    check(
      await viewerPage.getByTestId("ai-egress-send").isDisabled(),
      "🔴 確認チェックを入れるまで送信ボタンは押せない",
    );
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "3-consent.png") });

    await viewerPage.getByTestId("ai-egress-ack").check();
    check(
      !(await viewerPage.getByTestId("ai-egress-send").isDisabled()),
      "確認チェックを入れると送信ボタンが押せる",
    );

    // 取り消す。**ここで送信が起きないこと**が本題。
    await viewerPage.getByTestId("ai-egress-cancel").click();
    await consent.waitFor({ state: "detached", timeout: 10_000 });
    await viewerPage.waitForFunction(
      () => (window as unknown as Record<string, Probe>).__aiEgressCheck?.outcome !== undefined,
      undefined,
      { timeout: 10_000 },
    );
    const cancelled = await viewerPage.evaluate(
      () => (window as unknown as Record<string, Probe>).__aiEgressCheck,
    );
    check(cancelled.outcome?.error === "canceled", "🔴 取り消すと canceled が返る（送信しない）", cancelled.outcome);
  } finally {
    await viewerPage?.close().catch(() => {});
    await driver.stop();
  }

  console.log("\n=== 結果 ===");
  if (failures.length === 0) {
    console.log(`${passed} 項目すべて OK。スクリーンショット: ${OUT_DIR}`);
  } else {
    console.log(`FAIL ${failures.length} 件:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();

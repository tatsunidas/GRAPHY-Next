/*
 * 自動更新の画面（更新ダイアログ・Help メニュー）の実機検証。実際の Electron・偽のリリースサーバー・実際の minisign の署名。
 * 起動時の更新確認でダイアログが出るところから、実際にボタンを押して確かめる（描画が出ていることではなく、操作が効くことを見る）。
 *
 * 実行:  cd automator && npx tsx src/spike/appUpdateUiCheck.ts
 * 前提: backend/target/graphy-next-backend.jar（今のビルド）、minisign（CLI）、Linux。結果のスクリーンショット:
 *       automator/.results/app-update-ui-check/*.png
 *
 *   起動 A: 既定のまま（押さない）→ ダウンロードしない／後で・スキップ／進捗と中止／中身の差し替え・署名の不正（失敗の表示）
 *   起動 B: 署名の無い版 → 「今すぐ」「終了時」が出ない（通知のみ。ダウンロードページを開く）
 *   起動 C: 終了時 → 進捗 → 準備完了の表示、閉じても Help メニューに状態が出る → 終了で入れ替わる
 *   起動 D: 今すぐ → 再起動中の表示 → アプリが終了し、入れ替わって新しい AppImage が起動される
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";
import { createFakeRelease, OLD_CONTENT, type FakeMode } from "./appUpdateFake.js";

const { check, summary } = createChecker();
const ROOT = path.resolve(AUTOMATOR_ROOT, "..");
const PORTS = { http: 18660, scp: 18661, vite: 18663 };
const FAKE_PORT = 18665;
const OUT = path.join(AUTOMATOR_ROOT, ".results", "app-update-ui-check");
const fake = createFakeRelease(ROOT, FAKE_PORT);

let launchNo = 0;
async function launch(appImage: string): Promise<DesktopDriver> {
  const userData = path.join(fake.dir, `userdata-${++launchNo}`); // 起動ごとに専用（スキップ設定・保留印が混ざらない）
  fs.mkdirSync(userData, { recursive: true });
  const d = new DesktopDriver(PORTS, {
    extraElectronArgs: [`--user-data-dir=${userData}`],
    extraEnv: { GRAPHY_UPDATE_API_BASE: fake.base, GRAPHY_UPDATE_TRUSTED_KEY: fake.pubKey, APPIMAGE: appImage },
  });
  await d.start();
  return d;
}

const tid = (p: Page, id: string) => p.getByTestId(id);
const visible = async (p: Page, id: string, ms = 20_000): Promise<boolean> =>
  tid(p, id).first().waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);
const gone = async (p: Page, id: string, ms = 10_000): Promise<boolean> =>
  tid(p, id).first().waitFor({ state: "hidden", timeout: ms }).then(() => true, () => false);
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
const text = async (p: Page, id: string) => (await tid(p, id).first().innerText().catch(() => "")).trim();

/** Help メニューから「更新を確認」を押す（手動確認）。 */
async function helpUpdate(p: Page): Promise<void> {
  await tid(p, "mainscreen-menu-help").click();
  await tid(p, "menu-item-update").click();
}

async function main(): Promise<void> {
  if (process.platform !== "linux") { console.log("  [未達] Linux 専用（AppImage の入れ替えを見る）"); process.exitCode = 2; return; }
  fs.mkdirSync(OUT, { recursive: true });
  await fake.start();
  try {
    // ── 起動 A ──
    const appA = fake.freshOldAppImage();
    let d = await launch(appA);
    try {
      const p = d.page;
      console.log("\n[A1] 起動時の更新確認で、ダイアログが出る。既定のまま（押さない）ではダウンロードしない");
      check(await visible(p, "update-dialog"), "更新ダイアログが出た（起動時の確認）");
      check((await tid(p, "update-dialog").getAttribute("data-view")) === "result", "最初は結果の画面（進行の画面ではない）");
      for (const id of ["update-now", "update-on-quit", "update-later", "update-skip"]) check(await visible(p, id, 2000), `ボタン ${id} がある`);
      check(/v0\./.test(await tid(p, "update-dialog").innerText()), "現在→最新の版が見える");
      await shot(p, "A1-dialog");
      await p.waitForTimeout(3000);
      check(fake.assetHits() === 0, "押さない限り、資産を 1 回も取りに行かない（勝手に始まらない）", fake.hits);

      console.log("\n[A2] 「後で」で閉じる → Help メニューは通常の表示のまま");
      await tid(p, "update-later").click();
      check(await gone(p, "update-dialog"), "ダイアログが閉じた");
      await tid(p, "mainscreen-menu-help").click();
      check(!/（/.test(await text(p, "menu-item-update")), "メニューに状態の括弧が付いていない", await text(p, "menu-item-update"));
      await p.keyboard.press("Escape");
      await p.mouse.click(5, 5);

      console.log("\n[A3] ゆっくり配信: 「終了時に更新」→ 進捗が出る → 「中止」で止まる");
      fake.mode = "slow"; fake.hits.length = 0;
      await helpUpdate(p);
      check(await visible(p, "update-on-quit"), "手動確認でダイアログが出た");
      await tid(p, "update-on-quit").click();
      check(await visible(p, "update-progress"), "進捗バーが出た");
      await p.waitForTimeout(1200);
      const status1 = await text(p, "update-status");
      console.log(`  状態: ${status1}`);
      check(/ダウンロード中|Downloading/.test(status1) && /%/.test(status1) && /MB/.test(status1), "「ダウンロード中 NN%（x MB / y MB）」が出る", status1);
      await shot(p, "A3-progress");
      await tid(p, "update-cancel").click();
      check(await visible(p, "update-close"), "中止後に「閉じる」だけが残る");
      check(/中止|cancel/i.test(await text(p, "update-status")), "「中止しました」の表示", await text(p, "update-status"));
      check(fs.readFileSync(appA, "utf8") === OLD_CONTENT, "旧版は無傷");
      await shot(p, "A3-cancelled");
      await tid(p, "update-close").click();
      check(await gone(p, "update-dialog"), "閉じられる");

      console.log("\n[A4] 中身の差し替え（API の digest はそのまま）→ 失敗の表示・今の版のまま");
      fake.mode = "tamper"; fake.hits.length = 0;
      await helpUpdate(p);
      await tid(p, "update-on-quit").click();
      check(await visible(p, "update-failed-message"), "失敗の表示が出た");
      check((await tid(p, "update-failed-message").getAttribute("data-reason")) === "digest-mismatch", "理由は digest-mismatch");
      check(/確認.*失敗|failed verification/.test(await text(p, "update-failed-message")), "検証の失敗として説明される", await text(p, "update-failed-message"));
      check(/今の版のまま|keep using/.test(await text(p, "update-failed-message")), "「今の版のまま使えます」と伝える");
      check(await visible(p, "update-open-page", 2000), "「ダウンロードページを開く」が出る");
      await shot(p, "A4-failed-digest");
      await tid(p, "update-close").click();
      check(await gone(p, "update-dialog"), "閉じられる");
      check(fs.readFileSync(appA, "utf8") === OLD_CONTENT, "旧版は無傷");

      console.log("\n[A5] 中身と digest をそろって差し替え（GitHub 側の改ざん）→ 署名で拒否される");
      fake.mode = "tamperSigned";
      await helpUpdate(p);
      await tid(p, "update-now").click();
      check(await visible(p, "update-failed-message"), "失敗の表示が出た（今すぐでも、検証に失敗したら終了しない）");
      check((await tid(p, "update-failed-message").getAttribute("data-reason")) === "signature-bad-signature", "理由は signature-bad-signature");
      await shot(p, "A5-failed-signature");
      await tid(p, "update-close").click();
      check(await gone(p, "update-dialog"), "閉じられる");

      console.log("\n[A6] 途中で接続が切れる → ネットワーク断の表示で見送り");
      fake.mode = "cutoff";
      await helpUpdate(p);
      await tid(p, "update-on-quit").click();
      check(await visible(p, "update-failed-message"), "失敗の表示が出た");
      check((await tid(p, "update-failed-message").getAttribute("data-reason")) === "network", "理由は network");
      check(/インターネットが切れ|connection was lost/.test(await text(p, "update-failed-message")), "「インターネットが切れたため見送り」と伝える", await text(p, "update-failed-message"));
      await shot(p, "A6-failed-network");
      await tid(p, "update-close").click();
      check(fs.readFileSync(appA, "utf8") === OLD_CONTENT, "旧版は無傷");
    } finally {
      await d.stop();
    }

    // ── 起動 B: 署名の無い版 ──
    console.log("\n[B] 署名の無い版: 自動更新の対象外（通知のみ）");
    fake.mode = "noSig" as FakeMode; fake.hits.length = 0;
    d = await launch(fake.freshOldAppImage());
    try {
      const p = d.page;
      check(await visible(p, "update-dialog"), "更新ダイアログが出た");
      check((await tid(p, "update-now").count()) === 0 && (await tid(p, "update-on-quit").count()) === 0, "「今すぐ」「終了時」は出ない");
      check(await visible(p, "update-open-page", 2000), "「ダウンロードページを開く」が主のボタン");
      check(/インストーラをダウンロードして実行|Download and run the installer/.test(await tid(p, "update-dialog").innerText()), "今までどおりの案内文");
      await shot(p, "B-notify-only");
    } finally {
      await d.stop();
    }

    // ── 起動 C: 終了時 ──
    console.log("\n[C] 終了時: 進捗 → 準備完了 → 閉じても Help メニューに状態 → 終了で入れ替わる");
    fake.mode = "normal"; fake.hits.length = 0;
    const appC = fake.freshOldAppImage();
    fs.rmSync(fake.marker, { force: true });
    d = await launch(appC);
    try {
      const p = d.page;
      check(await visible(p, "update-on-quit"), "ダイアログが出た");
      await tid(p, "update-on-quit").click();
      await p.waitForFunction(() => /準備ができました|is ready/.test(document.querySelector('[data-testid="update-status"]')?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
      check(/更新の準備ができました|update is ready/i.test(await text(p, "update-status")), "「更新の準備ができました（終了時に更新）」", await text(p, "update-status"));
      await shot(p, "C-ready");
      check(fs.readFileSync(appC, "utf8") === OLD_CONTENT, "終了するまでは旧版のまま");
      await tid(p, "update-close").click();
      check(await gone(p, "update-dialog"), "閉じられる");
      await tid(p, "mainscreen-menu-help").click();
      const label = await text(p, "menu-item-update");
      check(/終了時に更新|updates on quit/.test(label), "閉じても Help メニューに「終了時に更新」と出る", label);
      await shot(p, "C-menu");
      await tid(p, "menu-item-update").click();
      check(await visible(p, "update-status", 5000) && /準備ができました|is ready/.test(await text(p, "update-status")), "メニューから開くと、確認し直さずに準備完了の画面が出る");
      await tid(p, "update-close").click();
      await d.app.evaluate(({ app }) => { app.quit(); });
      const end = Date.now() + 30_000;
      while (Date.now() < end && fs.readFileSync(appC, "utf8") === OLD_CONTENT) await new Promise((r) => setTimeout(r, 200));
      check(fs.readFileSync(appC).equals(fake.asset), "終了で AppImage が新しい中身に入れ替わった");
      await new Promise((r) => setTimeout(r, 1500));
      check(!fs.existsSync(fake.marker), "終了時の更新では再起動しない");
    } finally {
      await d.stop();
    }

    // ── 起動 D: 今すぐ ──
    console.log("\n[D] 今すぐ: 再起動中の表示 → アプリが終了 → 入れ替わり、新しい AppImage が起動される");
    fake.hits.length = 0;
    const appD = fake.freshOldAppImage();
    fs.rmSync(fake.marker, { force: true });
    d = await launch(appD);
    try {
      const p = d.page;
      check(await visible(p, "update-now"), "ダイアログが出た");
      await tid(p, "update-now").click();
      const end = Date.now() + 40_000;
      while (Date.now() < end && !fs.existsSync(fake.marker)) await new Promise((r) => setTimeout(r, 250));
      check(fs.existsSync(fake.marker), "新しい AppImage が起動された（目印のファイルが書かれた）");
      check(fs.readFileSync(appD).equals(fake.asset), "AppImage が新しい中身に入れ替わった");
    } finally {
      await d.stop();
    }
  } finally {
    fake.stop();
  }
}

main()
  .then(() => process.exit(process.exitCode || (summary() === 0 ? 0 : 1)))
  .catch((e) => { console.error(e); process.exit(2); });

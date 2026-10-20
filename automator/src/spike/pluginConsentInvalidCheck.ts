/*
 * 同意画面で、署名が invalid の配布物は「導入する」を押せず理由が出ること（と、そうでないものは従来どおり押せること）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/pluginConsentInvalidCheck.ts
 * 前提:  backend jar、frontend・desktop・automator の npm ci。
 *
 * ⚠ renderer への `/api/plugin-manager/inspect/github` の応答だけを Playwright の route で差し替えている（検査用の実 Release が
 *   無いため）。確かめるのは画面（ボタンの有効無効・理由の表示）で、backend が invalid を返すこと・実導入を拒否することは
 *   通し検査 `pluginThirdPartyCheck.ts`（実 GitHub・実 backend）で確かめている。
 *
 * 結果は 合格 / 失敗 / 未達 に分けて数える。
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "plugin-consent-invalid-check");
const PORTS = { http: 19590, scp: 19591, vite: 19593 };
const base = `http://localhost:${PORTS.http}`;
const { check, summary } = createChecker();
const pending: string[] = [];
function pend(label: string, why: string): void {
  console.log(`  [未達] ${label} — ${why}`);
  pending.push(label);
}

/** PluginPreview（frontend/src/plugins/pluginManagerApi.ts）の全項目を埋めた応答。 */
function preview(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "fake-plugin", name: "Fake Plugin", version: "1.0.0", description: "応答差し替えの検査用", author: "spike", homepage: null,
    license: "MIT", sourceType: "github", sourceRef: "owner/fake-plugin", trust: "community",
    sha256: "0".repeat(64), integrityVerified: true, hasUi: true, jars: [], files: ["plugin.json", "ui.js"], totalBytes: 1234,
    permissions: [], graphyOk: true, graphyRange: ">=0.1.0", coreVersion: "0.5.0", osOk: true, declaredOs: [], currentOs: "linux",
    alreadyInstalled: false, installable: true, signature: "first-use", signerKeyId: "5E0F9AAFBDA930EB", signatureComment: null,
    signatureProblem: null, autoInstallable: false, ...over,
  };
}

async function ensureOptIn(driver: DesktopDriver): Promise<void> {
  const st = (await (await fetch(`${base}/api/plugin-manager/status`)).json()) as { installEnabled: boolean };
  if (st.installEnabled) return;
  await driver.app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync; // 「許可する」
  });
  const ok = await driver.page.evaluate(() =>
    (window as unknown as { graphyDesktop: { pluginInstallOptIn: (b: boolean) => Promise<{ ok: boolean }> } })
      .graphyDesktop.pluginInstallOptIn(true).then((r) => r.ok));
  if (!ok) throw new Error("opt-in failed");
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver(PORTS);
  try {
    await driver.start();
    await driver.page.reload({ waitUntil: "domcontentloaded" });
    await ensureOptIn(driver);
    const page = driver.page;

    let next: Record<string, unknown> = preview({});
    await page.route("**/api/plugin-manager/inspect/github", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(next) }));

    async function open(): Promise<void> {
      await page.getByTestId("mainscreen-menu-system").click();
      await page.getByTestId("menu-item-settings").click();
      await page.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
      await page.getByTestId("settings-cat-plugins").click();
      await page.getByTestId("pluginmgr-tab-manual").click();
    }
    async function showDialog(): Promise<void> {
      await page.getByPlaceholder(/owner\/repo/).fill("owner/fake-plugin");
      await page.getByRole("button", { name: /GitHub/ }).click();
      await page.getByTestId("plugin-consent-dialog").waitFor({ state: "visible", timeout: 10_000 });
    }
    async function closeDialog(): Promise<void> {
      await page.getByTestId("plugin-consent-cancel").click();
      await page.getByTestId("plugin-consent-dialog").waitFor({ state: "detached", timeout: 5_000 });
    }
    const confirm = () => page.getByTestId("plugin-consent-confirm");
    // 背面の設定画面にも導入許可のチェックがあるので、同意画面の中に絞る
    const ackBox = () => page.getByTestId("plugin-consent-dialog").getByRole("checkbox");
    const blockedNote = () => page.getByTestId("plugin-consent-sig-blocked");

    await open();

    console.log("\n[対照] 署名が first-use（初めての鍵）");
    next = preview({ signature: "first-use" });
    await showDialog();
    check(await confirm().isEnabled(), "「導入する」が押せる（同意画面の検出とボタンの判定が効いている）");
    check((await blockedNote().count()) === 0, "署名の理由の注意は出ない");
    await page.screenshot({ path: path.join(OUT_DIR, "1-first-use.png") });
    await closeDialog();

    console.log("\n[本題] 署名が invalid");
    next = preview({ signature: "invalid", signatureProblem: "signed by a different key than the installed version (expected 5E0F9AAFBDA930EB)" });
    await showDialog();
    check(await confirm().isDisabled(), "🔴 「導入する」が押せない");
    check(await blockedNote().isVisible(), "🔴 押せない理由が画面に出る");
    const dialogText = (await page.getByTestId("plugin-consent-dialog").textContent()) ?? "";
    check(dialogText.includes("different key"), "署名の項に backend の理由が出ている", dialogText.slice(0, 200));
    await page.screenshot({ path: path.join(OUT_DIR, "2-invalid.png") });
    await closeDialog();

    console.log("\n[本題] 署名が invalid で、完全性も確認できない");
    next = preview({ signature: "invalid", integrityVerified: false, signatureProblem: "tampered" });
    await showDialog();
    check(await confirm().isDisabled(), "🔴 「導入する」が押せない");
    check((await ackBox().count()) === 0, "🔴 「承知のうえで導入」のチェックは出ない（承知しても入れられない）");
    await closeDialog();

    console.log("\n[従来どおり] 署名なし・完全性を確認できない");
    next = preview({ signature: "unsigned", integrityVerified: false, signerKeyId: null });
    await showDialog();
    check(await confirm().isDisabled(), "承知のチェックを入れるまで押せない");
    check((await ackBox().count()) === 1, "（前提）承知のチェックは同意画面に 1 つ出ている");
    await ackBox().check();
    check(await confirm().isEnabled(), "承知のチェックを入れると押せる（従来の動作が変わっていない）");
    check((await blockedNote().count()) === 0, "署名の理由の注意は出ない");
    await closeDialog();
  } finally {
    await driver.stop().catch(() => {});
  }

  pend("Windows・macOS 実機", "Linux 機のみで実行した");
  pend("応答を差し替えない実 backend 経由の画面確認", "invalid を返せる実 Release が今は無い（backend の invalid は pluginThirdPartyCheck.ts で確認済み）");
  const failed = summary();
  console.log(`未達 ${pending.length} 件: ${pending.join(" / ")}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

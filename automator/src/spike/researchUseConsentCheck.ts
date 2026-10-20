/*
 * 起動時の利用条件の同意（研究用・非診断）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/researchUseConsentCheck.ts
 * 前提:  backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）、frontend・automator の npm ci。
 *
 * 確かめること（本物の backend ＋ Vite ＋ Chromium）:
 *   1. 同意済み（driver が事前投入）なら出ない — 他の検査が止まらないことの根拠（正例側）
 *   2. 記録を消すと出る。全面を覆い、Esc・背景クリックでは閉じない（負例側）
 *   3. 「同意して使う」で閉じ、GET /api/settings に版つきの記録が出る。再読み込みで出ない
 *   4. 古い版（0）の記録なら再び出る
 *   5. Help の「利用条件」は同意済みでも開き、同意ボタンは無く、閉じられる
 * 未達: 公開デモ機（sessionStorage の経路）、デスクトップの「同意しない」でウィンドウが閉じること。
 */
import fs from "node:fs";
import path from "node:path";

import { WebDriver } from "../driver/webDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "research-use-consent-check");
const KEY = "legal.researchUseConsent";
const { check, summary } = createChecker();

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new WebDriver({ http: 19390, scp: 19391, vite: 19393 }, { viewport: { width: 1280, height: 800 }, locale: "ja-JP" });
  const base = `http://localhost:${driver.ports.http}`;
  const putKey = async (value: string) => {
    const r = await fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ [KEY]: value }) });
    if (!r.ok) throw new Error(`PUT /api/settings: HTTP ${r.status}`);
  };
  const getKey = async (): Promise<string | undefined> => {
    const r = await fetch(`${base}/api/settings`);
    if (!r.ok) throw new Error(`GET /api/settings: HTTP ${r.status}`);
    return ((await r.json()) as Record<string, string>)[KEY];
  };
  try {
    await driver.start();
    const page = driver.page;
    const dlg = page.getByTestId("research-use-consent");
    const reload = async () => {
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
    };

    await page.waitForTimeout(2500); // 判定は非同期（status → settings）。出るなら出ている時間を取る
    check((await dlg.count()) === 0, "1. 同意済みなら出ない");
    check((await getKey()) !== undefined, "1. 事前投入の記録が実在する（出ないことの前提）");

    await putKey("");
    await reload();
    await dlg.waitFor({ timeout: 15_000 }).catch(() => {});
    check((await dlg.count()) === 1, "2. 記録が無いと出る");
    await page.screenshot({ path: path.join(OUT_DIR, "consent.png") });
    const covers = await page.evaluate(() => !!document.elementFromPoint(5, 5)?.closest('[data-testid="research-use-consent"]') || document.elementFromPoint(5, 5)?.firstElementChild?.getAttribute("data-testid") === "research-use-consent");
    check(covers, "2. 画面全体を覆う（左上の点がダイアログの層に当たる）");
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    check((await dlg.count()) === 1, "2. Esc・背景クリックでは閉じない");
    check((await page.getByRole("button", { name: "閉じる" }).count()) === 0, "2. 閉じるボタンが無い");

    await page.getByTestId("research-use-consent-accept").click();
    await dlg.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    check((await dlg.count()) === 0, "3. 同意すると閉じる");
    const rec = JSON.parse((await getKey()) ?? "{}") as { version?: number; acceptedAt?: string };
    check(rec.version === 1 && !Number.isNaN(Date.parse(rec.acceptedAt ?? "")), "3. 版と日時つきの記録が設定に出る", rec);
    await reload();
    await page.waitForTimeout(2500);
    check((await dlg.count()) === 0, "3. 再読み込みで出ない");

    await putKey(JSON.stringify({ version: 0, acceptedAt: "2020-01-01T00:00:00Z" }));
    await reload();
    await dlg.waitFor({ timeout: 15_000 }).catch(() => {});
    check((await dlg.count()) === 1, "4. 古い版の記録なら再び出る");
    await page.getByTestId("research-use-consent-accept").click();
    await dlg.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});

    await page.getByText("ヘルプ", { exact: true }).first().click();
    await page.getByText("利用条件（研究用・非診断）", { exact: true }).click();
    await dlg.waitFor({ timeout: 10_000 }).catch(() => {});
    check((await dlg.count()) === 1, "5. Help の「利用条件」で同意済みでも開く");
    check((await page.getByTestId("research-use-consent-accept").count()) === 0, "5. 読み取り専用（同意ボタンが無い）");
    await page.screenshot({ path: path.join(OUT_DIR, "terms.png") });
    await dlg.getByRole("button", { name: "閉じる" }).last().click();
    check((await dlg.count()) === 0, "5. 閉じられる");

    console.log("  [未達] 公開デモ機（sessionStorage の経路）— デモ機が必要");
    console.log("  [未達] デスクトップ版で「同意しない」がウィンドウを閉じること — 実機確認");
  } finally {
    await driver.stop();
  }
}

await main();
process.exitCode = summary() > 0 ? 1 : 0;

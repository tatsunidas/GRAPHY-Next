/*
 * v0.6.3 操作ガイド: v0.6.1 からの変更のうち、画面で見せられるもの。
 *   ① NIfTI で書き出し（［ファイル］メニュー）
 *   ② DICOM 通信先の［通信テスト］と［検索の詳細］、Q/R のエラー表示
 *   ③ 事前取得の設定画面
 * ②は、偽の Q/R SCP を 2 つ起動しておく（backend の test の FakeQrScpMain。test-compile 後に test-classes＋依存の classpath で）:
 *   19424 RELAYSERVER DROP_ON_KEYS NumberOfStudyRelatedSeries,NumberOfStudyRelatedInstances false   （検索の返却項目を減らさないと切られる相手）
 *   19425 PACS-B NORMAL 0 true GRAPHYNEXT                                                           （何も変えずに通る相手）
 * データ: ~/graphy_sample_images/HCC_001（GRAPHY_GUIDE_DATA で指す）。通信先は 127.0.0.1 の偽の相手（患者情報なし）。
 */
import fs from "node:fs";
import path from "node:path";

import { AUTOMATOR_ROOT } from "../../fixtures/manifest.js";
import type { Scenario } from "../run.js";
import { dismissStartupDialogs } from "../../common/dismissDialogs.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const scenario: Scenario = async ({ main, shot }) => {
  const put = (kv: Record<string, string>) =>
    main.evaluate(async (body) => {
      const r = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`settings PUT ${r.status}`);
    }, kv);
  const failed: string[] = [];
  const step = async (name: string, f: () => Promise<void>) => {
    try { await f(); } catch (e) {
      const dbg = path.join(AUTOMATOR_ROOT, ".results", "guide-v0.6.3");
      fs.mkdirSync(dbg, { recursive: true });
      await main.screenshot({ path: path.join(dbg, `fail-${name}.png`) }).catch(() => undefined);
      failed.push(`${name}: ${String(e).split("\n")[0]}`); console.log(`🔴 ${name}: ${String(e).split("\n")[0]}`);
    }
  };

  await main.evaluate(() => { try { localStorage.setItem("graphy.locale", "ja"); } catch { /* */ } });

  // ① NIfTI で書き出し
  await step("nifti", async () => {
    // スタディ行を押した直後に一覧が自動で再読込されると、開いたシリーズ一覧が閉じることがある。見えるまで押し直す。
    await dismissStartupDialogs(main);
    await main.getByTestId("search-patientid-input").fill("HCC_001");
    await main.getByTestId("search-allperiod-chip").click();
    await main.getByTestId("search-submit-button").click();
    const studyRow = main.locator('[data-testid^="study-row-"]').first();
    const seriesRow = main.locator('[data-testid^="series-row-"]', { hasText: "PRE LIVER" }).first();
    await studyRow.waitFor({ state: "visible", timeout: 20_000 });
    for (let i = 0; i < 4 && !(await seriesRow.isVisible()); i++) {
      await studyRow.click();
      await sleep(1500);
    }
    await seriesRow.click({ timeout: 20_000 });
    // 切り分け: プレビューの「ズーム NaN%」が、読み込み後も残るかを見る（ガイドの画面ではなく、不具合の確認）
    await sleep(8000);
    const zoomText = await main.evaluate(() => /ズーム\s*([^\s]+)/.exec(document.body.innerText)?.[1] ?? "(なし)");
    console.log(`プレビューのズーム表示（8 秒後）: ${zoomText}`);
    await main.getByRole("button", { name: /プレビューを隠す/ }).click().catch(() => undefined);
    await sleep(500);
    await main.getByTestId("mainscreen-menu-file").click();
    const item = main.getByTestId("menu-item-nifti-export");
    await item.waitFor({ state: "visible" });
    await shot(main, "nifti-menu", [item]);
    await item.click();
    const msg = main.getByTestId("nifti-export-msg");
    await main.waitForFunction(() => /書き出しました|書き出せませんでした/.test(document.querySelector('[data-testid="nifti-export-msg"]')?.textContent ?? ""), null, { timeout: 120_000 });
    const text = (await msg.innerText()).trim();
    console.log(`NIfTI: ${text}`);
    if (!/書き出しました/.test(text)) throw new Error(text);
    await shot(main, "nifti-done", [msg]);
  });

  // ② DICOM 通信先
  await put({
    "dicom.remoteAes": JSON.stringify([
      { aeTitle: "RELAYSERVER", host: "127.0.0.1", port: 19424, tls: false },
      { aeTitle: "PACS-B", host: "127.0.0.1", port: 19425, tls: false },
    ]),
  });
  await main.goto(main.url().split("#")[0] + "#qr", { waitUntil: "domcontentloaded" });
  await main.reload({ waitUntil: "domcontentloaded" });
  await step("qr-error", async () => {
    await main.waitForFunction(() => /返事をせずに接続を切りました/.test(document.body.innerText), null, { timeout: 60_000 });
    await main.getByRole("button", { name: /RELAYSERVER/ }).first().click().catch(() => undefined);
    await sleep(600);
    await shot(main, "qr-error", [main.getByText(/返事をせずに接続を切りました/).first()]);
  });

  await main.goto(main.url().split("#")[0], { waitUntil: "domcontentloaded" });
  await dismissStartupDialogs(main);
  const openSettings = async (cat: string) => {
    await main.getByTestId("mainscreen-menu-system").click();
    await main.getByTestId("menu-item-settings").click();
    await main.getByTestId(`settings-cat-${cat}`).click();
  };
  await step("probe", async () => {
    await openSettings("dicomSend");
    await main.getByTestId("probe-open-0").click();
    await main.getByTestId("probe-start").click();
    await main.getByTestId("probe-summary").waitFor({ state: "visible", timeout: 150_000 });
    await sleep(500);
    await shot(main, "probe-result", [
      { at: main.getByTestId("probe-row-echo"), side: "left" }, { at: main.getByTestId("probe-row-find"), side: "left" },
      { at: main.getByTestId("probe-row-get"), side: "left" }, { at: main.getByTestId("probe-adopt"), side: "left" },
    ]);
    await main.getByTestId("probe-adopt").click();
    await main.getByRole("button", { name: "保存", exact: true }).first().click();
    await sleep(800);
  });
  await step("find-editor", async () => {
    await main.getByTestId("probe-open-0").click(); // 通信テストを閉じる
    await main.getByTestId("find-open-0").click();
    await main.getByTestId("find-editor").waitFor({ state: "visible" });
    await shot(main, "find-editor", [main.getByTestId("find-editor"), main.getByTestId("find-open-0")]);
  });

  // ③ 事前取得
  await step("prefetch", async () => {
    await main.getByTestId("settings-cat-prefetch").click();
    await main.getByTestId("prefetch-panel").waitFor({ state: "visible" });
    await main.getByTestId("prefetch-enabled").check();
    await main.getByTestId("prefetch-source").selectOption("csv");
    await main.getByTestId("prefetch-csv-folder").fill("D:\\RIS\\Appointments"); // 画面に出す例（実在しなくてよい。実行はしない）
    await main.getByTestId("prefetch-csv-col-id").fill("患者ID");
    await main.getByTestId("prefetch-csv-col-date").fill("予約日");
    await main.getByTestId("prefetch-target-day").selectOption("tomorrow");
    await main.getByTestId("prefetch-times").fill("07:00");
    await main.getByTestId("prefetch-pacs-ae").selectOption("PACS-B");
    await main.getByTestId("prefetch-retrieve").selectOption("move");
    await main.getByTestId("prefetch-csv-charset").selectOption("UTF-8");
    await main.getByTestId("prefetch-timeout").fill("120");
    await sleep(500);
    const err = await main.getByTestId("prefetch-form-errors").isVisible().catch(() => false);
    console.log(`事前取得の入力エラー表示: ${err ? "あり" : "なし"}`);
    await main.getByTestId("prefetch-enabled").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await sleep(300);
    await shot(main, "prefetch-panel", [
      { at: main.getByTestId("prefetch-enabled"), side: "left" }, main.getByTestId("prefetch-source"),
      { at: main.getByTestId("prefetch-csv-folder"), side: "left" },
    ]);
    await main.getByTestId("prefetch-target-day").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await sleep(300);
    await shot(main, "prefetch-when", [
      { at: main.getByTestId("prefetch-target-day"), side: "left" }, main.getByTestId("prefetch-times"),
      { at: main.getByTestId("prefetch-pacs-ae"), side: "left" }, main.getByTestId("prefetch-retrieve"),
    ]);
  });

  if (failed.length > 0) console.log(`🔴 撮れなかった（ガイドに載せない）:\n  ${failed.join("\n  ")}`);
};
export default scenario;

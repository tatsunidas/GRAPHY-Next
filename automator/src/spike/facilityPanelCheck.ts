/*
 * 施設の資料パネル（メイン画面の「資料」節）の実アプリ検査。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=… GRAPHY_AUTOMATOR_SCP_PORT=… GRAPHY_AUTOMATOR_VITE_PORT=… npx tsx src/spike/facilityPanelCheck.ts
 * 前提: backend jar（再ビルド済み）。JDK を PATH に足す。専用ポートで他のセッションと分ける。
 *
 *   [1] 未設定: 節が出ない
 *   [2] 設定ファイルの場所を保存 → 節が出る。既定は畳まれ、グループも閉じている（スクリーンショットで目視）
 *   [3] 対照: 何も変えないまま待つと、節の中身は変わらない（検査が「いつも変わって見える」でないことの確認）
 *   [4] ファイルを書き換える（再起動しない）→ 中身が変わる（所要時間を測る）
 *   [5] 壊す → 警告が出て、直前の内容は残る。直すと戻る
 *   [6] リンクを押す → main の shell.openExternal に、設定の URL が完全一致で届く（http:・javascript: のリンクは節に出ない）
 *   [7] 通信: この間、本体（localhost）以外へのリクエストが 0 件
 *
 * 結果は 合格・失敗・未達 に分けて数える。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const OUT = path.join(AUTOMATOR_ROOT, ".results", "facility-panel-check");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cfg = (extraTitle: string) => JSON.stringify({
  schemaVersion: 1,
  title: "放射線科 資料",
  updatedAt: "2026-11-18",
  contact: "mailto:rad-info@example.org",
  groups: [
    { id: "protocols", title: "撮影プロトコル" + extraTitle, items: [{ type: "link", title: "造影 CT プロトコル", url: "https://intra.example.org/proto/ct", note: "2026-10 改訂" }],
      groups: [{ id: "peds", title: "小児", items: [{ type: "link", title: "鎮静の目安", url: "https://intra.example.org/peds/sedation" }] }] },
    { id: "phones", title: "電話帳", items: [{ type: "card", title: "当直・緊急", body: "放射線科 当直 内線 1234\nCT 室 内線 5678" }] },
  ],
});

async function waitFor<T>(fn: () => Promise<T | null | false>, timeoutMs: number, stepMs = 200): Promise<{ value: T | null; ms: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return { value: v as T, ms: Date.now() - t0 };
    await sleep(stepMs);
  }
  return { value: null, ms: Date.now() - t0 };
}

/** 起動直後に出る更新の案内（最新版の通知）は、検査の対象外。出ていれば［後で］で閉じる（出ていなければ何もしない）。 */
async function dismissUpdateDialog(page: import("@playwright/test").Page): Promise<void> {
  const later = page.getByRole("button", { name: /^(後で|Later)$/ });
  if (await later.first().isVisible({ timeout: 4000 }).catch(() => false)) await later.first().click();
}

async function main(): Promise<number> {
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "facility-"));
  const file = path.join(work, "facility-config.json");
  fs.writeFileSync(file, cfg(""), "utf8");

  const driver = new DesktopDriver();
  const requests: string[] = [];
  try {
    await driver.start();
    const page = driver.page;
    page.on("request", (r) => requests.push(r.url()));
    await page.evaluate("localStorage.removeItem('graphy.facility.open'); localStorage.setItem('graphy.locale','ja')");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissUpdateDialog(page);
    await driver.app.evaluate(({ shell }) => {
      (globalThis as unknown as { __opened: string[] }).__opened = [];
      shell.openExternal = async (u: string) => { (globalThis as unknown as { __opened: string[] }).__opened.push(u); };
    });
    const sec = page.getByTestId("resource-panel");
    const panelText = async () => (await sec.count()) === 0 ? null : await sec.innerText();

    console.log("\n[1] 未設定");
    // 🔴 前回の実行の痕跡（保存済みの設定）が残っていると、最初から節が出て、後の「出る」の検査が空振りする。開始時に消す。
    const clear = await fetch(`http://127.0.0.1:${driver.ports.http}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "facility.configPath": "" }) });
    check(clear.ok, "（前提）前回の設定を消した", clear.status);
    await sleep(4000);
    check((await sec.count()) === 0, "未設定のとき、メイン画面に「資料」節が出ない");

    console.log("\n[2] 設定ファイルの場所を保存");
    const put = await fetch(`http://127.0.0.1:${driver.ports.http}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "facility.configPath": file }) });
    check(put.ok, "設定 facility.configPath を保存できた", put.status);
    const appeared = await waitFor(async () => (await sec.count()) > 0 ? true : null, 20_000);
    check(appeared.value === true, `節が出る（${(appeared.ms / 1000).toFixed(1)} 秒）`);
    if (appeared.value !== true) return summaryAll();
    await dismissUpdateDialog(page);
    const toggle = page.getByTestId("resource-panel-toggle");
    check((await toggle.getAttribute("aria-expanded")) === "false", "既定では節は畳まれている");
    await page.screenshot({ path: path.join(OUT, "1-closed.png") });
    await toggle.click();
    check((await page.getByTestId("resource-panel-group-toggle-protocols").getAttribute("aria-expanded")) === "false" && (await page.getByTestId("resource-panel-group-toggle-phones").getAttribute("aria-expanded")) === "false", "節を開いても、グループは全部閉じている");
    check((await page.getByTestId("resource-panel-link-protocols.0").count()) === 0, "閉じたグループの中のリンクは出ない");
    await page.screenshot({ path: path.join(OUT, "2-section-open.png") });
    await page.getByTestId("resource-panel-group-toggle-protocols").click();
    check((await page.getByTestId("resource-panel-link-protocols.0").count()) === 1, "グループを開くとリンクが出る");
    await page.screenshot({ path: path.join(OUT, "3-group-open.png") });

    console.log("\n[3] 対照: 何も変えないまま 6 秒待つ");
    const before = await panelText();
    await sleep(6000);
    check((await panelText()) === before, "ファイルを変えなければ、節の中身は変わらない（検査が常に「変わった」と見えないこと）");

    console.log("\n[4] ファイルを書き換える（再起動しない）");
    fs.writeFileSync(file, cfg("（改訂）"), "utf8");
    const t4 = Date.now();
    const changed = await waitFor(async () => ((await panelText()) ?? "").includes("撮影プロトコル（改訂）") ? true : null, 20_000, 150);
    check(changed.value === true, `書き換えが節に反映された（${((Date.now() - t4) / 1000).toFixed(1)} 秒。目安は 4 秒以内）`);
    check(changed.ms <= 6000, "反映までが 6 秒以内（バックエンド 1 秒ごと × 2 回の確認 + 画面の 2 秒ごとの問い合わせ）", changed.ms);
    check((await toggle.getAttribute("aria-expanded")) === "true" && (await page.getByTestId("resource-panel-group-toggle-protocols").getAttribute("aria-expanded")) === "true", "再起動していないので、開閉の状態は保たれている");

    console.log("\n[5] 壊す → 直す");
    fs.writeFileSync(file, '{ "schemaVersion": 1, "groups": [ { "id": "g", "title": "T", "items": [ { "type": "link", "title": "x", "url": "javascript:alert(1)" } ] } ] }', "utf8");
    const warned = await waitFor(async () => (await page.getByTestId("resource-panel-status").count()) > 0 ? true : null, 20_000, 150);
    check(warned.value === true, "不正なリンクを含む設定にすると、警告が出る");
    check(((await panelText()) ?? "").includes("撮影プロトコル（改訂）"), "直前の有効な内容は表示されたまま");
    await page.screenshot({ path: path.join(OUT, "4-broken-kept.png") });
    fs.writeFileSync(file, cfg("（再改訂）"), "utf8");
    const fixed = await waitFor(async () => ((await panelText()) ?? "").includes("（再改訂）") && (await page.getByTestId("resource-panel-status").count()) === 0 ? true : null, 20_000, 150);
    check(fixed.value === true, "直すと警告が消えて新しい内容になる");

    console.log("\n[6] リンクを押す");
    await page.getByTestId("resource-panel-link-protocols.0").click();
    await page.getByTestId("resource-panel-group-toggle-peds").click();
    await page.getByTestId("resource-panel-link-peds.0").click();
    await page.getByTestId("resource-panel-contact").click();
    const opened = (await driver.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)) as string[];
    console.log(`  main の shell.openExternal に届いた: ${JSON.stringify(opened)}`);
    check(opened[0] === "https://intra.example.org/proto/ct", "リンクの URL が、設定の文字列と完全一致で main に届く", opened[0]);
    check(opened[1] === "https://intra.example.org/peds/sedation", "入れ子のグループのリンクも同じ", opened[1]);
    check(/^mailto:rad-info@example\.org\?subject=/.test(opened[2] ?? ""), "「管理者に連絡」は設定の mailto に件名だけ足して届く", opened[2]);
    check(opened.length === 3, "押していない間に、勝手に外へ開かれていない", opened.length);

    console.log("\n[7] 通信");
    const hosts = new Set(requests.map((u) => { try { return new URL(u).host; } catch { return u; } }));
    console.log(`  この間のリクエスト先: ${[...hosts].join(", ")}`);
    const external = [...hosts].filter((h) => !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h) && h !== "");
    check(external.length === 0, "本体（localhost）以外へのリクエストが 0 件", external);
    check(requests.some((u) => u.includes("/api/facility/config")), "（前提）資料の問い合わせは実際に行われた");
  } finally {
    await fetch(`http://127.0.0.1:${driver.ports.http}/api/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ "facility.configPath": "" }) }).catch(() => undefined);
    await driver.stop().catch(() => undefined);
    fs.rmSync(work, { recursive: true, force: true });
  }
  return summaryAll();
}

function summaryAll(): number {
  return summary();
}

main().then((c) => process.exit(c === 0 ? 0 : 1), (e) => { console.error(e); process.exit(1); });

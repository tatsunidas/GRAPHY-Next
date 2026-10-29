/*
 * マニュアル（docs/main-screen.md）の画面写真を、実アプリから撮る。
 *
 * 合成 CT（患者名・ID・画素はすべて架空）を、実際のデスクトップ版（Electron・standalone）の「インポート」で 3 検査取り込み、
 * 画面を撮って docs/images/main-screen/ に置く。インポートは Electron だけの機能（ブラウザでは無効）なので、ブラウザ駆動では撮れない。
 * OS のフォルダ選択ダイアログだけは差し替え、合成データのフォルダを選んだことにする。
 * 実行（専用ポート。jar は `cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package`）:
 *   cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18200 GRAPHY_AUTOMATOR_SCP_PORT=18201 GRAPHY_AUTOMATOR_VITE_PORT=18203 \
 *     npx tsx src/spike/docsMainScreenShots.ts
 * 撮影環境: Linux・headless Chromium（実機の Windows・macOS と見た目が違うことがある）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

const IMG_DIR = path.resolve(AUTOMATOR_ROOT, "..", "docs", "images", "main-screen");
const WORK = path.join(AUTOMATOR_ROOT, ".results", "docs-main-screen");
const STUDIES = [
  { name: "DEMO^TARO", id: "DEMO0001", desc: "Chest axial", study: "CT chest", n: 40 },
  { name: "DEMO^HANAKO", id: "DEMO0002", desc: "Abdomen axial", study: "CT abdomen", n: 30 },
  { name: "SAMPLE^ICHIRO", id: "DEMO0003", desc: "Head axial", study: "CT head", n: 24 },
];

async function main(): Promise<void> {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const parent = path.join(WORK, "import-root");
  for (const [i, s] of STUDIES.entries()) {
    const d = path.join(parent, `study${i}`);
    fs.mkdirSync(d, { recursive: true });
    const r = spawnSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "src", "spike", "webSynthCt.py"), d, String(s.n), s.name, s.id, s.desc, s.study], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    fs.rmSync(path.join(d, "dicomweb-index.json"), { force: true });
  }
  const driver = new DesktopDriver();
  try {
    await driver.start();
    await resetDb(driver.ports.http);
    const main = driver.page;
    // マニュアルは日本語。表示言語は localStorage（画面の言語切替と同じキー）で切り替えて読み直す。窓は 1400×1300 にする。
    await main.evaluate(() => localStorage.setItem("graphy.locale", "ja"));
    await driver.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) { w.unmaximize(); w.setSize(1400, 1300); w.center(); }
    });
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.waitForTimeout(1500);
    await waitForMainScreenReady(main);
    await dismissStartupDialogs(main);
    // マニュアルに載せる分だけ docs/images/ に置く。載せない画面は確認用に作業ディレクトリへ。
    const KEEP = new Set(["02-menu-file", "03-imported", "05-list-series", "06-search", "07-preview", "08-layout-split", "10-layout-tree"]);
    // 条件なし検索の確認（window.confirm）は「続行」にする。出たことは数えて確かめる。
    const dialogs: string[] = [];
    main.on("dialog", (d) => { dialogs.push(d.message()); void d.accept(); });
    const shot = async (name: string) => { await main.screenshot({ path: path.join(KEEP.has(name) ? IMG_DIR : WORK, `${name}.png`) }); console.log(`撮影: ${name}.png${KEEP.has(name) ? "" : "（確認用）"}`); };
    const rows = () => main.locator('[data-testid^="study-row-"]');
    const note = (cond: boolean, label: string) => { console.log(`  [${cond ? "ok  " : "FAIL"}] ${label}`); if (!cond) process.exitCode = 1; };

    // 1. 起動直後（検査日の既定は「今日」なので、取り込んだ検査は出ない）
    await shot("01-startup");
    note((await rows().count()) === 0, "起動直後は一覧が空");
    // 2. ファイル → インポート（フォルダ選択は差し替え）
    await driver.mockNativeDirectoryPicker(parent);
    await main.getByText("ファイル", { exact: true }).first().click();
    await shot("02-menu-file");
    await main.getByText("インポート", { exact: true }).first().click();
    await main.locator('[data-testid="imported-view-banner"]').waitFor({ timeout: 60_000 });
    await main.waitForTimeout(800);
    const banner = await main.locator('[data-testid="imported-view-banner"]').innerText();
    console.log("バナー:", banner.replace(/\n+/g, " | "));
    note(/3/.test(banner), "インポート後、取り込んだ検査 3 件が表示される（バナー）");
    await shot("03-imported");
    // 3. 検索条件の一覧に戻る → 既定の検査日（今日）では出ない
    await main.getByText("検索条件の一覧に戻る").first().click();
    await main.waitForTimeout(1200);
    note((await rows().count()) === 0, "検索条件の一覧に戻ると、検査日の既定（今日）のため検査が出ない");
    await shot("04-back-to-search");
    // 4. 全期間で検索
    await main.getByTestId("search-allperiod-chip").click();
    await main.getByTestId("search-submit-button").click();
    await rows().first().waitFor({ timeout: 20_000 });
    note((await rows().count()) === 3, "「全期間」で検索すると 3 件出る");
    await rows().first().click();
    await main.locator('[data-testid^="series-row-"]').first().waitFor({ timeout: 10_000 });
    await shot("05-list-series");
    // 3. 患者 ID の部分一致
    await main.getByTestId("search-patientid-input").fill("0002");
    await main.getByTestId("search-submit-button").click();
    await main.waitForTimeout(1200);
    note((await rows().count()) === 1, "患者 ID「0002」の部分一致で 1 件に絞れる");
    await shot("06-search");
    await main.getByTestId("search-patientid-input").fill("");
    await main.getByTestId("search-submit-button").click();
    for (let i = 0; i < 20 && (await rows().count()) !== 3; i++) await main.waitForTimeout(500);
    note((await rows().count()) === 3, "患者 ID を空にして検索し直すと 3 件に戻る");
    note(dialogs.length >= 1 && dialogs.every((m) => m.includes("検索条件が指定されていません")), `条件を指定しない検索では確認（検索条件が指定されていません…続行しますか？）が出る（${dialogs.length} 回）`);
    // 3b. 見出しのチェックで全選択、「列」で表示する列の選択
    console.log("一覧の行数:", await rows().count());
    await main.getByTestId("study-check-all").check();
    const checked = await main.locator('[data-testid^="study-check-study"], [data-testid^="study-check-1"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked));
    note(checked.length === 3 && checked.every(Boolean), `見出しのチェックで 3 件すべてが選ばれる（${JSON.stringify(checked)}）`);
    await main.getByTestId("study-check-all").uncheck();
    await main.getByTestId("list-columns-button").click();
    const dlg = main.getByText("一覧の列", { exact: true }).first();
    await dlg.waitFor({ timeout: 5000 }).catch(() => {});
    note(await dlg.isVisible().catch(() => false), "「列」を押すと「一覧の列」の画面が出る（辞書から探して列を足す）");
    note(await main.getByText("シーケンス・プライベートを指定…").first().isVisible().catch(() => false), "「一覧の列」に「シーケンス・プライベートを指定…」がある");
    await main.getByRole("button", { name: "閉じる" }).first().click({ timeout: 3000 }).catch(() => {});
    // 4. シリーズを選ぶとプレビュー
    await rows().first().click();
    const ser = main.locator('[data-testid^="series-row-"]').first();
    await ser.waitFor({ timeout: 10_000 });
    await ser.click();
    await main.waitForTimeout(3000);
    // 先頭のスライスは端で暗いので、スライダーで中央へ動かして撮る（画面のスライダー操作でもある）
    await main.locator('input[type="range"]').first().fill("14");
    await main.waitForTimeout(1500);
    note((await main.locator("canvas").count()) > 0, "シリーズを選ぶと下部のプレビューに画像（canvas）が出る");
    await shot("07-preview");
    // 5. 一覧の形式（上下・左右・ツリー）
    for (const [id, file] of [["split", "08-layout-split"], ["side", "09-layout-side"], ["tree", "10-layout-tree"]] as const) {
      const btn = main.getByTestId(`list-layout-${id}`);
      if ((await btn.count()) === 0) { console.log(`  [FAIL] list-layout-${id} が無い`); process.exitCode = 1; continue; }
      await btn.click();
      await main.waitForTimeout(1200);
      await shot(file);
    }
    await main.getByTestId("list-layout-table").click().catch(() => {});
    // 7. ビューアを開く
    const v = await driver.waitForNewPage(() => main.locator('button[title="2D Viewer"]').click(), (url) => url.includes("2dviewer"));
    await v.waitForTimeout(3000);
    note(/2dviewer/.test(v.url()), "「2D Viewer」で別の窓（#2dviewer）が開く");
    await v.screenshot({ path: path.join(WORK, "11-viewer2d.png") });
    console.log("撮影: 11-viewer2d.png（確認用）");
  } finally {
    await driver.stop();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

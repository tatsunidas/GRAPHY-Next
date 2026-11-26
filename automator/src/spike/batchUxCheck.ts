/*
 * 一括抽出（Batch ROI features）の画面の改善の実機検証スパイク（Electron・実 backend・実データ）。
 *
 * 実行:  cd automator && PSMA=<PET と CT と SEG のある症例フォルダ> CT_CASE=<CT と SEG のある症例フォルダ> OUT=<書き出しの確認用の一時フォルダ> \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=19480 GRAPHY_AUTOMATOR_SCP_PORT=19481 GRAPHY_AUTOMATOR_VITE_PORT=19483 \
 *          AUTOMATOR_DATA_DIR=$PWD/.results/run-data/batch-ux timeout 1500 npx tsx src/spike/batchUxCheck.ts
 *   前提: backend jar を今のコードで作り直してある。
 *
 *   [1] 「Volume (3D)」の表記（「全腫瘍」が残っていない）
 *   [2] 各欄の見出し・族のチェックに ⓘ があり、title（説明）が付いている。入力欄・ボタンにも title がある（画面に出ない隠しのファイル入力は除く。起動するボタン側に title がある）
 *   [3] PET と CT が混ざった組を対象にすると、モダリティ混在の注意帯が出る。CT だけにすると消える（負例）
 *   [4] PET が対象で固定ビン幅が初期値 25 のままだと、PET の注意帯が出る。ビン幅を変える・固定ビン数にする・PET を外すと消える（負例）
 *   [5] Write CSV: フォルダを 1 回選ぶと全ファイルがそこへ書かれる。もう一度書くと「名前 (2).csv」になり上書きされない。
 *       選択を取り消すと何も書かれない（負例）
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { dismissUpdateDialog } from "./dismissUpdateDialog.js";

const PSMA = process.env.PSMA ?? "";
const CT_CASE = process.env.CT_CASE ?? "";
const OUT = process.env.OUT ?? path.join(AUTOMATOR_ROOT, ".results", "batch-ux-out");
const SHOTS = path.join(AUTOMATOR_ROOT, ".results", "batch-ux-check");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log(`  [ok  ] ${label}`); } else { console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); failures.push(label); }
}

async function stubPickDirectory(d: DesktopDriver, dir: string | null): Promise<void> {
  await d.app.evaluate(({ dialog }, picked) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => (picked ? { canceled: false, filePaths: [picked] } : { canceled: true, filePaths: [] });
  }, dir);
}

async function main(): Promise<void> {
  if (!PSMA || !CT_CASE || !fs.existsSync(PSMA) || !fs.existsSync(CT_CASE)) { console.log("[未達] PSMA・CT_CASE の症例フォルダを指定してください"); process.exitCode = 2; return; }
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    await resetDb(d.ports.http);
    const a = await importPaths(d.ports.http, [PSMA]);
    const b = await importPaths(d.ports.http, [CT_CASE]);
    const uidsOf = (r: unknown): string[] => (r as { studyInstanceUids: string[] }).studyInstanceUids;
    const studyUids = [...uidsOf(a), ...uidsOf(b)];
    console.log(`取り込み: ${studyUids.length} 検査`);
    const name = "BatchUx";
    const old = (await (await fetch(`${base}/api/albums`)).json()) as { id: number; name: string }[];
    for (const x of old.filter((y) => y.name === name)) await fetch(`${base}/api/albums/${x.id}`, { method: "DELETE" });
    const album = (await (await fetch(`${base}/api/albums`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })).json()) as { id: number };
    await fetch(`${base}/api/albums/${album.id}/studies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studyUids }) });

    const page: Page = d.page;
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await sleep(2000);
    await dismissUpdateDialog(page);
    await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await page.reload();
    await page.getByTestId("album-select").waitFor({ state: "visible", timeout: 60_000 });
    await dismissUpdateDialog(page);
    await page.getByTestId("album-select").selectOption(String(album.id));
    await sleep(1500);
    await page.getByTestId("album-batch-button").click();
    await page.getByTestId("batch-dialog").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("batch-summary").waitFor({ state: "visible", timeout: 120_000 });
    await sleep(3000);
    const dlg = page.getByTestId("batch-dialog");
    console.log(`組の表: ${(await page.locator('[data-testid^="batch-row-"]').allInnerTexts()).map((r) => r.replace(/\s+/g, " ").slice(0, 160)).join(" | ")}`);
    await page.screenshot({ path: path.join(SHOTS, "01-dialog.png"), fullPage: true });

    console.log("\n[1] 表記");
    const text = await dlg.innerText();
    check(/ボリューム（3D）/.test(text), "「ボリューム（3D）」と出る");
    check(!/全腫瘍/.test(text), "「全腫瘍」が残っていない");

    console.log("\n[2] ⓘ とツールチップ");
    const marks = await dlg.getByTestId("info-mark").evaluateAll((els) => els.map((e) => ({ t: e.getAttribute("title") ?? "", visible: (e as HTMLElement).offsetParent !== null })));
    console.log(`  ⓘ の数: ${marks.length}`);
    check(marks.length >= 25, "ⓘ が 25 個以上ある", marks.length);
    check(marks.every((m) => m.t.trim().length > 0), "すべての ⓘ に説明（title）がある");
    const noTitle = await dlg.locator("input:not([type=file]), select, textarea, button").evaluateAll((els) =>
      els.filter((e) => { for (let n: Element | null = e; n && n.tagName !== "BODY"; n = n.parentElement) { if ((n.getAttribute("title") ?? "").trim() !== "") return false; } return true; })
        .map((e) => (e.getAttribute("data-testid") ?? e.tagName) + ":" + ((e as HTMLElement).innerText ?? "").slice(0, 20)));
    console.log(`  title の無い入力欄・ボタン: ${JSON.stringify(noTitle)}`);
    check(noTitle.length === 0, "入力欄・ボタンのすべてに、自分か祖先の title がある", noTitle);
    const fam = await dlg.getByTestId("batch-settings").locator('label:has(input[type="checkbox"])').evaluateAll((els) =>
      els.filter((e) => /GLCM|GLRLM|Morphology|形/.test((e as HTMLElement).innerText)).map((e) => ({ t: (e as HTMLElement).innerText.trim().slice(0, 20), title: (e.getAttribute("title") ?? "").slice(0, 60), mark: e.querySelector('[data-testid="info-mark"]') !== null })));
    console.log(`  族のチェック（抜粋）: ${JSON.stringify(fam)}`);
    check(fam.length > 0 && fam.every((f) => f.title.length > 0 && f.mark), "族のチェックに説明（title）と ⓘ がある", fam);

    console.log("\n[3] モダリティ混在の注意帯");
    const nRows = await page.locator('[data-testid^="batch-row-"]').count();
    // 要確認の組は、元画像の候補から PT を選ぶ（PET の組を対象に入れる）
    for (let i = 0; i < nRows; i++) {
      const sel = page.getByTestId(`batch-source-${i}`);
      if (await sel.count()) {
        const opts = await sel.locator("option").allTextContents();
        const pt = opts.find((o) => /\bPT\b/.test(o));
        console.log(`  行 ${i} の候補: ${JSON.stringify(opts)}`);
        if (pt) await sel.selectOption({ label: pt });
      }
    }
    await sleep(800);
    const rowText = (await page.locator('[data-testid^="batch-row-"]').allInnerTexts()).map((r) => r.replace(/\s+/g, " "));
    const ptRow = rowText.findIndex((r) => /\bPT\b/.test(r));
    const ctRow = rowText.findIndex((r) => /\bCT\b/.test(r) && !/\bPT\b/.test(r));
    console.log(`  PT の行: ${ptRow}、CT だけの行: ${ctRow}`);
    for (let i = 0; i < nRows; i++) { const c = page.getByTestId(`batch-include-${i}`); if (await c.isEnabled().catch(() => false)) await c.check(); }
    await sleep(500);
    const mixed = page.getByTestId("batch-modality-mixed-warn");
    check(await mixed.isVisible().catch(() => false), "PT と CT の組を対象にすると、混在の注意帯が出る");
    console.log(`  注意帯: ${(await mixed.innerText().catch(() => "")).replace(/\s+/g, " ")}`);
    await page.screenshot({ path: path.join(SHOTS, "02-mixed.png"), fullPage: true });

    console.log("\n[4] PET の離散化の注意帯");
    const warn = page.getByTestId("batch-pet-binwidth-warn");
    check(!(await warn.isVisible().catch(() => false)), "既定（固定ビン数）では PET の注意帯は出ない（負例）");
    await dlg.getByTestId("batch-settings").getByRole("radio", { name: /ビン幅/ }).check();
    await sleep(500);
    check(await warn.isVisible().catch(() => false), "固定ビン幅のまま（初期値 25）で、PET が対象なら注意帯が出る");
    console.log(`  注意帯: ${(await warn.innerText().catch(() => "")).replace(/\s+/g, " ")}`);
    await page.screenshot({ path: path.join(SHOTS, "03-pet-binwidth.png"), fullPage: true });
    const binInput = dlg.getByTestId("batch-settings").locator('input[type="number"]').filter({ hasNot: page.locator("[disabled]") });
    // ビン幅の数値欄（固定ビン幅が選ばれていて有効なもの）を 0.1 にする
    const widths = dlg.getByTestId("batch-settings").locator('input[inputmode="decimal"], input[type="number"], input[type="text"]');
    const nW = await widths.count();
    let changed = false;
    for (let i = 0; i < nW && !changed; i++) {
      const el = widths.nth(i);
      if ((await el.inputValue().catch(() => "")) === "25" && (await el.isEnabled())) { await el.fill("0.1"); changed = true; }
    }
    void binInput;
    await sleep(500);
    check(changed && !(await warn.isVisible().catch(() => false)), "ビン幅を 0.1 に変えると注意帯が消える（負例）");
    await dlg.getByTestId("batch-settings").getByRole("radio", { name: /ビン数/ }).check();
    await sleep(300);
    check(!(await warn.isVisible().catch(() => false)), "固定ビン数に戻しても出ない（負例）");

    console.log("\n[5] Write CSV（CT の 1 症例だけを実行して書き出す）");
    // PT の組を外して CT だけにする → 混在の注意帯が消える（負例）
    if (ptRow >= 0) await page.getByTestId(`batch-include-${ptRow}`).uncheck();
    await sleep(500);
    check(!(await mixed.isVisible().catch(() => false)), "CT だけにすると混在の注意帯が消える（負例）");
    await page.getByTestId("batch-run").click();
    const t0 = Date.now();
    await page.getByTestId("batch-write").waitFor({ state: "visible", timeout: 30_000 });
    for (let i = 0; i < 600; i++) { if (await page.getByTestId("batch-write").isEnabled()) break; await sleep(2000); }
    console.log(`  計算 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    check(await page.getByTestId("batch-write").isEnabled(), "計算が終わり、Write CSV が押せる");
    // 取り消し（負例）: 何も書かれない
    await stubPickDirectory(d, null);
    await page.getByTestId("batch-write").click();
    await sleep(1500);
    check(fs.readdirSync(OUT).length === 0, "フォルダ選択を取り消すと、何も書かれない（負例）", fs.readdirSync(OUT));
    // 1 回目
    await stubPickDirectory(d, OUT);
    await page.getByTestId("batch-write").click();
    await page.getByTestId("batch-written").waitFor({ state: "visible", timeout: 30_000 });
    const first = fs.readdirSync(OUT).sort();
    console.log(`  1 回目: ${JSON.stringify(first)}`);
    check(first.length >= 3, "1 回の選択で、全ファイル（3 つ以上）が選んだフォルダに書かれる", first);
    check(first.every((f) => !/ \(\d+\)\./.test(f)), "1 回目は連番が付かない", first);
    const msg1 = await page.getByTestId("batch-written").innerText();
    // 2 回目
    await page.getByTestId("batch-write").click();
    await sleep(2500);
    const second = fs.readdirSync(OUT).sort();
    console.log(`  2 回目: ${JSON.stringify(second)}`);
    check(second.length === first.length * 2, "2 回目は、同名があるので別名で書かれる（ファイルが倍になる。上書きしない）", { first: first.length, second: second.length });
    check(first.every((f) => second.includes(f)), "1 回目のファイルは、そのまま残っている");
    check(second.filter((f) => / \(2\)\./.test(f)).length === first.length, "追加分は「名前 (2).拡張子」になる", second);
    const msg2 = await page.getByTestId("batch-written").innerText();
    console.log(`  完了メッセージ: ${msg1.replace(/\s+/g, " ").slice(0, 200)} → ${msg2.replace(/\s+/g, " ").slice(0, 200)}`);
    check(/\(2\)/.test(msg2), "完了メッセージに、実際に書かれた名前（連番つき）が出る", msg2);
    await page.screenshot({ path: path.join(SHOTS, "04-written.png"), fullPage: true });
  } finally {
    await d.stop();
  }
  console.log(`\n結果: 合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join("\n")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

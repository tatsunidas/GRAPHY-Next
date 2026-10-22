/*
 * シリーズ抽出（条件抽出）の実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/seriesExtractorV2Check.ts
 *
 * 本物の Electron ＋ 本物の backend ＋ 本物の CT データで、**押して・入力して・結果を突き合わせる**（CLAUDE.md ルール 9）。
 * 画面の行数は、同じ条件を API へ直接投げた結果と突き合わせる（画面と API が同じ仮定で作られていないこと）。
 * 正例（通る）と負例（落ちる）の両方を見る。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）と fixture ct-basic。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory, importPaths } from "../fixtures/importFixtures.js";
import { selectFirstStudy } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "series-extractor-v2-check");

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

interface Match {
  studyUid: string;
  seriesUid: string;
  patientId: string;
  studyDate: string;
  seriesDescription: string;
  instances: number;
  plane: string;
}
interface Cond {
  segments: { tag: string; creator?: string }[];
  vr: string;
  exclude: boolean;
  op: string;
  value1: string;
  value2: string;
}

/** 画面と同じ API を直接叩く（正解データ）。renderer の同一オリジンから fetch する。 */
let BASE = "";

async function api<T>(page: Page, url: string, body: unknown): Promise<T> {
  return page.evaluate(
    async ([u, b]) => {
      const r = await fetch(u as string, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    [BASE + url, body],
  ) as Promise<T>;
}

async function studyUids(page: Page): Promise<string[]> {
  const rows = await page.evaluate(async (b) => (await fetch(`${b}/api/studies`)).json(), BASE);
  return (rows as { studyInstanceUid: string }[]).map((s) => s.studyInstanceUid);
}

async function truth(page: Page, uids: string[], conditions: Cond[], planes: string[] = []): Promise<Match[]> {
  const r = await api<{ matched: Match[] }>(page, "/api/series-extract/verify", { studyUids: uids, conditions, planes });
  return r.matched;
}

const dlg = (p: Page) => p.getByTestId("series-extractor-dialog");
const rowCount = (p: Page) => p.getByTestId("series-extractor-result-table").locator("tbody tr").count();

async function runVerify(p: Page): Promise<number> {
  await p.getByTestId("series-extractor-verify-btn").click();
  await p.getByTestId("series-extractor-result-table").waitFor({ state: "visible", timeout: 30_000 });
  // 進捗が消える（＝終わる）まで待つ。
  await p.getByTestId("series-extractor-progress").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
  await p.waitForTimeout(300);
  return rowCount(p);
}

async function addTagByDoubleClick(p: Page, keyword: string): Promise<void> {
  await p.getByTestId("series-extractor-tag-search").fill(keyword);
  const row = p.getByTestId("series-extractor-tag-list").getByText(keyword, { exact: true }).first();
  await row.waitFor({ state: "visible", timeout: 5_000 });
  await row.dblclick();
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver();
  await d.start();
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importFixtureCategory(d.ports.http, "ct-basic"))}`);
    const page = d.page;
    BASE = `http://localhost:${d.ports.http}`;
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
    });
    // ダウンロードは保存ダイアログを出さず、指定の場所へ保存させる（押した結果のファイルを読む）。
    const dlDir = path.join(OUT_DIR, "downloads");
    fs.rmSync(dlDir, { recursive: true, force: true });
    fs.mkdirSync(dlDir, { recursive: true });
    await d.app.evaluate(({ session }, dir) => {
      session.defaultSession.on("will-download", (_e: unknown, item: { getFilename(): string; setSavePath(p: string): void }) => {
        item.setSavePath(`${dir}/${item.getFilename()}`);
      });
    }, dlDir);

    await selectFirstStudy(page, createStepRecorder());
    const uids = await studyUids(page);
    const all = await truth(page, uids, []);
    console.log(`  データ: スタディ ${uids.length} / シリーズ ${all.length}`);
    check(all.length >= 2, "検証データに 2 シリーズ以上ある（突き合わせが意味を持つ）", all.length);

    // ── 入口と全体表示 ─────────────────────────────────────────
    console.log("\n[1] ダイアログを開き、条件なしで全シリーズを探索する");
    await page.getByTestId("toolbar-series-extractor-btn").click();
    await dlg(page).waitFor({ state: "visible", timeout: 10_000 });
    const inList = uids.length;
    const n0 = await runVerify(page);
    check(n0 === all.length, "条件なしの行数が API の全シリーズ数と一致", { ui: n0, api: all.length, studies: inList });
    await page.screenshot({ path: path.join(OUT_DIR, "1-open.png") });

    // ── タグ一覧 ───────────────────────────────────────────────
    console.log("\n[2] タグ一覧: 番号・名前で引ける／全件に届く／使用済みは消える");
    const search = page.getByTestId("series-extractor-tag-search");
    const list = page.getByTestId("series-extractor-tag-list");
    await search.fill("0018,0050");
    check((await list.getByText("SliceThickness", { exact: true }).count()) === 1, "タグ番号 0018,0050 で SliceThickness が出る");
    await search.fill("00180050");
    check((await list.getByText("SliceThickness", { exact: true }).count()) === 1, "区切り無し 00180050 でも出る");
    await search.fill("slicethick");
    check((await list.getByText("SliceThickness", { exact: true }).count()) === 1, "名前（小文字・部分）でも出る");
    await search.fill("存在しないタグ名zzz");
    check((await list.getByText("SliceThickness").count()) === 0, "無関係な語では出ない（負例）");
    await search.fill("");
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(300);
    const lastRows = await list.locator("div[title]").count();
    check(lastRows > 0, "一覧の末尾までスクロールしても行が描画される（200 件で切れていない）", lastRows);

    // ── 条件の追加（文字） ─────────────────────────────────────
    console.log("\n[3] 文字タグ: 前方・後方・部分・完全一致と Include/Exclude を、API と突き合わせる");
    await addTagByDoubleClick(page, "SeriesDescription");
    const conds = page.getByTestId("series-extractor-cond");
    check((await conds.count()) === 1, "ダブルクリックで条件が 1 つ増える");
    await search.fill("SeriesDescription");
    check((await list.getByText("SeriesDescription", { exact: true }).count()) === 0, "🔴 設定済みのタグは一覧から消える");
    await search.fill("");

    const desc0 = all[0].seriesDescription;
    const prefix = desc0.slice(0, Math.min(3, desc0.length));
    const suffix = desc0.slice(-3);
    const cond = conds.first();
    const valueInput = cond.locator("input").first();
    const opSelect = cond.locator("select").first();
    const mk = (op: string, v: string, exclude = false): Cond => ({
      segments: [{ tag: "0008103E" }], vr: "LO", exclude, op, value1: v, value2: "",
    });
    const js = (m: Match[]) => m.map((x) => x.seriesUid).sort().join(",");

    for (const [op, val] of [["STARTS_WITH", prefix], ["ENDS_WITH", suffix], ["CONTAINS", desc0.slice(1, 4)], ["EQUALS", desc0]] as const) {
      await opSelect.selectOption(op);
      await valueInput.fill(val);
      const ui = await runVerify(page);
      const expect = await truth(page, uids, [mk(op, val)]);
      check(ui === expect.length && ui >= 1, `${op} "${val}": 画面 ${ui} 行 = API ${expect.length} 件（1 件以上）`, { ui, api: expect.length });
    }
    await opSelect.selectOption("ENDS_WITH");
    await valueInput.fill("zzzNOPE");
    check((await runVerify(page)) === 0, "負例: 存在しない後方一致は 0 行");

    await opSelect.selectOption("STARTS_WITH");
    await valueInput.fill(prefix);
    const inc = await runVerify(page);
    await cond.getByRole("button", { name: /除外|Exclude/ }).click();
    const exc = await runVerify(page);
    check(inc + exc === all.length && inc >= 1, "Include と Exclude は互いの補集合（合計が全シリーズ）", { inc, exc, all: all.length });
    await page.screenshot({ path: path.join(OUT_DIR, "2-conditions.png") });
    await cond.getByRole("button", { name: /含める|Include/ }).click();

    // ── 重複禁止 ───────────────────────────────────────────────
    console.log("\n[4] 同じタグ経路の重複は追加できない");
    await page.getByRole("button", { name: /シーケンスの中のタグ|inside a sequence/ }).click();
    const nestedSearch = page.getByPlaceholder(/辞書|dictionary|Search/i).last();
    await nestedSearch.fill("SeriesDescription");
    await page.getByText("SeriesDescription", { exact: true }).last().dblclick();
    await page.getByRole("button", { name: /追加|Add/ }).last().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, "2b-duplicate.png") });
    check((await conds.count()) === 1, "重複の追加は条件が増えない（負例）", await conds.count());
    check((await page.getByText(/同じタグ経路|same tag path/).count()) >= 1, "理由がメッセージで出る");
    if (await page.getByRole("button", { name: /キャンセル|Cancel/ }).count()) {
      await page.getByRole("button", { name: /キャンセル|Cancel/ }).last().click().catch(() => {});
    }

    // ── 数値 ───────────────────────────────────────────────────
    console.log("\n[5] 数値タグ: 大小・等価・範囲を、API と突き合わせる");
    await addTagByDoubleClick(page, "SeriesNumber");
    await search.fill("");
    const cond2 = conds.nth(1);
    const vals = all.length >= 1 ? await page.evaluate(async () => 0) : 0; void vals;
    const nums = (await truth(page, uids, [])).length;
    check(nums >= 1, "数値検証の前提: シリーズがある");
    const sOp = cond2.locator("select").first();
    const sVal = cond2.locator("input").first();
    // 既存の Include/Exclude 条件を外して数値だけにする。
    await conds.first().getByRole("button", { name: /削除|Delete/ }).click();
    const only = conds.first();
    const numMk = (op: string, v1: string, v2 = ""): Cond => ({ segments: [{ tag: "00200011" }], vr: "IS", exclude: false, op, value1: v1, value2: v2 });
    for (const [op, v1, v2] of [["GE", "0", ""], ["GT", "0", ""], ["LT", "100000", ""], ["RANGE", "0", "100000"], ["EQUALS", "-12345", ""], ["GT", "100000", ""]] as const) {
      await only.locator("select").first().selectOption(op);
      await only.locator("input").first().fill(v1);
      if (op === "RANGE") await only.locator("input").nth(1).fill(v2);
      const ui = await runVerify(page);
      const expect = (await truth(page, uids, [numMk(op, v1, v2)])).length;
      check(ui === expect, `SeriesNumber ${op} ${v1}${v2 ? "〜" + v2 : ""}: 画面 ${ui} = API ${expect}`, { ui, expect });
    }
    void sOp; void sVal;
    // 数値欄は文字を受け付けない
    await only.locator("select").first().selectOption("GT");
    await only.locator("input").first().fill("1a2b");
    check((await only.locator("input").first().inputValue()) === "12", "数値欄は数字以外を捨てる");
    await only.locator("input").first().fill("");
    check(await page.getByTestId("series-extractor-verify-btn").isDisabled(), "値が空の条件があると検証できない（負例）");
    await only.locator("input").first().fill("0");

    // ── 断面 ───────────────────────────────────────────────────
    console.log("\n[6] 撮像断面（IOP から判定）");
    await only.getByRole("button", { name: /削除|Delete/ }).click();
    await page.getByTestId("series-extractor-plane-AXIAL").click();
    const axUi = await runVerify(page);
    const axApi = (await truth(page, uids, [], ["AXIAL"])).length;
    check(axUi === axApi && axUi >= 1, "AXIAL: 画面 = API（1 件以上）", { axUi, axApi });
    await page.getByTestId("series-extractor-plane-AXIAL").click();
    await page.getByTestId("series-extractor-plane-SAGITTAL").click();
    const sagUi = await runVerify(page);
    const sagApi = (await truth(page, uids, [], ["SAGITTAL"])).length;
    check(sagUi === sagApi, "SAGITTAL: 画面 = API", { sagUi, sagApi });
    check(sagUi < axUi || axUi === 0, "負例: 軸位の CT を SAGITTAL で拾っていない", { sagUi, axUi });
    await page.getByTestId("series-extractor-plane-SAGITTAL").click();
    await page.getByTestId("series-extractor-plane-AXIAL").click();
    await runVerify(page);
    const planeCol = await page.getByTestId("series-extractor-result-table").locator("tbody tr").first().locator("td").nth(3).innerText();
    check(planeCol.trim().length > 0 && planeCol !== "—", "結果表に断面が出る", planeCol);
    await page.getByTestId("series-extractor-plane-AXIAL").click();

    // ── 条件の保存・読込 ───────────────────────────────────────
    console.log("\n[7] 条件の保存→全消去→読込で再現される");
    await addTagByDoubleClick(page, "SeriesDescription");
    await search.fill("");
    const c3 = conds.first();
    await c3.locator("select").first().selectOption("ENDS_WITH");
    await c3.locator("input").first().fill(suffix);
    await page.getByTestId("series-extractor-plane-AXIAL").click();
    const before = await runVerify(page);
    await page.getByTitle(/条件を保存|Save conditions|save/i).first().click();
    await page.waitForTimeout(1200);
    const saved = fs.readdirSync(dlDir).find((f) => f.endsWith(".properties"));
    check(!!saved, "保存ボタンで .properties が実際に書き出される", fs.readdirSync(dlDir));
    const text = saved ? fs.readFileSync(path.join(dlDir, saved), "utf8") : "";
    check(/op=ENDS_WITH/.test(text) && /plane=AXIAL/.test(text), "ファイルに演算子と断面が入っている", text);
    await page.getByTitle(/すべて消す|Clear all/i).first().click();
    check((await conds.count()) === 0, "全消去で条件が 0 になる");
    await page.locator('input[type="file"]').first().setInputFiles(path.join(dlDir, saved ?? "none"));
    await page.waitForTimeout(500);
    check((await conds.count()) === 1, "読込で条件が戻る");
    check((await conds.first().locator("select").first().inputValue()) === "ENDS_WITH", "演算子が戻る");
    check((await conds.first().locator("input").first().inputValue()) === suffix, "値が戻る");
    const after = await runVerify(page);
    check(after === before, "読込後の検証結果が保存前と同じ", { before, after });

    // ── データシート ───────────────────────────────────────────
    console.log("\n[8] データシート CSV（患者 ID・検査日・StudyUID・SeriesUID が必須）");
    const rowsUi = await page.getByTestId("series-extractor-result-table").locator("tbody tr").allInnerTexts();
    await page.getByTestId("series-extractor-datasheet-btn").click();
    await page.waitForTimeout(2000);
    const csvName = fs.readdirSync(dlDir).find((f) => f.endsWith("series_datasheet.csv"));
    check(!!csvName, "データシートのボタンで CSV が実際に書き出される", fs.readdirSync(dlDir));
    const csv = csvName ? fs.readFileSync(path.join(dlDir, csvName), "utf8").replace(/^﻿/, "") : "";
    const lines = csv.split(/\r?\n/).filter(Boolean);
    const head = (lines[0] ?? "").split(",");
    check(head.slice(0, 4).join(",") === "PatientID,StudyDate,StudyInstanceUID,SeriesInstanceUID", "先頭 4 列が必須項目", head.slice(0, 4));
    check(lines.length - 1 === rowsUi.length, "CSV の行数が画面の結果表と一致", { csv: lines.length - 1, ui: rowsUi.length });
    const exp = await truth(page, uids, [{ segments: [{ tag: "0008103E" }], vr: "LO", exclude: false, op: "ENDS_WITH", value1: suffix, value2: "" }], ["AXIAL"]);
    const firstCells = (lines[1] ?? "").split(",");
    check(exp.some((m) => m.patientId === firstCells[0] && m.studyDate === firstCells[1] && m.studyUid === firstCells[2] && m.seriesUid === firstCells[3]),
      "CSV の 1 行目の 4 値が API の実在シリーズと一致", firstCells.slice(0, 4));
    check(head.length >= 11, "条件タグの列が増えている", head);

    // ── 抽出（連番あり／なし） ─────────────────────────────────
    console.log("\n[9] 抽出（コピー）: 連番ありと、なし");
    for (const sequential of [true, false]) {
      const dest = path.join(OUT_DIR, `out-${sequential ? "seq" : "named"}-${Date.now()}`);
      fs.mkdirSync(dest, { recursive: true });
      await d.mockNativeDirectoryPicker(dest);
      await page.getByTestId("series-extractor-pick-dest-btn").click();
      await page.getByTestId("series-extractor-dest-label").filter({ hasText: path.basename(dest) }).waitFor({ timeout: 5_000 });
      const box = page.getByRole("checkbox", { name: /連番|sequential/i });
      if ((await box.isChecked()) !== sequential) await box.click();
      await runVerify(page);
      await page.getByTestId("series-extractor-extract-btn").click();
      await page.getByText(/コピー完了|Copy complete|Copied/).first().waitFor({ timeout: 60_000 });
      const entries = fs.readdirSync(dest);
      const dirs = entries.filter((e) => fs.statSync(path.join(dest, e)).isDirectory());
      const files = dirs.reduce((a, dname) => a + fs.readdirSync(path.join(dest, dname)).length, 0);
      const expFiles = exp.reduce((a, m) => a + m.instances, 0);
      check(dirs.length === exp.length, `${sequential ? "連番" : "名前付き"}: フォルダ数 = 一致シリーズ数`, { dirs, exp: exp.length });
      check(files === expFiles, "コピーされたファイル数 = 一致シリーズの枚数合計", { files, expFiles });
      if (sequential) {
        check(dirs.every((x) => /^\d{3}$/.test(x)), "フォルダ名が 001… の連番", dirs);
        check(entries.includes("mapping_table.csv"), "mapping_table.csv がある");
      } else {
        check(dirs.every((x) => !/^\d{3}$/.test(x)), "連番にしない: 元の名前（患者ID_日付_…）", dirs);
        check(entries.includes("extracted_series_list.csv"), "extracted_series_list.csv がある");
      }
      check(entries.includes("series_datasheet.csv"), "出力先にデータシートも置かれる");
    }
    await page.screenshot({ path: path.join(OUT_DIR, "3-after-extract.png") });
    await dlg(page).locator("button[aria-label]").first().click();
    await dlg(page).waitFor({ state: "detached", timeout: 5_000 });
    check(true, "ダイアログを閉じる（✕）");

    // ── DB 管理のタブ ──────────────────────────────────────────
    console.log("\n[10] DB 管理の「シリーズ抽出」タブ: 対象を絞る");
    const BENCH = "C:/Users/t_kob/gxse-bench";
    const haveSyn = fs.existsSync(`${BENCH}/small`) && fs.existsSync(`${BENCH}/small2`) && fs.existsSync(`${BENCH}/dicom`);
    if (!haveSyn) console.log("  [未達] 合成データ（gxse-bench/small, small2, dicom）が無い。絞り込みの検査は未実施");
    if (haveSyn) console.log(`  import small: ${JSON.stringify(await importPaths(d.ports.http, [`${BENCH}/small`]))}`);
    const scopeApi = (body: unknown) => api<{ studies: number; series: number; instances: number }>(page, "/api/series-extract/scope", { conditions: [], ...(body as object) });
    const allUids = await studyUids(page);
    await page.getByTestId("mainscreen-menu-system").click();
    await page.getByTestId("menu-item-dbadmin").click();
    await page.getByTestId("dbadmin-tab-series").click();
    await page.getByTestId("series-extractor-panel").waitFor({ state: "visible", timeout: 10_000 });
    const counts = page.getByTestId("series-scope-counts");
    const whole = await scopeApi({ filters: {} });
    await page.waitForTimeout(900);
    check(/DB 全体|Whole DB/.test(await counts.innerText()), "絞り込みなしは「DB 全体」と表示される");
    check((await counts.innerText()).includes(`${whole.studies} スタディ`) && (await counts.innerText()).includes(`${whole.series} シリーズ`),
      "規模の表示が API の数え方と一致（スタディ・シリーズ）", { ui: await counts.innerText(), api: whole });
    const nDb = await runVerify(page);
    const allTruth = await truth(page, allUids, []);
    check(nDb === allTruth.length, "DB 全体: 条件なしの行数が API の全シリーズ数と一致", { nDb, api: allTruth.length });
    await page.screenshot({ path: path.join(OUT_DIR, "4-dbadmin-tab.png") });

    if (haveSyn) {
      // 患者で絞る
      await page.getByTestId("series-scope-patient-id").fill("P000");
      await page.waitForTimeout(900);
      const p0 = await scopeApi({ filters: { patientId: "P000" } });
      check(p0.studies >= 1 && p0.studies < whole.studies, "患者 P000 の規模は全体より小さい（絞れている）", { p0, whole });
      check((await counts.innerText()).includes(`${p0.studies} スタディ`) && !/DB 全体|Whole DB/.test(await counts.innerText()),
        "絞ると規模の表示が変わり、「DB 全体」が消える", await counts.innerText());
      const nP0 = await runVerify(page);
      const p0uids = (await page.evaluate(async (b) => (await (await fetch(`${b}/api/studies?patientId=P000`)).json()), BASE)) as { studyInstanceUid: string }[];
      const p0truth = await truth(page, p0uids.map((x) => x.studyInstanceUid), []);
      check(nP0 === p0truth.length && nP0 >= 1, "患者 P000: 画面の行数 = API", { nP0, api: p0truth.length });
      const pidsInTable = await page.getByTestId("series-extractor-result-table").locator("tbody tr td:first-child").allInnerTexts();
      check(pidsInTable.every((x) => x.trim() === "P000"), "負例: 他の患者のシリーズが混ざらない", [...new Set(pidsInTable)]);

      // スタディを 1 件外す
      await page.getByTestId("series-scope-pick-btn").click();
      const list = page.getByTestId("series-scope-list");
      await list.waitFor({ state: "visible", timeout: 10_000 });
      const boxes = list.locator('input[type="checkbox"][data-testid^="series-scope-study-"]');
      await boxes.first().waitFor({ timeout: 10_000 });
      const nBoxes = await boxes.count();
      check(nBoxes === p0.studies, "一覧にその患者のスタディだけが並ぶ", { nBoxes, studies: p0.studies });
      const firstTid = (await boxes.first().getAttribute("data-testid")) ?? "";
      const firstUid = firstTid.replace("series-scope-study-", "");
      await boxes.first().uncheck();
      await page.waitForTimeout(900);
      check(/選択中|selected/.test(await counts.innerText()), "外すと「選択中 n / total」が出る", await counts.innerText());
      const keep = p0uids.map((x) => x.studyInstanceUid).filter((u) => u !== firstUid);
      const nKeep = await runVerify(page);
      const keepTruth = await truth(page, keep, []);
      check(nKeep === keepTruth.length, "1 件外した対象: 画面の行数 = API", { nKeep, api: keepTruth.length });
      check(nKeep < p0truth.length, "負例: 外したスタディのシリーズは結果に出ない", { nKeep, before: p0truth.length });
      await page.screenshot({ path: path.join(OUT_DIR, "5-scope-picked.png") });

      // 検証のあとに足したデータは、データシート・抽出に入らない（再探索していない）
      console.log("\n[11] 検証済みの一覧を使う（再探索しない）");
      const rowsBefore = await rowCount(page);
      console.log(`  import small2: ${JSON.stringify(await importPaths(d.ports.http, [`${BENCH}/small2`]))}`);
      for (const f of fs.readdirSync(dlDir)) if (f.endsWith(".csv")) fs.rmSync(path.join(dlDir, f));
      await page.getByTestId("series-extractor-datasheet-btn").click();
      await page.waitForTimeout(2500);
      console.log(`  datasheet files: ${JSON.stringify(fs.readdirSync(dlDir))}`);
      const csvName2 = fs.readdirSync(dlDir).filter((f) => f.endsWith("series_datasheet.csv")).sort().pop();
      const csv2 = csvName2 ? fs.readFileSync(path.join(dlDir, csvName2), "utf8").replace(/^\uFEFF/, "") : "";
      const lines2 = csv2.split(/\r?\n/).filter(Boolean);
      check(lines2.length - 1 === rowsBefore, "データシートの行数 = 検証した行数（後から取り込んだ分は入らない）", { csv: lines2.length - 1, rowsBefore });
      // 対象を変えれば結果は捨てられ、抽出ボタンは再検証まで使えない
      await page.getByTestId("series-scope-patient-id").fill("");
      await page.waitForTimeout(900);
      check(await page.getByTestId("series-extractor-extract-btn").isDisabled(), "対象を変えると結果が捨てられ、抽出は再検証まで押せない（負例）");
    }

    // 大規模: 300 スタディ・約 5,400 ファイルを取り込み、進捗・残り時間・中止・結果の上限を実際に見る
    console.log("\n[12] 大規模（合成 300 スタディ）");
    if (fs.existsSync(`${BENCH}/dicom`)) {
      const t0 = Date.now();
      console.log(`  import big: ${JSON.stringify(await importPaths(d.ports.http, [`${BENCH}/dicom`]))} (${Math.round((Date.now() - t0) / 1000)} s)`);
      await page.getByTestId("series-scope-patient-id").fill("");
      await page.getByTestId("series-scope-refresh").click();
      await page.waitForTimeout(1500);
      const bigScope = await scopeApi({ filters: {} });
      check((await counts.innerText()).includes(`${bigScope.series} シリーズ`), "大きな DB でも規模が API と一致", { ui: await counts.innerText(), api: bigScope });
      // 進捗と中止
      await page.getByTestId("series-extractor-verify-btn").click();
      await page.getByTestId("series-extractor-progress").waitFor({ state: "visible", timeout: 10_000 });
      const seen: string[] = [];
      for (let i = 0; i < 8; i++) {
        seen.push(await page.getByTestId("series-extractor-progress").innerText().catch(() => ""));
        await page.waitForTimeout(250);
      }
      check(seen.some((x) => /探索中|Scanning/.test(x) && /\d+ \/ \d+/.test(x)), "探索中に進捗（n / 総数）が出る", seen.slice(0, 3));
      await page.screenshot({ path: path.join(OUT_DIR, "6-progress.png") });
      await page.getByTestId("series-extractor-cancel-btn").click().catch(() => {});
      await page.waitForTimeout(3000);
      const cancelled = (await page.getByText(/検証を中止|Verification cancelled/).count()) > 0;
      const finished = (await page.getByTestId("series-extractor-result-table").count()) > 0;
      check(cancelled || finished, "中止を押すと止まる（または既に終わっている）", { cancelled, finished });
      // 最後まで走らせて上限表示
      const nBig = await runVerify(page);
      check(nBig === 1000, "結果表は先頭 1000 行だけ描画する", nBig);
      check((await page.getByTestId("series-extractor-result-cap").count()) === 1, "「全 N 件（表示は先頭 1000 件）」の注記が出る");
      const bigTruth = await truth(page, await studyUids(page), []);
      check((await page.getByTestId("series-extractor-result-cap").innerText()).includes(String(bigTruth.length)), "注記の総数が API の一致数と一致", { n: bigTruth.length });
      await page.screenshot({ path: path.join(OUT_DIR, "7-big.png") });
    } else {
      console.log("  [未達] gxse-bench/dicom が無い");
    }
    await page.getByRole("button", { name: /患者|Patients/ }).first().click();
    await page.getByTestId("dbadmin-tab-series").click();
    check((await rowCount(page)) >= 1, "タブを往復しても結果が残る");
  } finally {
    await d.stop();
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

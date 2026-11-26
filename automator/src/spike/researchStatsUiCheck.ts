/*
 * 研究統計プラグイン（Research Stats）の画面の実機検証スパイク（Electron・実 backend）。
 *
 * 実行:  cd automator && RS_PLUGIN_DIR=<plugin.json と ui.js のあるフォルダ> RS_FEAT=<特徴量の CSV> RS_CLIN=<PatientID 鍵の臨床 CSV> \
 *          RS_CLIN_SUBJECT=<SubjectCode 鍵の臨床 CSV> RS_OUT=<撮影の保存先> \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=19680 GRAPHY_AUTOMATOR_SCP_PORT=19681 GRAPHY_AUTOMATOR_VITE_PORT=19683 \
 *          AUTOMATOR_DATA_DIR=$PWD/.results/run-data/rs-ui timeout 900 npx tsx src/spike/researchStatsUiCheck.ts
 *   前提: backend jar を今のコードで作り直してある。
 *
 *   [1] ファイルを選ぶと、名前・行数・列数が一覧に残る（以前は No file chosen のまま）。取り消し（×）で外れる
 *   [2] データセットの確認（Skill から独立）: ID の列が、実際の値の重なりから選ばれ、結合できた人数が出る
 *   [3] 結合できないデータ（重なり 0）では、次の区画（解析の種類）が無効になり、理由が出る。結合できるデータで有効になる（負例と正例）
 *   [4] 解析の種類を選ぶと、その解析の目的変数だけが、臨床 CSV のヘッダーから選べて、型の検査が出る
 *   [5]（RS_FEAT_2D があれば）2D の単位を含む表: ID の重複で止まらない。「解析に使う単位」の既定は WHOLE_3D。絞り込みと平均の注意
 *   [4b]（RS_FEAT56・RS_CLIN56 があれば）P4（生存）を既定のまま実行する: 結果の型が生存と推定され、層化の欄が詳細設定の外にある
 *   [7]（RS_FEAT56・RS_CLIN56 があれば）前処理の区画: Skill ごとに出る手順が変わる。R2 で分散 0・相関の除外と正規性の報告、
 *       P4（2 値）で対応なしの p 値による除外（訓練側の内側）を実行し、結果・CSV・リーク検査（OK）を確かめる
 *   [6]（RS_FEAT_LEAK・RS_CLIN56 があれば）リーク検査: ID・記録の列（RowIndex）、目的変数の混入（LeakSep）を検出し、外せる。
 *       リークの無い表（元の 56 例の表）では検出しない（負例）
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { dismissUpdateDialog } from "./dismissUpdateDialog.js";

const PLUGIN_DIR = process.env.RS_PLUGIN_DIR ?? "";
const FEAT = process.env.RS_FEAT ?? "";
const CLIN = process.env.RS_CLIN ?? "";
const CLIN_SUBJECT = process.env.RS_CLIN_SUBJECT ?? "";
const FEAT_2D = process.env.RS_FEAT_2D ?? ""; // 2D の単位を含む一括抽出の表
const FEAT_LEAK = process.env.RS_FEAT_LEAK ?? ""; // 56 例の表に、リークの列（LeakSep・RowIndex）を足したもの
const CLIN56 = process.env.RS_CLIN56 ?? ""; // その臨床表（SubjectCode 鍵）
const FEAT_CLEAN56 = process.env.RS_FEAT56 ?? ""; // 56 例の表（SubjectCode 鍵）。前処理の検証用
const FEAT_SYNTH2D = process.env.RS_FEAT_SYNTH2D ?? ""; // 56 例の各症例に WHOLE_3D と MAX_SECTION_2D の 2 行を持つ合成の表（流れの検査用。値に意味は無い）
const OUT = process.env.RS_OUT ?? path.join(AUTOMATOR_ROOT, ".results", "rs-ui-check");
const PLUGIN_ID = "research-stats";

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log(`  [ok  ] ${label}`); } else { console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); failures.push(label); }
}

/** 特徴量の欄は、選び直すと「追加」になる。別の表に替えるときは、読み込み済みのものを先に外す。 */
async function clearFeatures(page: import("@playwright/test").Page): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const x = page.getByTestId("rs-file-features-remove-0");
    if (!(await x.count())) break;
    await x.click();
    await page.waitForTimeout(300);
  }
}

async function main(): Promise<void> {
  for (const p of [PLUGIN_DIR, FEAT, CLIN, CLIN_SUBJECT]) if (!p || !fs.existsSync(p)) { console.log(`[未達] 入力が無い: ${p}`); process.exitCode = 2; return; }
  fs.mkdirSync(OUT, { recursive: true });
  // 重なりが 0 の臨床 CSV（負例）。ID を別の値にする
  const noOverlap = path.join(OUT, "clinical-no-overlap.csv");
  fs.writeFileSync(noOverlap, "PatientID,EGFR\nX001,Mutant\nX002,Wildtype\nX003,Wildtype\n");

  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_DIR, f), path.join(dst, f));

  const d = new DesktopDriver();
  await d.start();
  try {
    const page = d.page;
    page.on("console", (m) => { if (m.type() === "error") console.log(`[renderer error] ${m.text().slice(0, 300)}`); });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissUpdateDialog(page, 8000);
    await page.getByTestId("mainscreen-menu-plugins").click({ timeout: 10_000 });
    await page.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    await page.getByTestId("rs-root").waitFor({ state: "visible", timeout: 15_000 });
    const root = page.getByTestId("rs-root");
    await root.screenshot({ path: path.join(OUT, "01-initial.png") });
    check((await page.getByTestId("rs-loaded").count()) === 0, "ファイルを選ぶ前は、読み込んだファイルの一覧が空");
    check(await page.getByTestId("rs-reason-check").isVisible().catch(() => false) || (await root.innerText()).length > 0, "最初の画面が出る");

    console.log("\n[1] ファイルの選択と一覧");
    await page.getByTestId("rs-file-features").setInputFiles([FEAT]);
    await page.getByTestId("rs-file-clinical").setInputFiles(CLIN);
    await page.waitForTimeout(1500);
    const loaded = await page.getByTestId("rs-loaded").allInnerTexts();
    console.log(`  読み込み一覧: ${JSON.stringify(loaded.map((x) => x.replace(/\s+/g, " ")))}`);
    check(loaded.length === 2 && loaded.some((x) => x.includes(path.basename(FEAT))) && loaded.some((x) => x.includes(path.basename(CLIN))),
      "選んだ 2 ファイルの名前が一覧に出る（No file chosen のままにならない）", loaded);
    check(loaded.every((x) => /\d/.test(x)), "行数・列数が一覧に出る", loaded);
    await root.screenshot({ path: path.join(OUT, "02-loaded.png") });
    // 別の操作（再描画）のあとも残る
    await page.getByTestId("rs-seed").scrollIntoViewIfNeeded().catch(() => undefined);
    check((await page.getByTestId("rs-loaded").count()) === 2, "再描画のあとも、一覧が残る");

    console.log("\n[2] データセットの確認（Skill から独立）");
    await page.getByTestId("rs-check-pass").waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
    const pairs = await page.getByTestId("rs-best-pair").innerText().catch(() => "");
    console.log(`  最良の組: ${pairs.replace(/\s+/g, " ")}`);
    const counts = await page.getByTestId("rs-counts").innerText().catch(() => "");
    console.log(`  人数: ${counts.replace(/\s+/g, " ")}`);
    check(await page.getByTestId("rs-check-pass").isVisible().catch(() => false), "結合できて、確認が通る");
    check(/PatientID/.test(pairs), "ID の列の候補が、値の重なりから PatientID になる", pairs);
    check(/3/.test(counts), "結合できた人数（3）が出る", counts);
    const skillOptions = await page.getByTestId("rs-skill").locator("option").allInnerTexts();
    console.log(`  Skill の選択肢: ${JSON.stringify(skillOptions)}`);
    check(!skillOptions.some((o) => /Dataset check|データセットの確認/.test(o)), "Skill の選択肢に Dataset check が無い（独立した手順になった）", skillOptions);
    await root.screenshot({ path: path.join(OUT, "03-check.png") });

    console.log("\n[3] 結合できないデータ（負例）と、できるデータ（正例）");
    await page.getByTestId("rs-file-clinical").setInputFiles(noOverlap);
    await page.waitForTimeout(1500);
    const noNote = await page.getByTestId("rs-note-no-overlap").isVisible().catch(() => false);
    const zero = await page.getByTestId("rs-zero-joined").isVisible().catch(() => false);
    const skillDisabled = await page.getByTestId("rs-skill").isDisabled().catch(() => true);
    console.log(`  重なり 0 の注意: ${noNote}、結合 0 人の表示: ${zero}、Skill が無効: ${skillDisabled}`);
    check(noNote || zero, "重なりが 0 のデータでは、その旨が出る", { noNote, zero });
    check(skillDisabled, "結合できないあいだ、解析の種類が選べない（無効）");
    check(await page.getByTestId("rs-reason-skill").isVisible().catch(() => false) || (await root.innerText()).includes("確認"), "次へ進めない理由が出る");
    await root.screenshot({ path: path.join(OUT, "04-no-overlap.png") });
    await page.getByTestId("rs-file-clinical").setInputFiles(CLIN_SUBJECT);
    await page.waitForTimeout(1500);
    const best2 = await page.getByTestId("rs-best-pair").innerText().catch(() => "");
    console.log(`  SubjectCode 鍵の臨床表での最良の組: ${best2.replace(/\s+/g, " ")}`);
    check(await page.getByTestId("rs-check-pass").isVisible().catch(() => false), "SubjectCode 鍵の臨床表でも、重なりの最大の組が選ばれて結合できる（以前は 0 行）");
    check(/SubjectCode/.test(best2), "その組は SubjectCode", best2);
    check(!(await page.getByTestId("rs-skill").isDisabled().catch(() => true)), "結合できると、解析の種類が選べる");
    await page.getByTestId("rs-file-clinical").setInputFiles(CLIN);
    await page.waitForTimeout(1200);

    console.log("\n[4] 解析の種類と目的変数");
    await page.getByTestId("rs-skill").selectOption("r2-discrimination");
    await page.waitForTimeout(500);
    const hasOutcome = await page.getByTestId("rs-outcome").isVisible().catch(() => false);
    const hasTime = await page.getByTestId("rs-time").count();
    check(hasOutcome && hasTime === 0, "2 群の判別: 結果ラベルが選べて、時間は出ない", { hasOutcome, hasTime });
    const outcomeOpts = await page.getByTestId("rs-outcome").locator("option").allInnerTexts();
    console.log(`  結果ラベルの選択肢（臨床 CSV のヘッダー）: ${JSON.stringify(outcomeOpts)}`);
    check(outcomeOpts.includes("EGFR"), "選択肢は、実際の臨床 CSV のヘッダー（EGFR がある）", outcomeOpts);
    await page.getByTestId("rs-outcome").selectOption("EGFR");
    await page.waitForTimeout(500);
    await root.screenshot({ path: path.join(OUT, "05-r2.png") });
    const qcText = await root.innerText();
    check(/Wildtype|Mutant/.test(qcText), "選んだ列の値と人数が、その場で出る", qcText.slice(0, 80));
    await page.getByTestId("rs-skill").selectOption("r1-prognosis");
    await page.waitForTimeout(500);
    check((await page.getByTestId("rs-time").isVisible().catch(() => false)) && (await page.getByTestId("rs-event").isVisible().catch(() => false)) && !(await page.getByTestId("rs-outcome").isVisible().catch(() => false)),
      "生存との関連: 時間とイベントが出て、結果ラベルは出ない");
    await root.screenshot({ path: path.join(OUT, "06-r1.png") });
    if (FEAT_2D && fs.existsSync(FEAT_2D)) {
      console.log("\n[5] 2D の単位を含む表");
      await clearFeatures(page);
      await page.getByTestId("rs-file-features").setInputFiles([FEAT_2D]);
      await page.getByTestId("rs-file-clinical").setInputFiles(CLIN);
      await page.waitForTimeout(2500);
      const errs = await page.getByTestId("rs-check-errors").innerText().catch(() => "");
      check(!/重複/.test(errs), "行の ID が重複していても、止まらない（以前は「行の ID「C001」が重複しています」で止まった）", errs);
      check(await page.getByTestId("rs-check-pass").isVisible().catch(() => false), "結合できて、確認が通る");
      const fid = await page.getByTestId("rs-feature-id").inputValue().catch(() => "");
      console.log(`  行 ID の列: ${fid}`);
      check(fid === "RowKey", "行 ID は一意な RowKey が自動で選ばれる", fid);
      check(await page.getByTestId("rs-units").isVisible().catch(() => false), "「解析に使う単位」の欄が出る");
      const w3d = page.getByTestId("rs-unit-Unit-WHOLE_3D");
      const ms2d = page.getByTestId("rs-unit-Unit-MAX_SECTION_2D");
      check((await w3d.isChecked()) && !(await ms2d.isChecked()), "既定は WHOLE_3D だけが選ばれている");
      check(!(await page.getByTestId("rs-note-averaged").isVisible().catch(() => false)), "WHOLE_3D だけなら、平均の注意は出ない（患者ごとに 1 行）");
      await root.screenshot({ path: path.join(OUT, "07-2d-default.png") });
      await ms2d.check();
      await page.waitForTimeout(1200);
      const avg = await page.getByTestId("rs-note-averaged").innerText().catch(() => "");
      console.log(`  平均の注意: ${avg.replace(/\s+/g, " ")}`);
      check(/平均/.test(avg), "WHOLE_3D と MAX_SECTION_2D の両方を選ぶと、患者ごとに平均される旨の注意が出る", avg);
      await root.screenshot({ path: path.join(OUT, "08-2d-both.png") });
      await w3d.uncheck();
      await page.waitForTimeout(1000);
      check(await page.getByTestId("rs-check-pass").isVisible().catch(() => false), "MAX_SECTION_2D だけでも結合できる");
      await ms2d.uncheck();
      await page.waitForTimeout(1000);
      check(await page.getByTestId("rs-check-errors").isVisible().catch(() => false), "1 行も残らない選択では、エラーが出て先へ進めない（負例）");
      await w3d.check();
      await page.waitForTimeout(800);
    }
    if (FEAT_LEAK && CLIN56 && fs.existsSync(FEAT_LEAK) && fs.existsSync(CLIN56)) {
      console.log("\n[6] リーク検査");
      await clearFeatures(page);
      await page.getByTestId("rs-file-features").setInputFiles([FEAT_LEAK]);
      await page.getByTestId("rs-file-clinical").setInputFiles(CLIN56);
      await page.waitForTimeout(3000);
      const cols = await page.getByTestId("rs-leak-col").allInnerTexts().catch(() => []);
      console.log(`  ID・記録の列の警告: ${JSON.stringify(cols.map((c) => c.replace(/\s+/g, " ")))}`);
      check(cols.some((c) => c.includes("RowIndex")), "連番の列（RowIndex）が、ID・記録の列として警告される");
      await root.screenshot({ path: path.join(OUT, "09-leak-cols.png") });
      await page.getByTestId("rs-skill").selectOption("r2-discrimination");
      await page.getByTestId("rs-outcome").selectOption("EGFR");
      await page.waitForTimeout(1500);
      const tgt = await page.getByTestId("rs-leak-target").innerText().catch(() => "");
      console.log(`  目的変数の混入: ${tgt.replace(/\s+/g, " ").slice(0, 200)}`);
      check(/LeakSep/.test(tgt), "結果ラベルを完全に分ける列（LeakSep）が、目的変数の混入として警告される");
      await root.screenshot({ path: path.join(OUT, "10-leak-target.png") });
      await page.getByTestId("rs-leak-target-exclude-LeakSep").click();
      await page.waitForTimeout(1200);
      check(!(await page.getByTestId("rs-leak-target").isVisible().catch(() => false)), "「特徴量から外す」と、警告が消える");
      // 負例: リークの無い元の表
      const clean = FEAT_LEAK.replace("nsclc_leak56.csv", "nsclc_clean56.csv");
      if (fs.existsSync(clean)) {
        await clearFeatures(page);
        await page.getByTestId("rs-file-features").setInputFiles([clean]);
        await page.waitForTimeout(2500);
        const cols2 = await page.getByTestId("rs-leak-col").count();
        const tgt2 = await page.getByTestId("rs-leak-target").isVisible().catch(() => false);
        check(cols2 === 0 && !tgt2, "リークの無い表では、警告が出ない（負例）", { cols2, tgt2 });
      }
    }
    if (FEAT_CLEAN56 && CLIN56 && fs.existsSync(FEAT_CLEAN56) && fs.existsSync(CLIN56)) {
      console.log("\n[4b] P4（生存）を既定のまま実行する（設定には触れない）");
      await clearFeatures(page);
      await page.getByTestId("rs-file-features").setInputFiles([FEAT_CLEAN56]);
      await page.getByTestId("rs-file-clinical").setInputFiles(CLIN56);
      await page.waitForTimeout(3000);
      await page.getByTestId("rs-skill").selectOption("p4-pipeline");
      await page.waitForTimeout(800);
      const v = (id: string) => page.getByTestId(id).inputValue().catch(() => "(無い)");
      const shown = { kind: await v("rs-p4-kind"), strat: await v("rs-p4-strat"), lock: await v("rs-p4-lock"), outer: await v("rs-p4-outer"), inner: await v("rs-p4-inner"), repeats: await v("rs-p4-repeats"), k: await v("rs-p4-k") };
      console.log(`  画面の値: ${JSON.stringify(shown)}`);
      check(JSON.stringify(shown) === JSON.stringify({ kind: "survival", strat: "true", lock: "none", outer: "5", inner: "5", repeats: "1", k: "1, 2, 4, 8" }), "既定が入っている（結果の型は生存と推定）", shown);
      check(await page.getByTestId("rs-p4-strat").isVisible(), "層化の欄が見えている（詳細設定を開かない）");
      check(await page.getByTestId("rs-p4-strat").evaluate((e) => !e.closest("details")), "層化の欄は詳細設定の外");
      await page.getByTestId("rs-p4-strat").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, "17-p4-defaults-window.png") });
      await page.getByTestId("rs-root").screenshot({ path: path.join(OUT, "18-p4-defaults.png") });
      await page.getByTestId("rs-run").click();
      const st9 = await Promise.race([
        page.getByTestId("rs-p4-cv").waitFor({ state: "visible", timeout: 900_000 }).then(() => "ok"),
        page.getByTestId("rs-errors").waitFor({ state: "visible", timeout: 900_000 }).then(() => "errors"),
      ]);
      check(st9 === "ok", "P4（生存）が既定のまま最後まで実行できる", await page.getByTestId("rs-errors").innerText().catch(() => ""));
      console.log(`  交差検証: ${(await page.getByTestId("rs-p4-cv").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300)}`);
      await page.getByTestId("rs-p4-cv").screenshot({ path: path.join(OUT, "19-p4-defaults-result.png") });
    }
    if (FEAT_CLEAN56 && CLIN56 && fs.existsSync(FEAT_CLEAN56) && fs.existsSync(CLIN56)) {
      console.log("\n[7] 前処理の区画");
      await page.evaluate(`window.__dl = []; (function(){ var orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function(){ var a=this; if (a.download && a.href.indexOf('blob:')===0){ var n=a.download; fetch(a.href).then(function(r){return r.text();}).then(function(t){window.__dl.push({name:n,text:t});}); return; } return orig.call(this); }; })()`);
      await clearFeatures(page);
      await page.getByTestId("rs-file-features").setInputFiles([FEAT_CLEAN56]);
      await page.getByTestId("rs-file-clinical").setInputFiles(CLIN56);
      await page.waitForTimeout(3000);
      check(await page.getByTestId("rs-check-pass").isVisible().catch(() => false), "56 例の表が結合できる");
      const setNum = async (id: string, v: string) => { await page.getByTestId(id).fill(v); await page.getByTestId(id).press("Enter"); };
      // R2
      await page.getByTestId("rs-skill").selectOption("r2-discrimination");
      await page.getByTestId("rs-outcome").selectOption("EGFR");
      await page.getByTestId("rs-positive").selectOption("Mutant");
      await page.waitForTimeout(500);
      check(await page.getByTestId("rs-pre-const").isVisible().catch(() => false) && await page.getByTestId("rs-pre-corr").isVisible().catch(() => false), "R2: 分散 0・相関の除外が出る");
      check(await page.getByTestId("rs-pre-assump-on").isVisible().catch(() => false), "R2: 正規性・等分散性の報告が出る");
      check(!(await page.getByTestId("rs-pre-unpaired-on").isVisible().catch(() => false)), "R2: p 値による除外は出ない（負例。R2 本体の p 値は変えない）");
      await root.screenshot({ path: path.join(OUT, "11-pre-r2.png") });
      await page.getByTestId("rs-pre-const").check();
      await setNum("rs-pre-corr", "0.95");
      await page.getByTestId("rs-pre-assump-on").check();
      await setNum("rs-pre-assump-alpha", "0.05");
      await page.getByTestId("rs-run").click();
      await page.getByTestId("rs-pre-result").waitFor({ state: "visible", timeout: 120_000 });
      const preText = (await page.getByTestId("rs-pre-result").innerText()).replace(/\s+/g, " ");
      console.log(`  R2 前処理の結果: ${preText.slice(0, 260)}`);
      check(/除/.test(preText), "R2: 前処理で除いた特徴量と理由が結果に出る", preText.slice(0, 120));
      await root.screenshot({ path: path.join(OUT, "12-pre-r2-result.png") });
      await page.getByTestId("rs-save-assumptions").click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      const dl = (await page.evaluate("window.__dl.splice(0)")) as { name: string; text: string }[];
      console.log(`  書き出し: ${JSON.stringify(dl.map((x) => x.name))}`);
      const asm = dl.find((x) => /assumptions/.test(x.name));
      check(!!asm && asm.text.split("\n").length > 10, "正規性・等分散性の報告の CSV が書き出せる", dl.map((x) => x.name));
      // P4（2 値）
      await page.getByTestId("rs-skill").selectOption("p4-pipeline");
      await page.getByTestId("rs-p4-kind").selectOption("binary");
      await page.getByTestId("rs-outcome").selectOption("EGFR");
      await page.getByTestId("rs-positive").selectOption("Mutant");
      await page.getByTestId("rs-p4-lock").selectOption("none");
      await setNum("rs-p4-outer", "5"); await setNum("rs-p4-inner", "3"); await setNum("rs-p4-repeats", "2"); await setNum("rs-p4-k", "1, 2, 3");
      await page.waitForTimeout(500);
      check(await page.getByTestId("rs-pre-unpaired-on").isVisible().catch(() => false), "P4（2 値）: 対応なしの p 値による除外が出る");
      await page.getByTestId("rs-pre-unpaired-on").check();
      await setNum("rs-pre-unpaired-alpha", "0.05");
      await setNum("rs-pre-unpaired-thr", "0.2");
      await page.waitForTimeout(500);
      console.log(`  計算量の目安: ${(await page.getByTestId("rs-pre-unpaired-cost").innerText().catch(() => "")).replace(/\s+/g, " ")}`);
      await root.screenshot({ path: path.join(OUT, "13-pre-p4.png") });
      await page.getByTestId("rs-run").click();
      const st = await Promise.race([
        page.getByTestId("rs-p4-cv").waitFor({ state: "visible", timeout: 600_000 }).then(() => "ok"),
        page.getByTestId("rs-errors").waitFor({ state: "visible", timeout: 600_000 }).then(() => "errors"),
      ]);
      check(st === "ok", "P4: p 値による除外を訓練側の内側で行って、最後まで実行できる", await page.getByTestId("rs-errors").innerText().catch(() => ""));
      const lvl = await page.getByTestId("rs-p4-leak-rows").getAttribute("data-level").catch(() => null);
      const lvlText = (await page.getByTestId("rs-p4-leak-rows").innerText().catch(() => "")).replace(/\s+/g, " ");
      console.log(`  リーク検査（前処理が検証データを見ていないか）: level=${lvl}: ${lvlText.slice(0, 200)}`);
      check(lvl === "ok" || lvl === "notice", "p 値による除外は訓練側の内側だけ（リーク検査が NG でない）", lvl);
      const dl2 = (await page.evaluate("window.__dl.splice(0)")) as { name: string }[];
      void dl2;
      await page.getByTestId("rs-save-p4-pdrop").click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      const dl3 = (await page.evaluate("window.__dl.splice(0)")) as { name: string; text: string }[];
      console.log(`  p 値による除外の記録の書き出し: ${JSON.stringify(dl3.map((x) => x.name))}`);
      check(dl3.some((x) => /pdrop/.test(x.name) && x.text.split("\n").length > 5), "折ごとの p 値による除外の記録が CSV に書き出せる", dl3.map((x) => x.name));
      await root.screenshot({ path: path.join(OUT, "14-pre-p4-result.png") });
    }
    if (FEAT_SYNTH2D && CLIN56 && fs.existsSync(FEAT_SYNTH2D) && fs.existsSync(CLIN56)) {
      console.log("\n[8] 行のまま解析（P4 のみ）");
      await clearFeatures(page);
      await page.getByTestId("rs-file-features").setInputFiles([FEAT_SYNTH2D]);
      await page.getByTestId("rs-file-clinical").setInputFiles(CLIN56);
      await page.waitForTimeout(3000);
      // 単位を両方選ぶ → 同じ患者に 2 行が残る
      await page.getByTestId("rs-unit-Unit-MAX_SECTION_2D").check();
      await page.waitForTimeout(1500);
      check(await page.getByTestId("rs-rows-mode").isVisible().catch(() => false), "同じ患者に複数行が残ると、「行の扱い」が出る");
      const setNum = async (id: string, v: string) => { await page.getByTestId(id).fill(v); await page.getByTestId(id).press("Enter"); };
      await page.getByTestId("rs-skill").selectOption("r2-discrimination");
      await page.waitForTimeout(500);
      const optsR2 = await page.getByTestId("rs-rows-mode").locator("option").evaluateAll((os) => os.map((o) => ({ v: (o as HTMLOptionElement).value, dis: (o as HTMLOptionElement).disabled })));
      console.log(`  R2 の「行の扱い」: ${JSON.stringify(optsR2)}`);
      check(optsR2.some((o) => /as-?is/i.test(o.v) && o.dis) || !(await page.getByTestId("rs-rows-mode").isEnabled().catch(() => true)), "R2 では「行のまま」が選べない（理由が出る）", optsR2);
      check(await page.getByTestId("rs-rows-mode-reason").isVisible().catch(() => false), "R2: 選べない理由が出る");
      await page.getByTestId("rs-skill").selectOption("p4-pipeline");
      await page.getByTestId("rs-p4-kind").selectOption("binary");
      await page.getByTestId("rs-outcome").selectOption("EGFR");
      await page.getByTestId("rs-positive").selectOption("Mutant");
      await page.getByTestId("rs-p4-lock").selectOption("none");
      await setNum("rs-p4-outer", "5"); await setNum("rs-p4-inner", "3"); await setNum("rs-p4-repeats", "2"); await setNum("rs-p4-k", "1, 2, 3");
      await page.waitForTimeout(500);
      const optsP4 = await page.getByTestId("rs-rows-mode").locator("option").evaluateAll((os) => os.map((o) => ({ v: (o as HTMLOptionElement).value, dis: (o as HTMLOptionElement).disabled })));
      console.log(`  P4 の「行の扱い」: ${JSON.stringify(optsP4)}`);
      check(optsP4.every((o) => !o.dis), "P4 では「行のまま」が選べる", optsP4);
      const asis = optsP4.find((o) => /as-?is|row/i.test(o.v) && !/avg|average|mean/i.test(o.v))?.v;
      await page.getByTestId("rs-rows-mode").selectOption(asis ?? optsP4[1].v);
      await page.getByTestId("rs-p4-missing").selectOption("impute"); // 欠損のある特徴量があるので、訓練の分割の中央値で補う
      await page.waitForTimeout(800);
      await root.screenshot({ path: path.join(OUT, "15-rows-asis.png") });
      await page.getByTestId("rs-run").click();
      const st8 = await Promise.race([
        page.getByTestId("rs-p4-cv").waitFor({ state: "visible", timeout: 900_000 }).then(() => "ok"),
        page.getByTestId("rs-errors").waitFor({ state: "visible", timeout: 900_000 }).then(() => "errors"),
      ]);
      check(st8 === "ok", "P4: 行のままで、最後まで実行できる", await page.getByTestId("rs-errors").innerText().catch(() => ""));
      const info = (await page.getByTestId("rs-p4-rows-asis").innerText().catch(() => "")).replace(/\s+/g, " ");
      console.log(`  行のままの表示: ${info}`);
      // EGFR が空の 12 人は除かれる（56 − 12 = 44 人 × 2 行 = 88 行）
      check(/88 行（44 人）/.test(info), "結果に、行数（88）と患者数（44）が出る", info);
      const leak = await page.getByTestId("rs-p4-leak").innerText().catch(() => "");
      console.log(`  リーク検査: ${leak.replace(/\s+/g, " ").slice(0, 200)}`);
      check(/分か|同じ患者/.test(leak) && !/NG/.test(leak), "同じ患者が訓練と検証に分かれていない（リーク検査）", leak.slice(0, 120));
      await root.screenshot({ path: path.join(OUT, "16-rows-asis-result.png") });
    }
  } finally {
    await d.stop();
  }
  console.log(`\n結果: 合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join("\n")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

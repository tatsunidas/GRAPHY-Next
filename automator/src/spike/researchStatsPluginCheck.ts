/*
 * 研究統計プラグイン（research-stats）の基盤の実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/researchStatsPluginCheck.ts   （専用ポート 19890〜19892）
 *        プラグインの作業コピー（`npm run build` 済み）は RESEARCH_STATS_PLUGIN_DIR で指定（既定は隣のリポジトリ）。
 *
 *   メイン画面の Plug-Ins からプラグインの窓を開き、合成の CSV を選んで、
 *   (1) 結合の件数・片側だけの患者・解析から除く理由が手計算と一致する
 *   (2) 書き出した CSV が手計算と一致し、欠損を 0 にしていない
 *   (3) 再現情報の SHA-256 が、ファイルを別に計算した値と一致し、シードが記録される
 *   (4) 重複した患者 ID・0/1 でないイベントは、結合せずに理由を出して止まる（負例）
 *   [10] 予後モデル（R5）: 最終の Cox・見かけの C・Schoenfeld の検定を statsmodels と突き合わせ、補正 C の再現
 *   [11] P4 の LASSO: 最終モデルの特徴量を同じ λ の scikit-learn と突き合わせ、テスト集合で評価
 *
 * 画面の見た目はスクリーンショットで目視する（DOM の有無だけで判定しない）。
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "research-stats-plugin-check");
const PLUGINS_DIR = path.join(DESKTOP_RUN_DATA_DIR, "plugins");
const PLUGIN_ID = "research-stats";
const { check, summary } = createChecker();

const FEAT_A = "CaseLabel,Patient,f1,f2,Provenance_X,Roi_Voxels\r\nL1,P1,1,10,a,100\r\nL2,P1,3,NA,a,200\r\n";
const FEAT_B = "CaseLabel,Patient,f1,f2,Provenance_X,Roi_Voxels\r\nL3,P2,5,20,a,300\r\nL4,P3,7,30,a,400\r\n";
const CLIN = "Patient,time,event,age,outcome\r\nP1,12,1,60,resp\r\nP2,8,0,70,no\r\nP4,5,1,50,resp\r\n";
const CLIN_DUP = `${CLIN}P1,3,0,40,no\r\n`;
const CLIN_BAD_EVENT = "Patient,time,event,age,outcome\r\nP1,12,2,60,resp\r\nP2,8,0,70,no\r\n";

function write(name: string, text: string): string {
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, text);
  return p;
}
const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function installPlugin(): void {
  const src = process.env.RESEARCH_STATS_PLUGIN_DIR ?? path.join(AUTOMATOR_ROOT, "..", "..", "graphy-next-plugin-research-stats");
  if (!fs.existsSync(path.join(src, "ui.js"))) throw new Error(`プラグインの ui.js がありません: ${src}（npm run build 済みの作業コピーを RESEARCH_STATS_PLUGIN_DIR で指定）`);
  const dst = path.join(PLUGINS_DIR, PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(src, f), path.join(dst, f));
}

/** 予後の解析（R1）用の合成データ。f_signal だけが生存に効く（係数 +1.2）。決定的な乱数で作る。 */
function synthR1(n: number): { feat: string; clin: string } {
  let a = 12345;
  const rnd = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  const feat = ["CaseLabel,f_signal,f_n1,f_n2,f_n3,f_n4"], clin = ["CaseLabel,time,event,age"];
  for (let i = 0; i < n; i++) {
    const sig = rnd() * 2 - 1;
    const t = (-Math.log(1 - rnd()) / Math.exp(1.2 * sig)) * 10, c = -Math.log(1 - rnd()) * 14;
    const time = Math.max(0.1, Math.round(Math.min(t, c) * 10) / 10), ev = t <= c ? 1 : 0;
    feat.push([`S${i}`, sig.toFixed(5), ...[0, 1, 2, 3].map(() => (rnd() * 4).toFixed(4))].join(","));
    clin.push(`S${i},${time},${ev},${40 + Math.floor(rnd() * 40)}`);
  }
  return { feat: feat.join("\r\n") + "\r\n", clin: clin.join("\r\n") + "\r\n" };
}

/** 判別（R2）用の合成データ。f_a は強く、f_b は中くらいに結果ラベルと関係し、f_n1〜f_n3 は無関係。決定的な乱数で作る。 */
function synthR2(n: number): { feat: string; clin: string } {
  let a = 777;
  const rnd = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  const norm = () => { let s = 0; for (let k = 0; k < 6; k++) s += rnd(); return s - 3; };
  const feat = ["CaseLabel,f_a,f_b,f_n1,f_n2,f_n3"], clin = ["CaseLabel,outcome,age"];
  for (let i = 0; i < n; i++) {
    const g = rnd() < 0.45 ? 1 : 0;
    feat.push([`D${i}`, (norm() + 1.6 * g).toFixed(4), (norm() + 0.8 * g).toFixed(4), norm().toFixed(4), norm().toFixed(4), norm().toFixed(4)].join(","));
    clin.push(`D${i},${g === 1 ? "resp" : "no"},${40 + (i % 30)}`);
  }
  return { feat: feat.join("\r\n") + "\r\n", clin: clin.join("\r\n") + "\r\n" };
}

/** 再現性（R3）用の 3 条件の合成データ。f_same は全条件で同じ、f_noisy は条件ごとに大きなばらつき、f_shift は条件 C が +5 ずれる、f_rand は無関係な乱数。 */
function synthR3(n: number): { files: string[]; missing2: string } {
  let a = 31337;
  const rnd = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  const base = Array.from({ length: n }, () => rnd() * 10);
  const files = [0, 1, 2].map((c) => {
    const lines = ["CaseLabel,f_same,f_noisy,f_shift,f_rand,f_text"];
    base.forEach((b, i) => lines.push([`R${i}`, b.toFixed(5), (b + (rnd() - 0.5) * 8).toFixed(5), (b + (c === 2 ? 5 : 0) + (rnd() - 0.5) * 0.4).toFixed(5), (rnd() * 10).toFixed(5), i === 0 ? "x" : "1"].join(",")));
    return lines.join("\r\n") + "\r\n";
  });
  // 条件 B から 2 行（R2・R3）を除いたもの（全条件に揃わない行の一覧を確かめる）
  const m2 = files[1].split("\r\n").filter((l, i) => !(i === 3 || i === 4)).join("\r\n");
  return { files, missing2: m2 };
}

/** パイプライン（P4）用の合成データ。f_a は強く、f_b は中くらいに結果と関係し、f_n1〜f_n4 は無関係、f_dup は f_a とほぼ同じ（相関で除かれる）。 */
function synthP4(n: number): { feat: string; clin: string } {
  let a = 4242;
  const rnd = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  const norm = () => { let s = 0; for (let k = 0; k < 6; k++) s += rnd(); return s - 3; };
  const feat = ["CaseLabel,f_a,f_b,f_n1,f_n2,f_n3,f_n4,f_dup"], clin = ["CaseLabel,outcome,age"];
  for (let i = 0; i < n; i++) {
    const g = rnd() < 0.45 ? 1 : 0;
    const fa = norm() + 1.3 * g;
    feat.push([`Q${i}`, fa.toFixed(4), (norm() + 0.6 * g).toFixed(4), norm().toFixed(4), norm().toFixed(4), norm().toFixed(4), norm().toFixed(4), (fa * 1.02 + 0.01 * norm()).toFixed(4)].join(","));
    clin.push(`Q${i},${g === 1 ? "resp" : "no"},${40 + (i % 30)}`);
  }
  return { feat: feat.join("\r\n") + "\r\n", clin: clin.join("\r\n") + "\r\n" };
}

/** R5（予後モデル）用の合成データ。f_a が強く、f_b が中くらいに生存に効く。f_dup は f_a とほぼ同じ。時間に同点は無い。 */
function synthR5(n: number): { feat: string; clin: string } {
  let a = 777;
  const rnd = () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  const norm = () => { let s = 0; for (let k = 0; k < 6; k++) s += rnd(); return s - 3; };
  const feat = ["CaseLabel,f_a,f_b,f_n1,f_n2,f_n3,f_n4,f_dup"], clin = ["CaseLabel,time,event"];
  for (let i = 0; i < n; i++) {
    const fa = norm(), fb = norm();
    const t = -Math.log(1 - rnd()) / Math.exp(1.0 * fa - 0.6 * fb) * 20, c = -Math.log(1 - rnd()) * 30;
    feat.push([`S${i}`, fa.toFixed(4), fb.toFixed(4), norm().toFixed(4), norm().toFixed(4), norm().toFixed(4), norm().toFixed(4), (fa * 1.02 + 0.01 * norm()).toFixed(4)].join(","));
    clin.push(`S${i},${(Math.min(t, c) + (i + 1) * 1e-6).toFixed(6)},${t <= c ? 1 : 0}`);
  }
  return { feat: feat.join("\r\n") + "\r\n", clin: clin.join("\r\n") + "\r\n" };
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const featA = write("featA.csv", FEAT_A);
  const featB = write("featB.csv", FEAT_B);
  const clin = write("clin.csv", CLIN);
  const clinDup = write("clin_dup.csv", CLIN_DUP);
  const clinBad = write("clin_bad_event.csv", CLIN_BAD_EVENT);
  installPlugin();

  const driver = new DesktopDriver({ http: 19890, scp: 19891, vite: 19892 });
  try {
    await driver.start();
    const page = driver.page;
    await resetDb(driver.ports.http);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);

    const res = await fetch(`http://localhost:${driver.ports.http}/api/plugins`);
    const manifests = (await res.json()) as { id: string }[];
    check(res.ok && manifests.some((m) => m.id === PLUGIN_ID), "プラグインが読み込まれる（GET /api/plugins に載る）", manifests.map((m) => m.id).join(","));

    await page.evaluate(`
      (function () {
        window.__downloads = [];
        var orig = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          var a = this;
          if (a.download && a.href.indexOf("blob:") === 0) {
            var name = a.download;
            fetch(a.href).then(function (r) { return r.text(); }).then(function (t) { window.__downloads.push({ name: name, text: t }); });
            return;
          }
          return orig.call(this);
        };
      })()
    `);
    const downloaded = async (name: string, before = 0): Promise<string> => {
      for (let i = 0; i < 100; i++) {
        const all = (await page.evaluate("window.__downloads")) as { name: string; text: string }[];
        const hit = all.slice(before).find((d) => d.name === name);
        if (hit) return hit.text;
        await page.waitForTimeout(100);
      }
      return "";
    };
    const count = async () => ((await page.evaluate("window.__downloads.length")) as number);

    console.log("\n[1] 窓を開いてファイルを選ぶ");
    await page.getByTestId("mainscreen-menu-plugins").click();
    await page.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    await page.getByTestId("rs-root").waitFor({ state: "visible", timeout: 15_000 });
    check(/診断・治療の判断には使いません/.test(await page.getByTestId("rs-banner").innerText()), "「診断・治療の判断には使いません」が常に出る");
    check(await page.getByTestId("rs-run").isDisabled(), "ファイルを選ぶ前は「確認する」を押せない（負例）");
    await page.getByTestId("rs-file-features").setInputFiles([featA, featB]);
    await page.getByTestId("rs-file-clinical").setInputFiles(clin);
    await page.getByTestId("rs-loaded").nth(2).waitFor({ state: "attached", timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="rs-run"]') && !(document.querySelector('[data-testid="rs-run"]') as HTMLButtonElement).disabled, null, { timeout: 15_000 });
    const notes = await page.getByTestId("rs-loaded").allInnerTexts();
    check(notes.length === 3 && notes[0].includes("featA.csv: 2 行・6 列") && notes[2].includes("clin.csv: 3 行・5 列"), "読み込んだ表の行数・列数が出る", notes);
    check(!(await page.getByTestId("rs-run").isDisabled()), "選ぶと「確認する」を押せる");
    check((await page.getByTestId("rs-feature-id").inputValue()) === "CaseLabel" && (await page.getByTestId("rs-patient").inputValue()) === "Patient"
      && (await page.getByTestId("rs-time").inputValue()) === "time" && (await page.getByTestId("rs-event").inputValue()) === "event", "列の割り当ての候補が入る");
    check(/特徴量として使う列: 2 個/.test(await page.getByTestId("rs-feature-count").innerText()), "特徴量の列は f1・f2 の 2 個（Provenance_・Roi_ を除く）");

    console.log("\n[2] 結合の結果（手計算: 4 行・3 患者／臨床 3 患者／結合 2 人）");
    await page.getByTestId("rs-seed").fill("7");
    await page.getByTestId("rs-seed").dispatchEvent("change");
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-result").waitFor({ state: "visible" });
    check((await page.getByTestId("rs-joined").innerText()).includes("2 人"), "結合できた患者は 2 人", await page.getByTestId("rs-joined").innerText());
    check((await page.getByTestId("rs-counts").innerText()) === "特徴量の表 4 行（3 患者）／臨床の表 3 患者／特徴量にだけいる 1 人／臨床にだけいる 1 人", "件数が手計算と一致", await page.getByTestId("rs-counts").innerText());
    check((await page.getByTestId("rs-survival").innerText()).includes("2 人"), "時間とイベントが揃った患者は 2 人");
    const fo = (await page.getByTestId("rs-feature-only").textContent()) ?? ""; // 閉じた <details> の中身は innerText に出ない
    const co = (await page.getByTestId("rs-clinical-only").textContent()) ?? "";
    check(fo.includes("P3") && co.includes("P4"), "片側だけの患者（P3・P4）が一覧に出る", `${fo} / ${co}`);
    const miss = (await page.getByTestId("rs-missing").textContent().catch(() => "")) ?? "";
    check(miss === "" || !/f2/.test(miss), "P1 の欠損 1 件は平均から除かれ、患者の値としては欠損にならない（f2 の欠損列は出ない）", miss);
    const exc = (await page.getByTestId("rs-exclusions").textContent()) ?? "";
    check(exc.includes("P3: 臨床の表にいない") && exc.includes("P4: 特徴量の表にいない"), "解析から除く患者と理由が出る", exc);
    await page.getByTestId("rs-root").screenshot({ path: path.join(OUT_DIR, "01-result.png") });
    // 窓の中身が窓より長いとき、スクロールで最後まで届くか（結果と書き出しのボタンまで）
    const reach = await page.getByTestId("rs-root").evaluate((el) => { el.scrollTop = el.scrollHeight; return { top: el.scrollTop, canScroll: el.scrollHeight > el.clientHeight }; });
    check(await page.getByTestId("rs-save-data").isVisible(), "窓の中をスクロールすると、書き出しのボタンまで届く", reach);
    await page.screenshot({ path: path.join(OUT_DIR, "01b-scrolled-window.png") });
    await page.getByTestId("rs-root").evaluate((el) => { el.scrollTop = 0; });

    console.log("\n[3] 書き出し");
    const n0 = await count();
    await page.getByTestId("rs-save-data").click();
    const csv = await downloaded("research-stats-dataset.csv", n0);
    check(csv === "Patient,time,event,outcome,f1,f2\r\nP1,12,1,resp,2,10\r\nP2,8,0,no,5,20\r\n", "データセット CSV が手計算と一致（P1 の f2 = 10。欠損を 0 とみて 5 にしていない）", csv);
    const n1 = await count();
    await page.getByTestId("rs-save-record").click();
    const rec = JSON.parse(await downloaded("research-stats-record.json", n1) || "{}") as { seed?: number; pluginVersion?: string; skillId?: string; status?: string; inputs?: { name: string; sha256: string | null; rows: number }[] };
    const expectSha: Record<string, string> = { "featA.csv": sha(featA), "featB.csv": sha(featB), "clin.csv": sha(clin) };
    check(rec.seed === 7 && rec.skillId === "dataset-check" && rec.status === "ok", "再現情報にシード 7・スキル・状態が載る", { seed: rec.seed, id: rec.skillId, status: rec.status });
    check(rec.pluginVersion === JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, PLUGIN_ID, "plugin.json"), "utf8")).version, "再現情報の版が plugin.json と一致", rec.pluginVersion);
    check(!!rec.inputs && rec.inputs.every((i) => i.sha256 === expectSha[i.name]) && rec.inputs.length === 3, "入力ファイルの SHA-256 が、別に計算した値と一致", rec.inputs);
    const n2 = await count();
    await page.getByTestId("rs-save-method").click();
    const method = await downloaded("research-stats-method.txt", n2);
    check(method.includes("乱数シード: 7") && method.includes("2 患者を解析の対象とした") && method.includes("欠損は 0 で補わず"), "「方法」の文に、シード・患者数・欠損の扱いが書かれる", method);

    console.log("\n[4] 負例: 重複した患者 ID・0/1 でないイベントは止まる");
    await page.getByTestId("rs-file-clinical").setInputFiles(clinDup);
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-errors").waitFor({ state: "visible" });
    check(/患者 ID「P1」が重複/.test(await page.getByTestId("rs-errors").innerText()), "重複した患者 ID は理由を出して止まる");
    check((await page.getByTestId("rs-joined").count()) === 0 && await page.getByTestId("rs-save-data").isDisabled(), "止まったときは結合結果が無く、データセットを書き出せない");
    await page.getByTestId("rs-root").screenshot({ path: path.join(OUT_DIR, "02-duplicate-error.png") });
    await page.getByTestId("rs-file-clinical").setInputFiles(clinBad);
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-errors").waitFor({ state: "visible" });
    check(/イベントは 0 か 1.*P1=2/.test(await page.getByTestId("rs-errors").innerText()), "イベントが 2 のときは値を名指しして止まる");
    await page.getByTestId("rs-file-clinical").setInputFiles(clin);
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-joined").waitFor({ state: "visible" });
    check((await page.getByTestId("rs-joined").innerText()).includes("2 人"), "正しい臨床の表に戻すと、また結合できる");

    console.log("\n[5] 予後との関係（R1）: 別実装（statsmodels）との突き合わせ");
    const r1 = synthR1(100);
    const r1Feat = write("r1_feat.csv", r1.feat), r1Clin = write("r1_clin.csv", r1.clin);
    const refPath = path.join(OUT_DIR, "r1_reference.json");
    execFileSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "src", "spike", "researchStatsR1Reference.py"), r1Feat, r1Clin, refPath]);
    const ref = JSON.parse(fs.readFileSync(refPath, "utf8")) as { rows: Record<string, { n_low: number; n_high: number; p: number; q: number; hr_group: number; hr_sd: number }>; selected: string[]; model?: { terms: string[]; hr: number[]; p: number[]; cindex: number; added_chi2: number; added_p: number } };
    check(ref.selected.includes("f_signal"), "参照側でも f_signal が基準を満たす（合成データの効果が出ている）", ref.selected);
    await page.getByTestId("rs-file-features").setInputFiles([r1Feat]);
    await page.getByTestId("rs-file-clinical").setInputFiles(r1Clin);
    await page.waitForFunction(() => !(document.querySelector('[data-testid="rs-run"]') as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
    check((await page.getByTestId("rs-time").inputValue()) === "time" && (await page.getByTestId("rs-clinical-id").inputValue()) === "CaseLabel", "列の割り当ての候補が入る（R1 の入力）");
    await page.getByTestId("rs-skill").selectOption("r1-prognosis");
    await page.getByTestId("rs-covariates").locator("label", { hasText: "age" }).locator("input").check();
    await page.getByTestId("rs-bootstrap").fill("30");
    await page.getByTestId("rs-bootstrap").dispatchEvent("change");
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-r1").waitFor({ state: "visible", timeout: 60_000 });
    const tableRows = await page.getByTestId("rs-r1-row").evaluateAll((rs) => rs.map((r) => ({ f: (r as HTMLElement).dataset.feature ?? "", cells: Array.from(r.querySelectorAll("td")).map((c) => c.textContent ?? "") })));
    check(tableRows.length === 5, "5 つの特徴量が表に出る", tableRows.map((r) => r.f));
    // 表の p は 0.001 未満を「<0.001」と丸めて出す。その場合は「参照が 0.001 未満」で照合する
    const pMatches = (shown: string, ref: number) => (shown.startsWith("<") ? ref < 0.001 : Math.abs(Number(shown) - ref) <= 6e-4);
    check(tableRows[0].f === "f_signal", "p の小さい順で、先頭は f_signal", tableRows.map((r) => r.f));
    check(tableRows.every((r) => pMatches(r.cells[4], ref.rows[r.f].p)), "表の p が statsmodels の log-rank と一致（表示は小数 3 桁、0.001 未満は「<0.001」）", tableRows.map((r) => [r.cells[4], ref.rows[r.f].p]));
    check(tableRows.every((r) => r.cells[2] === `${ref.rows[r.f].n_low}/${ref.rows[r.f].n_high}`), "群の人数が参照と一致（中央値より大きい値が高群）", tableRows.map((r) => r.cells[2]));
    check(pMatches(tableRows[0].cells[5], ref.rows.f_signal.q), "BH 補正の q が scipy と一致（表示の丸めの範囲で）", { shown: tableRows[0].cells[5], ref: ref.rows.f_signal.q });
    const n5 = await count();
    await page.getByTestId("rs-save-results").click();
    const resCsv = await downloaded("research-stats-r1-results.csv", n5);
    const lines = resCsv.trim().split("\r\n").map((l) => l.split(","));
    const col = (name: string) => lines[0].indexOf(name);
    const exact = lines.slice(1).map((l) => ({ f: l[col("feature")], p: Number(l[col("p_used")]), q: Number(l[col("q_bh")]), hg: Number(l[col("hr_group")]), hs: Number(l[col("hr_per_sd")]) }));
    const rel = (x: number, y: number) => Math.abs(x - y) / Math.abs(y);
    check(exact.every((e) => rel(e.p, ref.rows[e.f].p) < 1e-6 && rel(e.q, ref.rows[e.f].q) < 1e-6), "書き出した CSV の p・q が statsmodels・scipy と相対誤差 1e-6 以内", exact.map((e) => [e.f, rel(e.p, ref.rows[e.f].p)]));
    check(exact.every((e) => rel(e.hg, ref.rows[e.f].hr_group) < 1e-5 && rel(e.hs, ref.rows[e.f].hr_sd) < 1e-5), "群の HR・SD あたりの HR が PHReg（Efron）と一致（相対 1e-5）");
    // 多変量
    const terms = await page.getByTestId("rs-model-table").locator("tbody tr").evaluateAll((rs) => rs.map((r) => Array.from(r.querySelectorAll("td")).map((c) => c.textContent ?? "")));
    check(ref.model !== undefined && terms.map((x) => x[0]).join() === ref.model.terms.join(), "多変量モデルの項が参照と同じ（選ばれた特徴量 + age）", terms.map((x) => x[0]));
    if (ref.model) {
      const hrOk = terms.every((x, i) => Math.abs(Number(x[1].split(" ")[0]) - ref.model!.hr[i]) <= 0.006);
      check(hrOk, "多変量の HR が PHReg と一致（小数 2 桁）", { shown: terms.map((x) => x[1]), ref: ref.model.hr });
      const ci = Number((await page.getByTestId("rs-cindex").innerText()).split(":")[1]);
      check(Math.abs(ci - ref.model.cindex) <= 6e-4, "C-index（見かけ）が総当たりの定義と一致", { shown: ci, ref: ref.model.cindex });
      const added = await page.getByTestId("rs-added").innerText();
      check(added.includes(`χ² = ${ref.model.added_chi2.toFixed(2)}`), "臨床因子に足した効果の χ²（−2LL の差）が参照と一致", { shown: added, ref: ref.model.added_chi2 });
      const corr = Number((await page.getByTestId("rs-cindex-corrected").innerText()).match(/補正\）: ([0-9.]+)/)?.[1]);
      check(corr < ci && corr > 0.5, "補正 C-index は見かけより小さく、0.5 より大きい", { corr, ci });
    }
    check((await page.getByTestId("rs-r1-notice").allInnerTexts()).some((x) => x.includes("比例ハザードの仮定は検査していません")), "「比例ハザードは検査していない」の表示が常に出る");
    // 図
    const legend = await page.getByTestId("rs-km-legend").evaluateAll((es) => es.map((e) => e.textContent ?? "")); // SVG の text は innerText が空
    const risk0 = await page.getByTestId("rs-km-risk").evaluateAll((es) => es.slice(0, 1).map((e) => e.textContent));
    check(legend.length === 2 && legend[0].includes(`n=${ref.rows.f_signal.n_low}`) && legend[1].includes(`n=${ref.rows.f_signal.n_high}`), "KM 図の凡例の人数が参照と一致", legend);
    check(risk0[0] === String(ref.rows.f_signal.n_low), "リスク表の時間 0 の人数 = 低群の人数", risk0);
    await page.getByTestId("rs-r1").screenshot({ path: path.join(OUT_DIR, "03-r1.png") });
    await page.getByTestId("rs-km-svg").screenshot({ path: path.join(OUT_DIR, "04-km.png") });
    const n6 = await count();
    await page.getByTestId("rs-save-km").click();
    const kmCsv = await downloaded("research-stats-km-points.csv", n6);
    check(kmCsv.split("\r\n")[0] === "feature,group,label,time,at_risk,events,censored,survival,se,lower,upper" && kmCsv.split("\r\n").length > 50, "KM の点列 CSV が出る", kmCsv.slice(0, 120));

    console.log("\n[6] 最適しきい値: 進み具合・取り消し・補正 p、補正なしの表示");
    await page.getByTestId("rs-group-mode").selectOption("optimal");
    await page.getByTestId("rs-permutations").fill("20000");
    await page.getByTestId("rs-permutations").dispatchEvent("change");
    check(/特徴量 5 個 × 並べ替え 20000 回/.test(await page.getByTestId("rs-heavy").innerText()), "重い実行の前に、特徴量数×並べ替え回数が出る");
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-progress").waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(1500);
    const mid = await page.getByTestId("rs-progress").innerText();
    check(/実行中: .*（\d+%）/.test(mid) && await page.getByTestId("rs-run").isDisabled(), "実行中は進み具合が出て、もう一度は押せない", mid);
    await page.getByTestId("rs-root").screenshot({ path: path.join(OUT_DIR, "05-running.png") });
    // 実行中は描画が忙しく「安定」の判定が通らないことがあるので、位置を確かめて実座標でクリックする
    const box = await page.getByTestId("rs-cancel").boundingBox();
    check(box !== null && box.width > 0, "取り消すボタンが見える位置にある", box);
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.getByTestId("rs-errors").waitFor({ state: "visible", timeout: 30_000 });
    check(/取り消されました/.test(await page.getByTestId("rs-errors").innerText()) && (await page.getByTestId("rs-r1").count()) === 0, "取り消すと、その旨が出て、途中の結果は表に出さない");
    await page.getByTestId("rs-permutations").fill("199");
    await page.getByTestId("rs-permutations").dispatchEvent("change");
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-r1").waitFor({ state: "visible", timeout: 120_000 });
    const optRows = await page.getByTestId("rs-r1-row").evaluateAll((rs) => rs.map((r) => ({ f: (r as HTMLElement).dataset.feature ?? "", cells: Array.from(r.querySelectorAll("td")).map((c) => c.textContent ?? "") })));
    const head = await page.getByTestId("rs-r1-table").locator("thead th").allInnerTexts();
    check(head.includes("補正 p") && head.includes("raw p"), "表に「補正 p」と「raw p」の列が出る", head);
    const sig = optRows.find((r) => r.f === "f_signal")!;
    const rawIdx = head.indexOf("raw p"), corrIdx = head.indexOf("補正 p");
    check(Number(sig.cells[rawIdx].replace("<", "")) <= Number(sig.cells[corrIdx].replace("<", "")), "素の最小 p ≦ 補正 p（探索のぶんを補正している）", { raw: sig.cells[rawIdx], corrected: sig.cells[corrIdx] });
    check((await page.getByTestId("rs-r1-notice").allInnerTexts()).some((x) => x.includes("探索的")), "最適しきい値では「探索的」の表示が出る");
    await page.getByTestId("rs-r1").screenshot({ path: path.join(OUT_DIR, "06-optimal.png") });
    await page.getByTestId("rs-multiplicity").selectOption("none");
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-r1").waitFor({ state: "visible", timeout: 120_000 });
    check((await page.getByTestId("rs-r1-notice").allInnerTexts()).some((x) => x.includes("多重比較の補正をしていません")) && (await page.getByTestId("rs-r1-q").count()) === 0, "補正なしを選ぶと、その旨が出て q の列は無い");

    console.log("\n[7] 2 群の判別（R2）: 別実装（scikit-learn・statsmodels・scipy・総当たり）との突き合わせ");
    const r2 = synthR2(100);
    const r2Feat = write("r2_feat.csv", r2.feat), r2Clin = write("r2_clin.csv", r2.clin);
    const r2RefPath = path.join(OUT_DIR, "r2_reference.json");
    execFileSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "src", "spike", "researchStatsR2Reference.py"), r2Feat, r2Clin, r2RefPath]);
    type R2Row = { direction: string; auc: number; se: number; p: number; q: number; cut: { cut: number; tp: number; fp: number; tn: number; fn: number } };
    const r2ref = JSON.parse(fs.readFileSync(r2RefPath, "utf8")) as { rows: Record<string, R2Row>; meets: string[]; combo?: { features: string[]; apparent_auc: number; loo_auc: number; loo_cm: { tp: number; fp: number; tn: number; fn: number } }; tree: { depth: number; n: number; pos: number; feature: string | null; direction: string | null; cut: number | null; label: number }[] };
    check(r2ref.meets.includes("f_a") && !!r2ref.combo && r2ref.tree.length > 1, "参照側でも f_a が基準を満たし、組み合わせと木ができる（合成データの効果が出ている）", r2ref.meets);
    await page.getByTestId("rs-file-features").setInputFiles([r2Feat]);
    await page.getByTestId("rs-file-clinical").setInputFiles(r2Clin);
    await page.waitForFunction(() => !(document.querySelector('[data-testid="rs-run"]') as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
    await page.getByTestId("rs-skill").selectOption("r2-discrimination");
    await page.getByTestId("rs-multiplicity").selectOption("bh"); // [6] で「補正なし」にした設定が残っているので戻す
    check((await page.getByTestId("rs-positive").inputValue()) === "", "陽性とするラベルの既定は決めていない（選ぶまで空）");
    const labelsOffered = await page.getByTestId("rs-positive").locator("option").allInnerTexts();
    check(labelsOffered.includes("resp") && labelsOffered.includes("no"), "結果ラベルの値が選択肢に出る", labelsOffered);
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-errors").waitFor({ state: "visible", timeout: 20_000 });
    check(/陽性とするラベルを選んでください/.test(await page.getByTestId("rs-errors").innerText()) && (await page.getByTestId("rs-r2").count()) === 0, "陽性ラベルを選ばずに実行すると、理由を出して止まる（負例）");
    await page.getByTestId("rs-positive").selectOption("resp");
    await page.getByTestId("rs-tree-on").check();
    await page.getByTestId("rs-mc").fill("300");
    await page.getByTestId("rs-mc").dispatchEvent("change");
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-r2").waitFor({ state: "visible", timeout: 120_000 });
    const r2Rows = await page.getByTestId("rs-r2-row").evaluateAll((rs) => rs.map((r) => ({ f: (r as HTMLElement).dataset.feature ?? "", cells: Array.from(r.querySelectorAll("td")).map((c) => c.textContent ?? "") })));
    check(r2Rows.length === 5 && r2Rows[0].f === "f_a", "5 つの特徴量が p の小さい順に出る（先頭は f_a）", r2Rows.map((r) => r.f));
    const aucOk = r2Rows.every((r) => Math.abs(Number(r.cells[3].split(" ")[0]) - r2ref.rows[r.f].auc) <= 6e-4);
    check(aucOk, "表の AUC が scikit-learn と一致（表示は小数 3 桁）", r2Rows.map((r) => [r.cells[3], r2ref.rows[r.f].auc]));
    const n7 = await count();
    await page.getByTestId("rs-save-r2-results").click();
    const r2Csv = await downloaded("research-stats-r2-results.csv", n7);
    const L2 = r2Csv.trim().split("\r\n").map((l) => l.split(","));
    const c2 = (name: string) => L2[0].indexOf(name);
    const e2 = L2.slice(1).map((l) => ({ f: l[c2("feature")], auc: Number(l[c2("auc")]), lo: Number(l[c2("auc_lower")]), p: Number(l[c2("mannwhitney_p")]), q: Number(l[c2("q_bh")]), cut: Number(l[c2("cut")]), tp: Number(l[c2("tp")]), fp: Number(l[c2("fp")]), tn: Number(l[c2("tn")]), fn: Number(l[c2("fn")]), dir: l[c2("direction")] }));
    const r = (x: number, y2: number) => Math.abs(x - y2) / Math.abs(y2);
    check(e2.every((e) => r(e.auc, r2ref.rows[e.f].auc) < 1e-9 && r(e.p, r2ref.rows[e.f].p) < 1e-6 && r(e.q, r2ref.rows[e.f].q) < 1e-6), "書き出した CSV の AUC・p・q が参照と一致（相対 1e-6 以内）");
    check(e2.every((e) => Math.abs(e.cut - r2ref.rows[e.f].cut.cut) < 1e-9 && e.tp === r2ref.rows[e.f].cut.tp && e.fp === r2ref.rows[e.f].cut.fp && e.tn === r2ref.rows[e.f].cut.tn && e.fn === r2ref.rows[e.f].cut.fn && e.dir === r2ref.rows[e.f].direction), "しきい値と混同行列（精度最大）・向きが総当たりの参照と一致");
    const se0 = e2.find((e) => e.f === "f_a")!;
    check(Math.abs((se0.auc - se0.lo) - 1.959964 * r2ref.rows.f_a.se) < 1e-4, "AUC の信頼区間の幅が、定義どおりの DeLong の標準誤差と一致", { half: se0.auc - se0.lo, ref: 1.959964 * r2ref.rows.f_a.se });
    const cmFeat = await page.getByTestId("rs-cm-feature").locator("td").allInnerTexts();
    check(r2Rows[0].f === "f_a" && cmFeat.join() === [r2ref.rows.f_a.cut.tp, r2ref.rows.f_a.cut.fn, r2ref.rows.f_a.cut.fp, r2ref.rows.f_a.cut.tn].join(), "混同行列の表示（f_a）が参照と一致", cmFeat);
    // 組み合わせ・LOO
    check((await page.getByTestId("rs-combo-table").locator("tbody tr td:first-child").allInnerTexts()).join() === r2ref.combo!.features.join(), "組み合わせの特徴量が参照と同じ", r2ref.combo!.features);
    const apparent = Number((await page.getByTestId("rs-auc-apparent").innerText()).match(/: ([0-9.]+)/)?.[1]);
    const looAuc = Number((await page.getByTestId("rs-auc-loo").innerText()).match(/: ([0-9.]+)/)?.[1]);
    check(Math.abs(apparent - r2ref.combo!.apparent_auc) <= 6e-4, "組み合わせの AUC（見かけ）が一致", { shown: apparent, ref: r2ref.combo!.apparent_auc });
    check(Math.abs(looAuc - r2ref.combo!.loo_auc) <= 6e-4, "LOO の AUC（選択を各折の内側でやり直す）が statsmodels で別に回した値と一致", { shown: looAuc, ref: r2ref.combo!.loo_auc });
    check(looAuc <= apparent + 0.02, "LOO の AUC は見かけの AUC を（ほぼ）超えない", { looAuc, apparent });
    const cmLoo = await page.getByTestId("rs-cm-loo").locator("td").allInnerTexts();
    check(cmLoo.join() === [r2ref.combo!.loo_cm.tp, r2ref.combo!.loo_cm.fn, r2ref.combo!.loo_cm.fp, r2ref.combo!.loo_cm.tn].join(), "LOO の混同行列（予測確率 0.5）が参照と一致", cmLoo);
    check((await page.getByTestId("rs-r2-notice").innerText()).includes("見かけ"), "「性能は見かけ。検証したのは LOO だけ」の表示が常に出る");
    // 決定木
    const n8 = await count();
    await page.getByTestId("rs-save-tree").click();
    const treeCsvText = await downloaded("research-stats-r2-tree.csv", n8);
    const TL = treeCsvText.trim().split("\r\n").map((l) => l.split(","));
    const tc = (name: string) => TL[0].indexOf(name);
    const treeRows = TL.slice(1).map((l) => ({ depth: Number(l[tc("depth")]), n: Number(l[tc("n")]), pos: Number(l[tc("positives")]), feature: l[tc("feature")] || null, direction: l[tc("direction")] || null, cut: l[tc("cut")] === "" ? null : Number(l[tc("cut")]), label: Number(l[tc("label")]) }));
    const treeSame = treeRows.length === r2ref.tree.length && treeRows.every((t2, i) => {
      const g = r2ref.tree[i];
      return t2.depth === g.depth && t2.n === g.n && t2.pos === g.pos && t2.feature === g.feature && t2.direction === g.direction && t2.label === g.label && (g.cut === null ? t2.cut === null : Math.abs((t2.cut as number) - g.cut) < 1e-9);
    });
    check(treeSame, "決定木の全節点（特徴量・向き・しきい値・症例数・判定）が独立に書いた木と一致", { ui: treeRows.length, ref: r2ref.tree.length });
    check((await page.getByTestId("rs-tree-mc").innerText()).includes("300 回") && (await page.getByTestId("rs-tree-perf").innerText()).includes("検証していません"), "木の性能は「検証していません」と明記され、モンテカルロ 300 回の区間が出る");
    await page.getByTestId("rs-r2").screenshot({ path: path.join(OUT_DIR, "07-r2.png") });
    await page.getByTestId("rs-roc-svg").screenshot({ path: path.join(OUT_DIR, "08-roc.png") });
    await page.getByTestId("rs-cal-svg").screenshot({ path: path.join(OUT_DIR, "09-calibration.png") });
    await page.getByTestId("rs-dca-svg").screenshot({ path: path.join(OUT_DIR, "10-dca.png") });
    const legends = await page.getByTestId("rs-roc-svg-legend").evaluateAll((es) => es.map((e) => e.textContent ?? ""));
    check(legends.length === 3, "ROC 図の凡例は 3 系列（選んだ特徴量・組み合わせの見かけと LOO）", legends);

    console.log("\n[8] 再現性（R3）: pingouin（別実装）との突き合わせ・臨床 CSV なしで実行");
    const r3 = synthR3(40);
    const r3Files = r3.files.map((txt, i) => write(`cond${"ABC"[i]}.csv`, txt));
    const r3Missing = write("condB_missing.csv", r3.missing2);
    const refPy = process.env.RESEARCH_STATS_REF_PYTHON ?? "python3";
    const r3RefPath = path.join(OUT_DIR, "r3_reference.json");
    execFileSync(refPy, ["-I", path.join(AUTOMATOR_ROOT, "src", "spike", "researchStatsR3Reference.py"), ...r3Files, r3RefPath]);
    type R3Ref = { n: number; icc: number; lower: number | null; upper: number | null; icc_t: number; lower_t: number | null; upper_t: number | null; category: string | null };
    const r3ref = JSON.parse(fs.readFileSync(r3RefPath, "utf8")) as { ids: number; features: Record<string, R3Ref>; ba: { n: number; bias: number; bias_ci: number[]; sd: number; lo: number; hi: number } };
    check(Math.abs(r3ref.features.f_same.icc - 1) < 1e-9 && r3ref.features.f_rand.category === "poor" && r3ref.features.f_shift.icc < r3ref.features.f_same.icc - 0.05, "参照側でも、f_same は ICC=1（区間は NaN）・f_rand は poor・f_shift は定数のずれで ICC が下がる", Object.fromEntries(Object.entries(r3ref.features).map(([k, v]) => [k, v.category])));
    await page.getByTestId("rs-skill").selectOption("r3-reproducibility");
    check((await page.getByTestId("rs-file-clinical").count()) === 0, "再現性のスキルでは臨床 CSV の選択が出ない");
    await page.getByTestId("rs-file-features").setInputFiles([r3Files[0]]);
    await page.getByTestId("rs-loaded").first().waitFor({ state: "attached", timeout: 15_000 });
    check(await page.getByTestId("rs-run").isDisabled(), "条件が 1 つのときは実行できない（負例）");
    await page.getByTestId("rs-file-features").setInputFiles(r3Files);
    await page.waitForFunction(() => !(document.querySelector('[data-testid="rs-run"]') as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-r3").waitFor({ state: "visible", timeout: 60_000 });
    check(/3 条件.*全条件に揃った行 40 行.*共通の数値の列 4 個/.test(await page.getByTestId("rs-r3-conditions").innerText()), "条件数・揃った行数・共通の列数が出る（f_text は数でない値で除く）", await page.getByTestId("rs-r3-conditions").innerText());
    const excluded = (await page.getByTestId("rs-r3-excluded").textContent()) ?? "";
    check(excluded.includes("f_text") && excluded.includes("数でない値"), "使えなかった列とその理由が一覧に出る", excluded);
    const r3Rows = await page.getByTestId("rs-r3-row").evaluateAll((rs) => rs.map((r) => ({ f: (r as HTMLElement).dataset.feature ?? "", cells: Array.from(r.querySelectorAll("td")).map((c) => c.textContent ?? "") })));
    check(r3Rows.length === 4, "4 つの特徴量が表に出る", r3Rows.map((r) => r.f));
    const iccShown = r3Rows.every((r) => { const m = r.cells[3].match(/^([0-9.]+) \(([0-9.]+)–([0-9.]+)\)$/); const e = r3ref.features[r.f];
      if (e.lower_t === null) return !!m && Number(m[1]) >= 0.999 && r.cells[4] === "excellent"; // 参照の区間が NaN の特徴量（全条件で同じ値）は、ICC≈1・excellent だけを確かめる
      return !!m && Math.abs(Number(m[1]) - e.icc_t) <= 6e-4 && Math.abs(Number(m[2]) - (e.lower_t as number)) <= 6e-4 && Math.abs(Number(m[3]) - (e.upper_t as number)) <= 6e-4 && r.cells[4] === e.category; });
    check(iccShown, "表の ICC・信頼区間・区分が pingouin と一致（表示は小数 3 桁）", r3Rows.map((r) => [r.f, r.cells[3], r.cells[4], r3ref.features[r.f].category]));
    const n9 = await count();
    await page.getByTestId("rs-save-r3-results").click();
    const r3Csv = await downloaded("research-stats-r3-icc.csv", n9);
    const L3 = r3Csv.trim().split("\r\n").map((l) => l.split(","));
    const c3 = (name: string) => L3[0].indexOf(name);
    const e3 = L3.slice(1).map((l) => ({ f: l[c3("feature")], icc: Number(l[c3("icc")]), lo: Number(l[c3("icc_lower")]), hi: Number(l[c3("icc_upper")]), cat: l[c3("category")], n: Number(l[c3("n")]) }));
    const rr = (x: number, y2: number) => Math.abs(x - y2) / Math.max(Math.abs(y2), 1e-9);
    check(e3.every((e) => { const g = r3ref.features[e.f]; return rr(e.icc, g.icc) < 1e-8 && e.n === g.n && (g.lower === null || (Math.abs(e.lo - g.lower) < 1e-6 && Math.abs(e.hi - (g.upper as number)) < 1e-6)); }), "書き出した CSV の ICC と信頼区間（切る前）が pingouin と一致（点推定 1e-8、区間 1e-6。参照の区間が NaN の特徴量は点推定だけ）");
    check(!(await page.getByTestId("rs-save-exclusion").count()), "除外の基準を選ばないと、除外候補のボタンは出ない（基準は既定で決めない）");
    // Bland–Altman
    await page.getByTestId("rs-ba-feature").selectOption("f_shift");
    await page.getByTestId("rs-ba-a").selectOption("0");
    await page.getByTestId("rs-ba-b").selectOption("2");
    await page.getByTestId("rs-ba-svg").waitFor({ state: "visible" });
    const baBias = (await page.getByTestId("rs-ba-bias").innerText()).match(/バイアス (-?[0-9.]+)（95% CI (-?[0-9.]+)～(-?[0-9.]+)）/);
    check(!!baBias && Math.abs(Number(baBias[1]) - r3ref.ba.bias) <= 6e-4 && Math.abs(Number(baBias[2]) - r3ref.ba.bias_ci[0]) <= 6e-4 && Math.abs(Number(baBias[3]) - r3ref.ba.bias_ci[1]) <= 6e-4, "Bland–Altman のバイアスと信頼区間が numpy・scipy と一致（条件 C は +5 ずれている）", { shown: baBias?.slice(1), ref: r3ref.ba });
    const baLoa = (await page.getByTestId("rs-ba-loa").innerText()).match(/一致限界 (-?[0-9.]+)（.*）～ (-?[0-9.]+)（.*）、SD ([0-9.]+)、n = (\d+)/);
    check(!!baLoa && Math.abs(Number(baLoa[1]) - r3ref.ba.lo) <= 6e-4 && Math.abs(Number(baLoa[2]) - r3ref.ba.hi) <= 6e-4 && Math.abs(Number(baLoa[3]) - r3ref.ba.sd) <= 6e-4 && Number(baLoa[4]) === r3ref.ba.n, "一致限界・SD・症例数が一致", { shown: baLoa?.slice(1), ref: r3ref.ba });
    await page.getByTestId("rs-ba-b").selectOption("0");
    check((await page.getByTestId("rs-ba-b").inputValue()) !== "0" || (await page.getByTestId("rs-ba-error").count()) > 0, "同じ条件どうしは選べない（A と同じにすると別の条件に切り替わる）");
    await page.getByTestId("rs-ba-b").selectOption("2");
    await page.getByTestId("rs-r3").screenshot({ path: path.join(OUT_DIR, "11-r3.png") });
    await page.getByTestId("rs-icc-svg").screenshot({ path: path.join(OUT_DIR, "12-icc.png") });
    await page.getByTestId("rs-ba-svg").screenshot({ path: path.join(OUT_DIR, "13-ba.png") });
    // 全条件に揃わない行、除外の基準
    await page.getByTestId("rs-file-features").setInputFiles([r3Files[0], r3Missing, r3Files[2]]);
    await page.getByTestId("rs-min-category").selectOption("good");
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-r3").waitFor({ state: "visible", timeout: 60_000 });
    const unm = (await page.getByTestId("rs-r3-unmatched").textContent()) ?? "";
    check(unm.includes("R2") && unm.includes("R3") && !/R1（|R0（/.test(unm) && /全条件に揃った行 38 行/.test(await page.getByTestId("rs-r3-conditions").innerText()), "全条件に揃わない行（R2・R3 だけ）が一覧に出て、38 行で解析する", unm);
    const n10 = await count();
    await page.getByTestId("rs-save-exclusion").click();
    const exCsv = await downloaded("research-stats-r3-exclusion-candidates.csv", n10);
    const refAfter = execFileSync(refPy, ["-I", path.join(AUTOMATOR_ROOT, "src", "spike", "researchStatsR3Reference.py"), r3Files[0], r3Missing, r3Files[2], path.join(OUT_DIR, "r3_reference2.json")]);
    void refAfter;
    const ref2 = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "r3_reference2.json"), "utf8")) as { features: Record<string, R3Ref> };
    const rank = (c: string) => ["poor", "moderate", "good", "excellent"].indexOf(c);
    const expectEx = Object.entries(ref2.features).filter(([, v]) => v.category !== null && rank(v.category) < rank("good")).map(([k]) => k).sort();
    const gotEx = exCsv.trim().split("\r\n").slice(1).map((l) => l.split(",")[0]).sort();
    check(JSON.stringify(gotEx) === JSON.stringify(expectEx) && expectEx.includes("f_rand") && !expectEx.includes("f_same"), "除外候補（good より低い区分）が、pingouin の区分から求めた一覧と一致", { gotEx, expectEx });
    const n11 = await count();
    await page.getByTestId("rs-save-method").click();
    const m3 = await downloaded("research-stats-method.txt", n11);
    check(m3.includes("absolute agreement") && m3.includes("good より低い"), "「方法」の文に、ICC の種類と除外の基準が書かれる", m3.slice(0, 200));
    console.log("\n[9] 予測モデルの性能（P4）: 別実装（scipy・scikit-learn・statsmodels）との突き合わせ・テスト集合の固定と回数");
    const p4 = synthP4(120);
    const p4Feat = write("p4_feat.csv", p4.feat), p4Clin = write("p4_clin.csv", p4.clin);
    const p4RefPath = path.join(OUT_DIR, "p4_reference.json");
    execFileSync("python3", ["-I", path.join(AUTOMATOR_ROOT, "src", "spike", "researchStatsP4Reference.py"), p4Feat, p4Clin, "11", "0.25", "0.95", p4RefPath]);
    const p4ref = JSON.parse(fs.readFileSync(p4RefPath, "utf8")) as { testIds: string[]; dev: number; test: number; kept: string[]; removed: string[]; folds: { k: number | null; score: number | null; features: string[] }[]; pooled: number[]; final: { k: number; features: string[] }; testAuc: number; testLower: number; testUpper: number };
    check(p4ref.removed.join() === "f_dup" && p4ref.folds.length === 10, "参照側でも f_dup だけが相関で除かれ、外側 5 分割 × 2 回 = 10 分割", p4ref.removed);
    await page.getByTestId("rs-skill").selectOption("p4-pipeline");
    await page.getByTestId("rs-file-features").setInputFiles([p4Feat]);
    await page.getByTestId("rs-file-clinical").setInputFiles(p4Clin);
    await page.waitForFunction(() => !(document.querySelector('[data-testid="rs-run"]') as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
    await page.getByTestId("rs-outcome").selectOption("outcome");
    await page.getByTestId("rs-seed").fill("11");
    await page.getByTestId("rs-seed").dispatchEvent("change");
    check((await page.getByTestId("rs-p4-examples").innerText()).includes("既定値なし"), "分割数などは既定値なしで、文献の使用例を出典つきで示す");
    check((await page.getByTestId("rs-p4-outer").inputValue()) === "" && (await page.getByTestId("rs-p4-k").inputValue()) === "", "分割数・候補の欄は空で始まる");
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-errors").waitFor({ state: "visible", timeout: 20_000 });
    check(/結果の型/.test(await page.getByTestId("rs-errors").innerText()) && (await page.getByTestId("rs-p4").count()) === 0, "設定を入れずに実行すると、理由を出して止まる（負例）");
    await page.getByTestId("rs-p4-kind").selectOption("binary");
    await page.getByTestId("rs-positive").selectOption("resp");
    await page.getByTestId("rs-p4-lock").selectOption("create");
    const setNum = async (id: string, v: string) => { await page.getByTestId(id).fill(v); await page.getByTestId(id).dispatchEvent("change"); };
    await setNum("rs-p4-frac", "0.25");
    await setNum("rs-p4-outer", "5");
    await setNum("rs-p4-inner", "4");
    await setNum("rs-p4-repeats", "2");
    await setNum("rs-p4-k", "1, 2, 4");
    await page.getByTestId("rs-p4-const").check();
    await setNum("rs-p4-corr", "0.95");
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-p4-cv").waitFor({ state: "visible", timeout: 120_000 });
    check((await page.getByTestId("rs-p4-sizes").innerText()).includes(`開発集合 ${p4ref.dev} 人・テスト集合 ${p4ref.test} 人・特徴量 ${p4ref.kept.length} 個`), "開発・テストの人数と特徴量の数が参照と一致", await page.getByTestId("rs-p4-sizes").innerText());
    check(((await page.getByTestId("rs-p4-removed").textContent()) ?? "").includes("f_dup"), "相関で除いた特徴量（f_dup）が理由つきで出る");
    const shownScores = await page.getByTestId("rs-p4-fold-score").allInnerTexts();
    check(shownScores.length === 10 && shownScores.every((x, q) => p4ref.folds[q].score === null ? x === "—" : Math.abs(Number(x) - (p4ref.folds[q].score as number)) <= 6e-4), "外側の分割ごとの AUC（表示は小数 3 桁）が参照と一致", shownScores);
    const nf = await count();
    await page.getByTestId("rs-save-p4-folds").click();
    const foldsCsv = (await downloaded("research-stats-p4-folds.csv", nf)).trim().split("\r\n").map((l) => l.split(","));
    const fc = (name: string) => foldsCsv[0].indexOf(name);
    const foldsOk = foldsCsv.slice(1).every((l, q) => {
      const e = p4ref.folds[q];
      return Number(l[fc("k")]) === e.k && l[fc("features")] === e.features.join(" + ") && (e.score === null ? l[fc("score")] === "" : Math.abs(Number(l[fc("score")]) - e.score) < 1e-9);
    }) && foldsCsv.length === 11;
    check(foldsOk, "書き出した分割ごとの結果（選んだ特徴量の数・特徴量・AUC）が参照と一致（AUC は 1e-9）", foldsCsv.slice(1, 4));
    const pooledShown = (await page.getByTestId("rs-p4-pooled").innerText()).match(/([0-9.]+), ([0-9.]+)/);
    check(!!pooledShown && Math.abs(Number(pooledShown[1]) - p4ref.pooled[0]) <= 6e-4 && Math.abs(Number(pooledShown[2]) - p4ref.pooled[1]) <= 6e-4, "予測を束ねた AUC（反復ごと）が参照と一致", { shown: pooledShown?.slice(1), ref: p4ref.pooled });
    check((await page.getByTestId("rs-p4-noci").innerText()).includes("信頼区間を付けていません"), "交差検証の値に信頼区間を付けない理由が出る");
    check((await page.getByTestId("rs-p4-final").innerText()).includes(p4ref.final.features.join(" + ")), "最終モデルの特徴量が参照と一致", p4ref.final);
    check((await page.getByTestId("rs-p4-evaluate").count()) === 0, "作ったばかりの固定ファイルでは「テスト集合で評価する」は出ない（保存して読み込んでから）");
    const nl = await count();
    await page.getByTestId("rs-save-lock").click();
    const lockText = await downloaded("research-stats-test-lock.json", nl);
    const lock = JSON.parse(lockText || "{}") as { testIds?: string[]; evaluations?: unknown[]; sha256?: string };
    check(JSON.stringify(lock.testIds) === JSON.stringify(p4ref.testIds) && Array.isArray(lock.evaluations) && lock.evaluations.length === 0, "固定ファイルのテスト症例が参照の分割と一致し、評価は 0 回", { n: lock.testIds?.length });
    await page.getByTestId("rs-p4").screenshot({ path: path.join(OUT_DIR, "14-p4-create.png") });
    await page.getByTestId("rs-p4-fold-svg").screenshot({ path: path.join(OUT_DIR, "15-p4-folds.png") });

    // 保存した固定ファイルを読み込んで、テスト集合で評価する
    const lockPath = write("lock.json", lockText);
    await page.getByTestId("rs-p4-lock").selectOption("use");
    await page.getByTestId("rs-file-lock").setInputFiles(lockPath);
    await page.getByTestId("rs-lock-loaded").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-p4-cv").waitFor({ state: "visible", timeout: 120_000 });
    const scoresUse = await page.getByTestId("rs-p4-fold-score").allInnerTexts();
    check(JSON.stringify(scoresUse) === JSON.stringify(shownScores), "読み込んだ固定ファイルで、同じシードなら交差検証は作ったときと同じ");
    await page.getByTestId("rs-p4-evaluate").click();
    await page.getByTestId("rs-p4-test").waitFor({ state: "visible", timeout: 120_000 });
    const tv = (await page.getByTestId("rs-p4-test-value").innerText()).match(/AUC ([0-9.]+)（DeLong 法の 95% CI ([0-9.]+)～([0-9.]+)）、(\d+) 人/);
    check(!!tv && Math.abs(Number(tv[1]) - p4ref.testAuc) <= 6e-4 && Math.abs(Number(tv[2]) - p4ref.testLower) <= 6e-4 && Math.abs(Number(tv[3]) - p4ref.testUpper) <= 6e-4 && Number(tv[4]) === p4ref.test, "テスト集合の AUC と DeLong の信頼区間が scikit-learn・定義どおりの式と一致", { shown: tv?.slice(1), ref: [p4ref.testAuc, p4ref.testLower, p4ref.testUpper] });
    check((await page.getByTestId("rs-p4-test-count").innerText()).includes("1 回目"), "1 回目の評価と表示される");
    const lock1 = JSON.parse(await downloaded("research-stats-test-lock.json", nl + 1) || "{}") as { evaluations?: { n: number }[] };
    check(lock1.evaluations?.length === 1 && lock1.evaluations[0].n === 1, "評価すると、回数 1 を記録した固定ファイルが保存される", lock1.evaluations);
    await page.getByTestId("rs-p4").screenshot({ path: path.join(OUT_DIR, "16-p4-test.png") });
    await page.getByTestId("rs-p4-roc-svg").screenshot({ path: path.join(OUT_DIR, "17-p4-roc.png") });
    await page.getByTestId("rs-p4-cal-svg").screenshot({ path: path.join(OUT_DIR, "18-p4-cal.png") });
    // 2 回目
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-p4-evaluate").waitFor({ state: "visible", timeout: 120_000 });
    await page.getByTestId("rs-p4-evaluate").click();
    await page.getByTestId("rs-p4-test").waitFor({ state: "visible", timeout: 120_000 });
    const cnt2 = page.getByTestId("rs-p4-test-count");
    check((await cnt2.innerText()).includes("2 回目") && /rs-warn/.test((await cnt2.getAttribute("class")) ?? ""), "同じ画面で続けて評価すると 2 回目になり、警告として出る");
    const nm = await count();
    await page.getByTestId("rs-save-method").click();
    const m4 = await downloaded("research-stats-method.txt", nm);
    check(m4.includes("入れ子の交差検証") && m4.includes("2 回目") && m4.includes("信頼区間は付けない"), "「方法」の文に、入れ子の交差検証・テストの評価回数・区間を付けない理由が書かれる", m4.slice(0, 160));
    // 書き換えた固定ファイルは読み込まない
    const tampered = JSON.parse(lockText) as { testIds: string[] };
    tampered.testIds = tampered.testIds.slice(1);
    const tamperedPath = write("lock_tampered.json", JSON.stringify(tampered));
    await page.getByTestId("rs-file-lock").setInputFiles(tamperedPath);
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-errors").waitFor({ state: "visible", timeout: 20_000 });
    check(/書き換えられています/.test(await page.getByTestId("rs-errors").innerText()) && (await page.getByTestId("rs-p4-cv").count()) === 0, "手で書き換えた固定ファイルは、理由を出して止まる（負例）");
    console.log("\n[10] 少数の特徴で予後モデル（R5）: 最終の Cox・見かけの C・Schoenfeld を statsmodels と突き合わせ、補正 C の再現と図");
    const r5 = synthR5(110);
    const r5Feat = write("r5_feat.csv", r5.feat), r5Clin = write("r5_clin.csv", r5.clin);
    await page.getByTestId("rs-skill").selectOption("r5-model");
    await page.getByTestId("rs-file-features").setInputFiles([r5Feat]);
    await page.getByTestId("rs-file-clinical").setInputFiles(r5Clin);
    await page.waitForFunction(() => !(document.querySelector('[data-testid="rs-run"]') as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
    await page.getByTestId("rs-seed").fill("5");
    await page.getByTestId("rs-seed").dispatchEvent("change");
    check((await page.getByTestId("rs-r5-examples").innerText()).includes("既定値なし") && (await page.getByTestId("rs-r5-corr").inputValue()) === "" && (await page.getByTestId("rs-r5-nu").inputValue()) === "", "論文に無い値（相関のしきい値・ν）は空欄で始まり、使用例を示す");
    check((await page.getByTestId("rs-r5-iter").inputValue()) === "100" && (await page.getByTestId("rs-r5-boot").inputValue()) === "2000" && (await page.getByTestId("rs-r5-max").inputValue()) === "4", "論文の値（100 反復・2000 回・5 未満 → 4）が既定で入る");
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-errors").waitFor({ state: "visible", timeout: 20_000 });
    check(/相関のしきい値/.test(await page.getByTestId("rs-errors").innerText()) && (await page.getByTestId("rs-r5").count()) === 0, "必須の値を入れずに実行すると、理由を出して止まる（負例）");
    await setNum("rs-r5-corr", "0.9");
    await setNum("rs-r5-nu", "0.1");
    await setNum("rs-r5-boot", "200");
    const r5Start = Date.now();
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-r5").waitFor({ state: "visible", timeout: 600_000 });
    console.log(`  （実行 ${((Date.now() - r5Start) / 1000).toFixed(1)} 秒）`);
    check(/mboost/.test(await page.getByTestId("rs-warnings").innerText()), "ブースティングは mboost と同じ値とは言えない旨が出る");
    const nr5 = await count();
    await page.getByTestId("rs-save-r5-model").click();
    const r5Model = (await downloaded("research-stats-r5-model.csv", nr5)).trim().split("\r\n").map((l) => l.split(","));
    const r5Terms = r5Model.slice(1).filter((l) => l[0].startsWith("f_"));
    const sel = r5Terms.map((l) => l[0]);
    check(sel.includes("f_a") && sel.includes("f_b") && !sel.includes("f_dup") && sel.length <= 4, "効く特徴量（f_a・f_b）が選ばれ、f_dup は選ばれず、4 個以下", sel);
    await page.getByTestId("rs-save-r5-steps").click();
    const stepsCsv = await downloaded("research-stats-r5-steps.csv", nr5 + 1);
    check(/correlation,f_dup,removed/.test(stepsCsv), "f_dup は相関で除いた、と選択の経過に出る", stepsCsv.split("\r\n").slice(0, 3));
    const r5RefPath = path.join(OUT_DIR, "r5_reference.json");
    execFileSync(refPy, ["-I", path.join(AUTOMATOR_ROOT, "src", "spike", "researchStatsR5Reference.py"), "r5", r5Feat, r5Clin, sel.join(","), r5RefPath]);
    const r5ref = JSON.parse(fs.readFileSync(r5RefPath, "utf8")) as { hr: number[]; p: number[]; cApparent: number; globalP: number; perP: number[] };
    const hrOk = r5Terms.every((l, q) => Math.abs(Number(l[2]) / r5ref.hr[q] - 1) < 1e-6 && Math.abs(Number(l[5]) - r5ref.p[q]) < 1e-8 + 1e-6 * r5ref.p[q]);
    check(hrOk, "最終の Cox の HR（SD あたり）と p が statsmodels（Efron）と一致（相対 1e-6）", { app: r5Terms.map((l) => [l[0], l[2], l[5]]), ref: r5ref });
    const cAppCsv = Number(r5Model.find((l) => l[0] === "c_index_apparent")![1]);
    check(Math.abs(cAppCsv - r5ref.cApparent) < 1e-9, "見かけの C-index が別に書いた Harrell の C と一致", { app: cAppCsv, ref: r5ref.cApparent });
    const cCorr = Number(r5Model.find((l) => l[0] === "c_index_corrected")![1]);
    check(cCorr > 0.5 && cCorr < cAppCsv, "補正 C-index は 0.5 より大きく、見かけより小さい", { cCorr, cAppCsv });
    await page.getByTestId("rs-save-record").click();
    const rec5 = JSON.parse(await downloaded("research-stats-record.json", nr5 + 2) || "{}") as { steps: { id: string; summary: Record<string, unknown> }[] };
    const md5 = rec5.steps?.find((x) => x.id === "r5-model")?.summary ?? {};
    check(Math.abs(Number(md5.phGlobalP) - r5ref.globalP) < 1e-8, "比例ハザードの全体の p が、statsmodels の Schoenfeld 残差から求めた値と一致", { app: md5.phGlobalP, ref: r5ref.globalP });
    const cText = await page.getByTestId("rs-r5-ccorr").innerText();
    await page.getByTestId("rs-r5").screenshot({ path: path.join(OUT_DIR, "19-r5.png") });
    await page.getByTestId("rs-r5-sch-svg-0").screenshot({ path: path.join(OUT_DIR, "20-r5-schoenfeld.png") });
    await page.getByTestId("rs-r5-terms").screenshot({ path: path.join(OUT_DIR, "23-r5-terms.png") });
    await page.getByTestId("rs-r5-c").screenshot({ path: path.join(OUT_DIR, "24-r5-c.png") });
    await page.getByTestId("rs-r5-importance").screenshot({ path: path.join(OUT_DIR, "25-r5-importance.png") });
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-r5").waitFor({ state: "detached", timeout: 20_000 }).catch(() => undefined);
    await page.getByTestId("rs-r5").waitFor({ state: "visible", timeout: 600_000 });
    check((await page.getByTestId("rs-r5-ccorr").innerText()) === cText, "同じシードでもう一度実行すると、補正 C-index も同じ", cText);
    const nm5 = await count();
    await page.getByTestId("rs-save-method").click();
    const m5 = await downloaded("research-stats-method.txt", nm5);
    check(m5.includes("相関の除外から後退選択までを毎回やり直す") && m5.includes("mboost と同じ値になるかは確かめていない") && m5.includes("Grambsch–Therneau"), "「方法」の文に、やり直しの範囲・mboost の注記・比例ハザードの確認が書かれる", m5.slice(0, 200));
    // LASSO-Cox で絞る
    await page.getByTestId("rs-r5-screen").selectOption("lasso");
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-errors").waitFor({ state: "visible", timeout: 20_000 });
    check(/λ の選び方/.test(await page.getByTestId("rs-errors").innerText()), "LASSO-Cox では λ の選び方を選ぶまで実行しない（負例）");
    await page.getByTestId("rs-r5-rule").selectOption("1se");
    await setNum("rs-r5-nlambda", "30");
    await setNum("rs-r5-boot", "50");
    const lStart = Date.now();
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-r5-lasso").waitFor({ state: "visible", timeout: 600_000 });
    console.log(`  （LASSO-Cox・ブートストラップ 50 回: ${((Date.now() - lStart) / 1000).toFixed(1)} 秒）`);
    const selL = await page.getByTestId("rs-r5-term").allInnerTexts();
    check(selL.some((x) => x.startsWith("f_a")), "LASSO-Cox で絞っても f_a が選ばれる", selL);
    await page.getByTestId("rs-r5-lasso-svg").screenshot({ path: path.join(OUT_DIR, "21-r5-lasso.png") });

    console.log("\n[11] P4 の LASSO: 最終モデルを scikit-learn と突き合わせ、テスト集合で評価");
    await page.getByTestId("rs-skill").selectOption("p4-pipeline");
    await page.getByTestId("rs-file-features").setInputFiles([p4Feat]);
    await page.getByTestId("rs-file-clinical").setInputFiles(p4Clin);
    await page.waitForFunction(() => !(document.querySelector('[data-testid="rs-run"]') as HTMLButtonElement | null)?.disabled, null, { timeout: 15_000 });
    await page.getByTestId("rs-outcome").selectOption("outcome");
    await page.getByTestId("rs-p4-kind").selectOption("binary");
    await page.getByTestId("rs-positive").selectOption("resp");
    await page.getByTestId("rs-p4-lock").selectOption("create");
    await setNum("rs-p4-frac", "0.25");
    await page.getByTestId("rs-p4-model").selectOption("lasso");
    check((await page.getByTestId("rs-p4-k").count()) === 0 && (await page.getByTestId("rs-p4-nlambda").inputValue()) === "100", "LASSO では特徴量の数の候補の欄が消え、λ の点の数（100）が出る");
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-errors").waitFor({ state: "visible", timeout: 20_000 });
    check(/λ の選び方/.test(await page.getByTestId("rs-errors").innerText()), "λ の選び方を選ぶまで実行しない（負例）");
    await page.getByTestId("rs-p4-lasso-rule").selectOption("min");
    await setNum("rs-p4-nlambda", "30");
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-p4-cv").waitFor({ state: "visible", timeout: 300_000 });
    const lambdas = await page.getByTestId("rs-p4-fold-lambda").allInnerTexts();
    const aucs = await page.getByTestId("rs-p4-fold-score").allInnerTexts();
    check(lambdas.length === 10 && lambdas.every((x) => Number(x) > 0) && aucs.every((x) => Number(x) > 0.5), "分割ごとに λ と AUC が出る（10 分割、AUC は 0.5 より大きい）", { lambdas, aucs });
    const nr = await count();
    await page.getByTestId("rs-save-record").click();
    const recL = JSON.parse(await downloaded("research-stats-record.json", nr) || "{}") as { steps: { id: string; summary: Record<string, unknown> }[] };
    const fin = recL.steps?.find((x) => x.id === "p4-final")?.summary ?? {};
    await page.getByTestId("rs-save-lock").click();
    const lockL = await downloaded("research-stats-test-lock.json", nr + 1);
    const lockLPath = write("lock_lasso.json", lockL);
    const plRef = path.join(OUT_DIR, "p4_lasso_reference.json");
    execFileSync(refPy, ["-I", path.join(AUTOMATOR_ROOT, "src", "spike", "researchStatsR5Reference.py"), "p4lasso", p4Feat, p4Clin, lockLPath, String(fin.lambda), "f_dup", plRef]);
    const pl = JSON.parse(fs.readFileSync(plRef, "utf8")) as { dev: number; nonzero: string[] };
    const appFeat = String(fin.features ?? "").split(" + ").filter(Boolean).sort();
    check(JSON.stringify(appFeat) === JSON.stringify([...pl.nonzero].sort()) && appFeat.length > 0, "最終モデルの特徴量（係数が 0 でないもの）が、同じ λ の scikit-learn と一致", { app: appFeat, ref: pl.nonzero, lambda: fin.lambda });
    check(/λ = /.test(await page.getByTestId("rs-p4-final-lambda").innerText()), "最終モデルの λ が画面に出る");
    await page.getByTestId("rs-p4").screenshot({ path: path.join(OUT_DIR, "22-p4-lasso.png") });
    await page.getByTestId("rs-p4-folds").screenshot({ path: path.join(OUT_DIR, "26-p4-lasso-folds.png") });
    await page.getByTestId("rs-p4-lock").selectOption("use");
    await page.getByTestId("rs-file-lock").setInputFiles(lockLPath);
    await page.getByTestId("rs-lock-loaded").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("rs-run").click();
    await page.getByTestId("rs-p4-evaluate").waitFor({ state: "visible", timeout: 300_000 });
    await page.getByTestId("rs-p4-evaluate").click();
    await page.getByTestId("rs-p4-test").waitFor({ state: "visible", timeout: 300_000 });
    const tvL = (await page.getByTestId("rs-p4-test-value").innerText()).match(/AUC ([0-9.]+)/);
    check(!!tvL && Number(tvL[1]) > 0.6 && (await page.getByTestId("rs-p4-test-count").innerText()).includes("1 回目"), "LASSO の最終モデルをテスト集合で 1 回評価できる", tvL?.[1]);
    const nmL = await count();
    await page.getByTestId("rs-save-method").click();
    const mL = await downloaded("research-stats-method.txt", nmL);
    check(mL.includes("L1 罰則つきロジスティック回帰") && mL.includes("偏差で最小のものを選んだ"), "「方法」の文に LASSO と λ の選び方が書かれる", mL.slice(0, 160));
  } finally {
    await driver.stop();
    fs.rmSync(path.join(PLUGINS_DIR, PLUGIN_ID), { recursive: true, force: true });
  }
  process.exitCode = summary() === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

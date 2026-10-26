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
    const rec = JSON.parse(await downloaded("research-stats-record.json", n1) || "{}") as { seed?: number; pluginVersion?: string; recipeId?: string; status?: string; inputs?: { name: string; sha256: string | null; rows: number }[] };
    const expectSha: Record<string, string> = { "featA.csv": sha(featA), "featB.csv": sha(featB), "clin.csv": sha(clin) };
    check(rec.seed === 7 && rec.recipeId === "dataset-check" && rec.status === "ok", "再現情報にシード 7・レシピ・状態が載る", { seed: rec.seed, id: rec.recipeId, status: rec.status });
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
    await page.getByTestId("rs-recipe").selectOption("r1-prognosis");
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

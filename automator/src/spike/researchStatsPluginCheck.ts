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

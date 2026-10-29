/*
 * 脳萎縮定量プラグイン（`graphy-next-plugin-brain-atrophy`、id `vis-brain-atrophy`）の本体上での実機検証。
 *
 * 実行:  cd automator && BA_DB=<基準DB.npz> BA_DICOM=<T1のDICOMフォルダ> BA_AGE=72 BA_SEX=M BA_FIELD=3 \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=18950 GRAPHY_AUTOMATOR_SCP_PORT=18951 GRAPHY_AUTOMATOR_VITE_PORT=18953 \
 *          PATH=<解析の Python の bin>:$PATH timeout 3000 npx tsx src/spike/brainAtrophyLocalCheck.ts [full|missing-deps]
 *   起動前に frontend/node_modules/.vite を消すこと。Linux 専用。
 *   前提: backend jar（HEAD から再ビルド）、PATH 先頭の Python に jupyter_server・ipykernel（full は gn_brain_atrophy ほか依存）。
 *
 *   full          : 2D ビューアの解析メニューから起動 → 事前チェック → 実行 → 結果（QC・指標・レポート）まで通す。
 *   missing-deps  : gn_brain_atrophy の無い Python で、事前チェックが不足を見つけ、使われる Python を名指しした導入案内を出す（負例）。
 *
 * 結果の数値の突き合わせ（CLI の直接実行との比較）は、BA_EXPECT（metrics.json）が与えられたときだけ行う。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { selectFirstStudy } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { consentWindow, createChecker, openAnalysisPlugin } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const MODE = process.argv[2] === "missing-deps" ? "missing-deps" : "full";
const PLUGIN_ID = "vis-brain-atrophy";
const HIPPO_DB = process.env.BA_HIPPO_DB ?? "";   // 指定すると「海馬も解析する」を選んで通す（HippoDeep は ~/hippodeep_pytorch か GN_BA_HIPPODEEP）
const MAKER = process.env.BA_MAKER ?? "";   // 指定すると装置メーカーを選んで通す（Philips/GE/Siemens/other）
const VOI_DB = process.env.BA_VOI_DB ?? "";   // 指定すると「鑑別の参考指標」を選んで通す（背側脳幹の白質の基準）
const PLUGIN_REPO = path.resolve(AUTOMATOR_ROOT, "..", "..", "graphy-next-plugin-brain-atrophy");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", `brain-atrophy-${MODE}`);
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} を設定してください`);
  return v;
};

/** 同意の窓が開くたびに承認して、プラグインの状態が終わり（done 等）になるまで回す。承認した窓の数を返す */
async function approveUntil(driver: DesktopDriver, viewer: Page, done: (s: Record<string, unknown>) => boolean, timeoutMs: number): Promise<{ n: number; shots: string[] }> {
  const t0 = Date.now();
  let n = 0;
  const shots: string[] = [];
  while (Date.now() - t0 < timeoutMs) {
    const st = (await viewer.evaluate(() => (window as unknown as { __brainAtrophyState?: Record<string, unknown> }).__brainAtrophyState ?? {})) as Record<string, unknown>;
    if (done(st)) return { n, shots };
    const win = driver.app.windows().find((w) => w.url().endsWith("computeConsent.html"));
    if (win) {
      await win.waitForFunction(() => (document.getElementById("code")?.textContent ?? "").length > 0);
      n++;
      const shot = path.join(OUT_DIR, `consent-${n}.png`);
      await win.screenshot({ path: shot });
      shots.push(shot);
      const ack = win.getByTestId("consent-ack");
      if ((await ack.count()) > 0) await ack.check();
      await win.getByTestId("consent-send").click();
      await viewer.waitForTimeout(500);
    } else {
      await viewer.waitForTimeout(500);
    }
  }
  throw new Error("時間内に終わりませんでした");
}

async function main(): Promise<void> {
  const db = need("BA_DB");
  const dicomDir = need("BA_DICOM");
  const age = need("BA_AGE");
  const sex = need("BA_SEX");
  const field = need("BA_FIELD");
  // 患者情報の自動入力の検査（任意）。DICOM に入れた値と同じものを環境変数で渡す: 生年月日 YYYYMMDD・検査日 YYYYMMDD（既定 20260101）・患者名・患者 ID
  const birth = process.env.BA_BIRTH ?? "";
  const studyYmd = process.env.BA_STUDY ?? "20260101";
  const pname = process.env.BA_PNAME ?? "";
  const pid = process.env.BA_PID ?? "";
  const iso = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const expectAge = birth ? Math.round(((Date.parse(iso(studyYmd)) - Date.parse(iso(birth))) / 86400000 / 365.2425) * 10) / 10 : null;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_REPO, n), path.join(dst, n));
  fs.rmSync(AUDIT, { force: true });

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const main = driver.page;
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [dicomDir]);
    console.log(`import: ${JSON.stringify(imp)}`);
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await driver.app.evaluate(({ dialog }, p) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      dialog.showOpenDialog = (async (_w: unknown, o: { title?: string }) => ({ canceled: false, filePaths: [String(o?.title ?? "").includes("海馬") ? process.env.BA_HIPPO_DB ?? p : String(o?.title ?? "").includes("背側脳幹") ? process.env.BA_VOI_DB ?? p : p] })) as unknown as typeof dialog.showOpenDialog;
    }, db);

    const rec = createStepRecorder();
    await selectFirstStudy(main, rec);
    const seriesRow = main.locator('[data-testid^="series-row-"]').first();
    await seriesRow.waitFor({ state: "visible", timeout: 15_000 });
    await seriesRow.click();
    const viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    viewer.on("console", (m) => {
      if (m.type() === "error") console.log(`  [viewer error] ${m.text()}`);
    });
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(2500);

    console.log("\n[A] メニューから起動する");
    await openAnalysisPlugin(viewer, PLUGIN_ID);
    await viewer.getByTestId("ba-disclaimer").waitFor({ state: "visible", timeout: 20_000 });
    check(true, "解析メニューにプラグインが出て、窓が開く（免責の帯が見える）");
    check(((await viewer.getByTestId("ba-disclaimer").textContent()) ?? "").includes("診断機器ではありません"), "免責の文言が画面にある");
    await viewer.screenshot({ path: path.join(OUT_DIR, "a-opened.png") });

    console.log("\n[B] 入力の検査（空のまま実行）");
    await viewer.getByTestId("ba-run").click();
    await viewer.waitForTimeout(500);
    const invalid = (await viewer.getByTestId("ba-status").textContent()) ?? "";
    check((birth || /年齢|磁場/.test(invalid)) && /基準 DB/.test(invalid), "未入力では計算機へ行かず、不足を画面に出す", invalid);
    check(!fs.existsSync(AUDIT) || fs.readFileSync(AUDIT, "utf8").trim() === "", "🔴 その間、監査に送信が無い");

    console.log("\n[C] 入力して実行");
    if (birth) {
      await viewer.waitForFunction(() => (window as unknown as { __brainAtrophyState: { patientFill?: string } }).__brainAtrophyState.patientFill !== "pending", null, { timeout: 10_000 });
      const fill = await viewer.evaluate(() => (window as unknown as { __brainAtrophyState: { patientFill?: string } }).__brainAtrophyState.patientFill);
      check(fill === "ok", "本体の患者情報（searchPatients）から自動入力できた", fill);
      const got = {
        name: await viewer.getByTestId("ba-patient-name").inputValue(), id: await viewer.getByTestId("ba-patient-id").inputValue(),
        birth: await viewer.getByTestId("ba-birth").inputValue(), study: await viewer.getByTestId("ba-study").inputValue(),
        age: await viewer.getByTestId("ba-age").inputValue(), sex: await viewer.getByTestId("ba-sex").inputValue(),
      };
      console.log(`  自動入力: ${JSON.stringify(got)}`);
      check(got.name === pname.replace(/\^/g, "^") || got.name.replace(/[\s^]+/g, "") === pname.replace(/[\s^]+/g, ""), "患者名が DICOM と一致する", got.name);
      check(got.id === pid, "患者 ID が DICOM と一致する", got.id);
      check(got.birth === iso(birth) && got.study === iso(studyYmd), "生年月日と検査日が DICOM と一致する", { b: got.birth, s: got.study });
      check(Number(got.age) === expectAge, "年齢が (検査日−生年月日) の計算値と一致する", { app: got.age, expect: expectAge });
      check(got.sex === sex, "性別が DICOM と一致する", got.sex);
      await viewer.screenshot({ path: path.join(OUT_DIR, "c-autofill.png") });
      await viewer.getByTestId("ba-patient-name").fill("編集後 太郎");   // 編集できること。レポート表紙にこの値が出るはず
    } else {
      await viewer.getByTestId("ba-age").fill(age);
      await viewer.getByTestId("ba-sex").selectOption(sex);
    }
    await viewer.getByTestId("ba-field").selectOption(field);
    if (MAKER) await viewer.getByTestId("ba-maker").selectOption(MAKER);
    await viewer.getByTestId("ba-db-pick").click();
    await viewer.waitForFunction(() => !!(window as unknown as { __brainAtrophyState: { db?: string } }).__brainAtrophyState.db, null, { timeout: 10_000 });
    check(((await viewer.getByTestId("ba-db-path").textContent()) ?? "") === db, "基準 DB の選択が画面に反映される");
    if (HIPPO_DB) {
      await viewer.getByTestId("ba-hippo").check();
      await viewer.getByTestId("ba-hippo-db-pick").click();
      await viewer.waitForFunction(() => !!(window as unknown as { __brainAtrophyState: { hippoDb?: string } }).__brainAtrophyState.hippoDb, null, { timeout: 10_000 });
      check(((await viewer.getByTestId("ba-hippo-db-path").textContent()) ?? "") === HIPPO_DB, "海馬の基準の選択が画面に反映される");
    }
    if (VOI_DB) {
      await viewer.getByTestId("ba-voi").check();
      await viewer.getByTestId("ba-voi-db-pick").click();
      await viewer.waitForFunction(() => !!(window as unknown as { __brainAtrophyState: { voiDb?: string } }).__brainAtrophyState.voiDb, null, { timeout: 10_000 });
      check(((await viewer.getByTestId("ba-voi-db-path").textContent()) ?? "") === VOI_DB, "背側脳幹（白質）の基準の選択が画面に反映される");
    }
    await viewer.getByTestId("ba-run").click();

    if (MODE === "missing-deps") {
      const r = await approveUntil(driver, viewer, (s) => !!s.env, 240_000);
      await viewer.getByTestId("ba-env").waitFor({ state: "visible", timeout: 10_000 });
      const st = (await viewer.evaluate(() => (window as unknown as { __brainAtrophyState: Record<string, unknown> }).__brainAtrophyState)) as { env: { problem: string; python: string } };
      check(r.n === 1, "事前チェックの同意は 1 回だけ（画像を送る同意には進まない）", r.n);
      check(/^missing-packages: .*gn_brain_atrophy/.test(st.env.problem), "🔴 事前チェックが gn_brain_atrophy の不足を見つける", st.env.problem);
      const py = (await viewer.getByTestId("ba-env-python").textContent()) ?? "";
      check(py.includes(st.env.python) && st.env.python.includes("/bin/python"), "使われる Python（sys.executable）を名指しする", py);
      const cmd = (await viewer.getByTestId("ba-env-command").inputValue().catch(() => "")) ?? "";
      const note = (await viewer.getByTestId("ba-env-note").first().textContent().catch(() => "")) ?? "";
      check(cmd.includes(st.env.python) || note.includes(st.env.python), "導入の案内が、その Python を名指しした pip の形になっている", { cmd, note });
      check(((await viewer.getByTestId("ba-status").textContent()) ?? "").includes("足りないもの"), "状態の文が不足を伝える");
      const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string; bytes?: number });
      const up = events.filter((e) => e.event === "compute-uploaded");
      check(up.length === 1 && up.every((e) => e.bytes === 0), "🔴 画像は 1 バイトも送られていない（アップロードは事前チェックの 1 回だけで 0 バイト）", up);
      await viewer.screenshot({ path: path.join(OUT_DIR, "env-advice.png") });
      return;
    }

    const t0 = Date.now();
    const r = await approveUntil(driver, viewer, (s) => ["done", "qc_failed", "failed"].includes(String(s.phase)), 1_500_000);
    console.log(`  実行 ${(Date.now() - t0) / 1000} 秒・同意の窓 ${r.n} 回`);
    const st = (await viewer.evaluate(() => (window as unknown as { __brainAtrophyState: Record<string, unknown> }).__brainAtrophyState)) as {
      phase: string; error?: string; stderr?: string; result?: { status: string; covariates: Record<string, unknown> }; metrics?: Record<string, number>;
    };
    fs.writeFileSync(path.join(OUT_DIR, "state.json"), JSON.stringify(st, null, 2));
    check(r.n === 2, "同意は 2 回（環境の事前チェック・画像の送信）", r.n);
    check(st.phase === "done", "最後まで走り、QC を通って数値が出る", { phase: st.phase, error: st.error, stderr: st.stderr?.slice(-400) });
    if (st.phase !== "done") return;

    console.log("\n[D] 画面に出ている値");
    await viewer.getByTestId("ba-metrics").waitFor({ state: "visible", timeout: 10_000 });
    const shown = (await viewer.getByTestId("ba-metrics").textContent()) ?? "";
    const used = (await viewer.getByTestId("ba-used").textContent()) ?? "";
    console.log(`  ${shown}\n  ${used}`);
    const m = st.metrics!;
    check(shown.includes((m.frac_z_gt2 * 100).toFixed(2)) && shown.includes(String(Math.round(m.gm_ml))), "画面の指標が結果ファイルの値と一致する", { shown, m });
    check(used.includes(`${birth ? expectAge : Number(age)} 歳`) && used.includes(`${field} T`), "『解析に使った値』に入力が再掲される", used);
    const frame = viewer.getByTestId("ba-report");
    await frame.scrollIntoViewIfNeeded();
    const srcLen = await frame.evaluate((e) => (e as HTMLIFrameElement).srcdoc.length);
    check(srcLen > 50_000, "レポート HTML が iframe に入っている（自己完結の大きさ）", srcLen);
    await viewer.screenshot({ path: path.join(OUT_DIR, "d-result.png"), fullPage: false });

    if (HIPPO_DB) {
      console.log("\n[D4] 海馬");
      await viewer.getByTestId("ba-hippo-result").waitFor({ state: "visible", timeout: 10_000 });
      const left = (await viewer.getByTestId("ba-hippo-left").textContent()) ?? "";
      const right = (await viewer.getByTestId("ba-hippo-right").textContent()) ?? "";
      console.log(`  ${left}\n  ${right}`);
      const hs = (await viewer.evaluate(() => (window as unknown as { __brainAtrophyState: { hippoResult: { left: { z: number; volume_ml: number }; right: { z: number; volume_ml: number } } } }).__brainAtrophyState.hippoResult));
      check(/左: Z [+-]\d/.test(left) && /右: Z [+-]\d/.test(right), "画面に左右の Z・体積・百分位が出る", { left, right });
      check(left.includes(hs.left.z.toFixed(2)) && right.includes(hs.right.z.toFixed(2)), "画面の Z が結果ファイルの値と一致する");
      const expP = process.env.BA_HIPPO_EXPECT;
      if (expP) {
        const e = JSON.parse(fs.readFileSync(expP, "utf8")) as { left: { z: number; volume_ml: number }; right: { z: number; volume_ml: number } };
        console.log(`  直接実行: 左 Z ${e.left.z.toFixed(2)}・${e.left.volume_ml} mL／右 Z ${e.right.z.toFixed(2)}・${e.right.volume_ml} mL`);
        check(Math.abs(hs.left.z - e.left.z) < 0.15 && Math.abs(hs.right.z - e.right.z) < 0.15, "海馬の Z が CLI の直接実行と 0.15 以内（HippoDeep は本体経路でも同じ値）", { app: hs, direct: e });
      }
      await viewer.getByTestId("ba-hippo-result").scrollIntoViewIfNeeded();
      await viewer.screenshot({ path: path.join(OUT_DIR, "d4-hippo.png") });
    }

    if (VOI_DB) {
      console.log("\n[D5] 鑑別の参考指標");
      await viewer.getByTestId("ba-voi-result").waitFor({ state: "visible", timeout: 10_000 });
      const mtl = (await viewer.getByTestId("ba-voi-mtl").textContent()) ?? "";
      const dbs = (await viewer.getByTestId("ba-voi-dbs").textContent()) ?? "";
      console.log(`  ${mtl}\n  ${dbs}`);
      const vs = (await viewer.evaluate(() => (window as unknown as { __brainAtrophyState: { voiResult: { mtl: { score: number }; dbs_white: { score: number }; ratio_white: number | null } } }).__brainAtrophyState.voiResult));
      check(/MTL_Z.*\d\.\d\d/.test(mtl) && /DBS_Z_white.*\d\.\d\d/.test(dbs), "画面に MTL_Z・DBS_Z_white・比が出る", { mtl, dbs });
      check(mtl.includes(vs.mtl.score.toFixed(2)) && dbs.includes(vs.dbs_white.score.toFixed(2)), "画面の値が結果ファイルの値と一致する");
      const ev = process.env.BA_VOI_EXPECT;
      if (ev) {
        const e = JSON.parse(fs.readFileSync(ev, "utf8")) as { mtl: { score: number }; dbs_white: { score: number } };
        console.log(`  直接実行: MTL_Z ${e.mtl.score.toFixed(3)}・DBS_Z_white ${e.dbs_white.score.toFixed(3)}`);
        check(Math.abs(vs.mtl.score - e.mtl.score) < 0.1 && Math.abs(vs.dbs_white.score - e.dbs_white.score) < 0.1, "参考指標が CLI の直接実行と 0.1 以内（本体経路でも同じ値）", { app: vs, direct: e });
      }
      await viewer.getByTestId("ba-voi-result").scrollIntoViewIfNeeded();
      await viewer.screenshot({ path: path.join(OUT_DIR, "d5-voi.png") });
    }

    console.log("\n[D2] 処理の確認（段ごとの画像）");
    await viewer.getByTestId("ba-tab-stages").click();
    await viewer.getByTestId("ba-stage-btn-input").waitFor({ state: "visible", timeout: 60_000 });
    try {
      await viewer.waitForFunction(() => !!(window as unknown as { __brainAtrophyState: { stageView?: { stage?: string } } }).__brainAtrophyState.stageView?.stage, null, { timeout: 60_000 });
    } catch (e) {
      const dump = await viewer.evaluate(() => ({ sv: (window as unknown as { __brainAtrophyState: { stageView?: { error?: string } } }).__brainAtrophyState.stageView?.error, status: document.querySelector('[data-testid="ba-stage-status"]')?.textContent }));
      await viewer.screenshot({ path: path.join(OUT_DIR, "stage-timeout.png") });
      throw new Error(`段の確認が開かない: ${JSON.stringify(dump)} / ${(e as Error).message}`);
    }
    for (const id of ["input", "brain", "n4", "register", "segment", "zscore", ...(HIPPO_DB ? ["hippo"] : [])]) {
      await viewer.getByTestId(`ba-stage-btn-${id}`).click();
      await viewer.waitForFunction((want) => (window as unknown as { __brainAtrophyState: { stageView: { stage: string } } }).__brainAtrophyState.stageView.stage === want, id, { timeout: 60_000 });
      const sizes = await viewer.evaluate(() => (["axial", "coronal", "sagittal"] as const).map((p) => {
        const c = document.querySelector(`[data-testid="ba-view-${p}"]`) as HTMLCanvasElement;
        const r = c.getBoundingClientRect();
        const ctx = c.getContext("2d")!;
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
        return { plane: p, px: [c.width, c.height], css: [Math.round(r.width), Math.round(r.height)], lit: lit / (c.width * c.height) };
      }));
      console.log(`  ${id}: ${JSON.stringify(sizes)}`);
      check(sizes.every((z) => z.lit > 0.02), `段 ${id}: 3 断面とも描かれている（点灯画素 > 2%）`, sizes);
      await viewer.getByTestId("ba-pane-stages").scrollIntoViewIfNeeded();
      await viewer.screenshot({ path: path.join(OUT_DIR, `stage-${id}.png`) });
    }
    await viewer.getByTestId("ba-stage-btn-input").click();
    await viewer.waitForFunction(() => (window as unknown as { __brainAtrophyState: { stageView: { stage: string } } }).__brainAtrophyState.stageView.stage === "input", null, { timeout: 30_000 });
    const axialAspect = await viewer.evaluate(() => { const c = document.querySelector('[data-testid="ba-view-axial"]') as HTMLCanvasElement; const r = c.getBoundingClientRect(); return { px: c.width / c.height, css: r.width / r.height }; });
    // 入力の格子は 150×256 画素（R 1.2 mm・A 0.94 mm）。mm の比なら 画面の 幅/高さ ≒ 150*1.2/(256*0.94) = 0.748、正方画素なら 0.586
    check(Math.abs(axialAspect.css - 0.748) < 0.03 && Math.abs(axialAspect.px - 0.586) < 0.01, "非等方の入力は mm の比で描かれる（画面 0.748・画素数の比 0.586 ではない）", axialAspect);
    await viewer.getByTestId("ba-stage-ok").click();
    check((((await viewer.getByTestId("ba-stage-summary").textContent()) ?? "").includes(`確認した 1／${HIPPO_DB ? 7 : 6}`)), "［確認した］で集計が更新される");

    console.log("\n[D3] 保存ボタン（HTML・PDF）");
    const saveDir = path.join(OUT_DIR, "saved");
    fs.rmSync(saveDir, { recursive: true, force: true });
    fs.mkdirSync(saveDir, { recursive: true });
    await driver.app.evaluate(({ dialog }, dir) => {
      dialog.showSaveDialog = (async (_w: unknown, o: { defaultPath?: string }) => ({ canceled: false, filePath: `${dir}/${String(o?.defaultPath ?? "out").split("/").pop()}` })) as unknown as typeof dialog.showSaveDialog;
    }, saveDir);
    await viewer.getByTestId("ba-tab-report").click();
    await viewer.getByTestId("ba-save-html").click();
    await viewer.getByTestId("ba-save-pdf").click();
    await viewer.waitForFunction(() => !!(window as unknown as { __brainAtrophyState: { saved?: unknown } }).__brainAtrophyState.saved, null, { timeout: 20_000 }).catch(() => undefined);
    await viewer.waitForTimeout(1500);
    const htmlSaved = path.join(saveDir, "brain-atrophy-report.html");
    const pdfSaved = path.join(saveDir, "brain-atrophy-report.pdf");
    check(fs.existsSync(htmlSaved) && /^<!doctype html>/i.test(fs.readFileSync(htmlSaved, "utf8").slice(0, 40)) && fs.statSync(htmlSaved).size > 50_000, "HTML を保存でき、中身はレポート（doctype・十分な大きさ）", fs.existsSync(htmlSaved) ? fs.statSync(htmlSaved).size : "なし");
    check(fs.existsSync(pdfSaved) && fs.readFileSync(pdfSaved).subarray(0, 5).toString() === "%PDF-" && fs.statSync(pdfSaved).size > 100_000, "PDF を保存でき、中身は PDF（%PDF-・十分な大きさ）", fs.existsSync(pdfSaved) ? fs.statSync(pdfSaved).size : "なし");

    console.log("\n[E] 監査");
    const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string; endpointKind?: string; host?: string; outcome?: string });
    const reqs = events.filter((e) => e.event === "egress-requested");
    check(reqs.length === 2 && reqs.every((e) => e.endpointKind === "local" && /^127\.0\.0\.1/.test(e.host ?? "")), "監査: 送信要求 2 件とも local・127.0.0.1", reqs);
    check(events.filter((e) => e.event === "compute-finished").every((e) => e.outcome === "ok"), "監査: 終了はすべて ok");
    const auditText = fs.readFileSync(AUDIT, "utf8");
    check(!auditText.includes("SPIKE-IXI-0001"), "🔴 監査に患者 ID が無い");
    if (birth) {
      check(!auditText.includes("編集後") && !auditText.includes("太郎") && !auditText.includes(pid), "🔴 監査・台帳に患者名・患者 ID・編集後の氏名が残らない");
      const html = fs.existsSync(htmlSaved) ? fs.readFileSync(htmlSaved, "utf8") : "";
      check(html.includes("編集後 太郎") && html.includes(pid) && html.includes(iso(birth)), "レポート表紙に、編集後の患者名・患者 ID・生年月日が載る");
    }

    const expectPath = process.env.BA_EXPECT;
    if (expectPath) {
      console.log("\n[F] CLI の直接実行との突き合わせ");
      const exp = JSON.parse(fs.readFileSync(expectPath, "utf8")) as Record<string, number>;
      const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-9);
      console.log(`  アプリ: ${JSON.stringify(m)}\n  直接  : ${JSON.stringify(exp)}`);
      check(Math.abs(m.frac_z_gt2 - exp.frac_z_gt2) < 0.01, "Z>2 割合が直接実行と 1 ポイント以内", { app: m.frac_z_gt2, direct: exp.frac_z_gt2 });
      check(rel(m.gm_ml, exp.gm_ml) < 0.02, "GM 体積が直接実行と 2% 以内", { app: m.gm_ml, direct: exp.gm_ml });
      check(Math.abs(m.mean_z - exp.mean_z) < 0.05, "Z 平均が直接実行と 0.05 以内", { app: m.mean_z, direct: exp.mean_z });
    }
  } finally {
    await driver.stop();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    if (summary() > 0) process.exitCode = 1;
  });

/*
 * パノラマ X 線の歯式チャート プラグイン（tatsunidas/graphy-next-plugin-dental-pano）の実機検証。
 *
 * 実行:  cd automator && GRAPHY_DENTAL_PYBIN=<ultralytics・torch・jupyter_server・ipykernel の入った venv の bin> \
 *          GRAPHY_DENTAL_DCM=<Modality PX の DICOM 1 枚> \
 *          GRAPHY_DENTAL_WEIGHTS_DIR=<teeth-seg.pt（と dx-det.pt）を置いたフォルダ> GRAPHY_DENTAL_REF=<ref.json> GRAPHY_DENTAL_BAD_TEETH=<固定と違う歯の重み> \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=28710 GRAPHY_AUTOMATOR_SCP_PORT=28711 GRAPHY_AUTOMATOR_VITE_PORT=28713 \
 *          npx tsx src/spike/dentalPanoPluginCheck.ts [ok|ok-dx|bad-weights|no-spacing|missing-deps|missing-weights]
 *   重みは WEIGHTS_DIR から一時の HOME（~/.graphy-next/models/vis-dental-pano/）へ symlink する（本物の HOME の重みに依存しない）。
 *   REF: 同じ重み・同じ画素を、本体を通さず ultralytics で直接動かした結果 {teeth:[{fdi,conf,bbox}], dx:[{cls,conf,bbox}]}（真値の代わり）。
 *   ok              : 診断の重み無し（dx-det.pt を置かない）。既定のまま（選択欄・チェックは触らない）事前チェック → 本処理 → 結果。本体の ROI が実際に置かれる
 *   ok-dx           : 診断の重みあり。結果が REF と一致（本数・番号・クラス・枠）、チャートの印・表・レポート・SR の所見数・ROI の数が結果と一致
 *   bad-weights     : 歯の重みが固定した sha256 と違う（GRAPHY_DENTAL_BAD_TEETH）。事前チェックが止まり、本処理は出ない（負例）。理由文は画面の言語（日本語か英語）だけ
 *   ok / ok-dx      : 各操作部品・見出し・診断の行・チャートの 32 マス・印・凡例に tooltip（title）があり、言語が画面とそろう。ホバーの撮影は best effort（標準の tooltip は OS が描く）
 *   no-spacing      : 画素間隔の無い DICOM（GRAPHY_DENTAL_DCM に指定）で、本体が ROI を置けない（no-geometry）とき、理由が画面に出て、チャートとレポートは使える（負例）
 *   missing-deps    : ultralytics・torch などが何も入っていない環境（GRAPHY_DENTAL_BAREBIN: jupyter_server と ipykernel だけの venv の bin）で、
 *                     事前チェックが不足と導入コマンドを出して止まる → 入れた（.pth で GRAPHY_DENTAL_PYBIN の site-packages を見せる）あと、
 *                     本体を再起動せずに［再確認］で通り、最後まで実行できる（負例→正例）
 *   missing-weights : 重みの置き場（HOME）を空にした環境で、事前チェックが置き場つきで止まり、本処理は出ない（負例）
 *   起動前に frontend/node_modules/.vite を消すこと。Linux 専用。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { consentWindow, createChecker, openAnalysisPlugin } from "./computeSpikeShared.js";

const MODE = process.argv[2] ?? "ok";
const JA = /[\u3040-\u30ff\u4e00-\u9fff]/;
// 結果の画面で title（tooltip）を持つべき部品（ui.test.mjs の TIP_IDS と同じ）
const TIP_IDS = ["dp-run", "dp-chart-title", "dp-overlays-title", "dp-show-teeth", "dp-show-dx", "dp-clear", "dp-dx-title", "dp-dx-row",
  "dp-report-title", "dp-report", "dp-copy", "dp-save-sr", "dp-save-csv", "dp-publish", "dp-meta"];
const PLUGIN_ID = "vis-dental-pano";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", `dental-pano-check-${MODE}`);
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");
const { check, summary } = createChecker();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const state = (viewer: Page): Promise<any> => viewer.evaluate(() => (window as unknown as { __dentalPanoState?: unknown }).__dentalPanoState ?? null);
// 本体のデバッグ API（dev ビルド）が返す全注釈の一覧。プラグインの createRoi が実際に本体へ置かれたかを数える
const annotationCount = (viewer: Page): Promise<number> =>
  viewer.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (window as any).__graphyDebug;
    return d?.getRoiStatsPair ? d.getRoiStatsPair().length : -1;
  });

type TextBoxRow = { uid: string; tool: string; textBoxVisibility: boolean | null; statsOffMark: boolean };
// 本体のデバッグ API（dev ビルド）が返す、注釈ごとの textBoxVisibility（統計の文字を出すか）と出さない印の有無
const textBoxRows = (viewer: Page): Promise<TextBoxRow[]> =>
  viewer.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (window as any).__graphyDebug;
    return d?.getRoiTextBoxVisibility ? d.getRoiTextBoxVisibility() : [];
  });

function installPlugin(): void {
  const src = process.env.GRAPHY_DENTAL_PLUGIN_DIR ?? path.join(AUTOMATOR_ROOT, "..", "..", "..", "graphy-next-plugin-dental-pano");
  if (!fs.existsSync(path.join(src, "ui.js"))) throw new Error(`プラグインの作業コピーがありません: ${src}`);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(src, "plugin.json"), "utf8"));
  manifest.engines = { ...manifest.engines, graphy: ">=0.0.0" };
  fs.writeFileSync(path.join(dst, "plugin.json"), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(src, "ui.js"), path.join(dst, "ui.js"));
}

async function main(): Promise<void> {
  const bin = process.env.GRAPHY_DENTAL_PYBIN;
  const dcm = process.env.GRAPHY_DENTAL_DCM;
  if (!bin || !fs.existsSync(path.join(bin, "python"))) throw new Error("GRAPHY_DENTAL_PYBIN に venv の bin を指定してください");
  if (!dcm || !fs.existsSync(dcm)) throw new Error("GRAPHY_DENTAL_DCM に PX の DICOM を指定してください");
  const bare = process.env.GRAPHY_DENTAL_BAREBIN;
  if (MODE === "missing-deps" && (!bare || !fs.existsSync(path.join(bare, "python")))) throw new Error("missing-deps には GRAPHY_DENTAL_BAREBIN（jupyter_server と ipykernel だけの venv の bin）が要る");
  if (MODE === "missing-deps") {
    // 前回の実行が「導入したことにする」ために書いた .pth が残っていると、最初から揃っていて不足の検査にならない
    const lib = path.join(bare as string, "..", "lib");
    for (const d of fs.readdirSync(lib).filter((x) => x.startsWith("python"))) fs.rmSync(path.join(lib, d, "site-packages", "zz-installed.pth"), { force: true });
  }
  process.env.PATH = `${MODE === "missing-deps" ? (bare as string) : bin}${path.delimiter}${process.env.PATH}`;
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "dental-home-"));
  if (MODE === "missing-weights") process.env.HOME = emptyHome; // 重みの置き場 ~/.graphy-next/models/... を空にする
  else {
    const wdir = process.env.GRAPHY_DENTAL_WEIGHTS_DIR;
    if (!wdir || !fs.existsSync(path.join(wdir, "teeth-seg.pt"))) throw new Error("GRAPHY_DENTAL_WEIGHTS_DIR に teeth-seg.pt を置いたフォルダを指定してください");
    const bad = process.env.GRAPHY_DENTAL_BAD_TEETH;
    if (MODE === "bad-weights" && (!bad || !fs.existsSync(bad))) throw new Error("bad-weights には GRAPHY_DENTAL_BAD_TEETH（固定と違う歯の重み）が要る");
    if (MODE === "ok-dx" && !fs.existsSync(path.join(wdir, "dx-det.pt"))) throw new Error("ok-dx には WEIGHTS_DIR に dx-det.pt が要る");
    const md = path.join(emptyHome, ".graphy-next", "models", PLUGIN_ID);
    fs.mkdirSync(md, { recursive: true });
    fs.symlinkSync(MODE === "bad-weights" ? (bad as string) : path.join(wdir, "teeth-seg.pt"), path.join(md, "teeth-seg.pt"));
    if (MODE === "ok-dx") fs.symlinkSync(path.join(wdir, "dx-det.pt"), path.join(md, "dx-det.pt"));
    process.env.HOME = emptyHome;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();
  fs.rmSync(AUDIT, { force: true });

  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    page.on("console", (m) => {
      if (m.type() === "error" && !/404|Failed to load resource/.test(m.text())) console.log(`  [renderer error] ${m.text().slice(0, 200)}`);
    });
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [dcm]);
    check(imp.imported === 1 && imp.failed === 0, "PX の DICOM が 1 枚取り込まれている（操作が効いている前提）", imp);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
    });

    const base = `http://localhost:${driver.ports.http}`;
    const study = ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[])[0];
    const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; modality: string }[];
    const px = series.find((s) => s.modality === "PX");
    check(!!px, "Modality PX のシリーズが一覧に出る", series);
    if (!px) throw new Error("PX がありません");

    console.log("\n[1] 2D ビューアで PX を開き、プラグインを起動");
    await dismissStartupDialogs(page);
    // 新しい版の通知（GitHub の最新版との比較で、リリースが出ると開く）が検索欄のクリックを遮る。「Later」で閉じる
    const later = page.getByRole("button", { name: "Later", exact: true });
    if (await later.waitFor({ state: "visible", timeout: 8_000 }).then(() => true, () => false)) await later.click();
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByTestId("search-submit-button").click();
    await page.waitForTimeout(2_000);
    await page.locator(`[data-testid="study-row-${study.studyInstanceUid}"]`).click();
    await page.locator(`[data-testid="series-row-${px.seriesInstanceUid}"]`).click();
    const viewer = await driver.waitForNewPage(
      () => page.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);
    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-before.png") });
    const before = await annotationCount(viewer);
    const uidsBefore = new Set((await textBoxRows(viewer)).map((r) => r.uid));
    check(before >= 0, "本体の注釈（cornerstoneTools）を数えられる", before);
    await openAnalysisPlugin(viewer, PLUGIN_ID);
    await viewer.getByTestId("dp-run").waitFor({ state: "visible", timeout: 10_000 });
    const disclaimer = (await viewer.getByTestId("dp-disclaimer").textContent()) ?? "";
    check(/診断.*使わないでください/.test(disclaimer) || /Do not use for diagnosis/.test(disclaimer), "免責が実行前から出ている", disclaimer.slice(0, 80));

    console.log("\n[2] 実行: 事前チェック（同意 1 回目・画像なし）");
    await viewer.getByTestId("dp-run").click();
    {
      const pw = await consentWindow(driver, 120_000);
      const pcode = (await pw.locator("#code").textContent()) ?? "";
      check(pcode.includes("stage('probe'") && !pcode.includes("load_image('inputs/0.npz')"), "事前チェックの同意画面: コードは環境と重みの確認だけ（画像を読まない）");
      await pw.getByTestId("consent-ack").check();
      await pw.getByTestId("consent-send").click();
    }
    const approveProbe = async (): Promise<void> => {
      const pw = await consentWindow(driver, 120_000);
      await pw.getByTestId("consent-ack").check();
      await pw.getByTestId("consent-send").click();
    };
    if (MODE === "missing-deps") {
      const bareRoot = (bare as string).replace(/\/bin$/, "");
      await viewer.getByTestId("dp-env").waitFor({ state: "visible", timeout: 120_000 });
      const box = (await viewer.getByTestId("dp-env").textContent()) ?? "";
      const cmd = await viewer.getByTestId("dp-env-command").inputValue();
      await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-env-panel.png") });
      const st0 = await state(viewer);
      check(st0.phase === "idle" && !(await viewer.getByTestId("dp-result").isVisible()), "不足のとき本処理は出ない（結果の欄も出ない）", st0.phase);
      check(st0.env?.python?.startsWith(bareRoot), "使われる Python が検査した（空の）venv のもの", st0.env?.python);
      check(/ultralytics.*(入っていません|not installed)/.test(box) && /torch.*(入っていません|not installed)/.test(box), "入っていないものが枠に出る", box.slice(0, 300));
      check(cmd.startsWith(`${bareRoot}/bin/python`) && /-m pip install ultralytics==8\.4\.208 torch numpy pillow$/.test(cmd), "導入コマンドが、使われる Python を名指しして不足を揃えている", cmd);
      console.log(`  導入コマンド: ${cmd}`);
      const sites = (dir: string) => fs.readdirSync(path.join(dir, "..", "lib")).filter((d) => d.startsWith("python")).map((d) => path.join(dir, "..", "lib", d, "site-packages"));
      fs.writeFileSync(path.join(sites(bare as string)[0], "zz-installed.pth"), sites(bin)[0] + "\n");
      console.log("\n[2b] 導入したことにして（本体は再起動しない）［再確認］");
      await viewer.getByTestId("dp-env-recheck").click();
      await approveProbe();
      await viewer.waitForFunction(
        () => /環境は整いました|environment is ready/i.test(document.querySelector('[data-testid="dp-status"]')?.textContent ?? ""),
        null,
        { timeout: 120_000 },
      );
      check(!(await viewer.getByTestId("dp-env").isVisible()), "再確認で枠が消える（本体の再起動なし）");
      await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-env-fixed.png") });
      await viewer.getByTestId("dp-run").click();
    }
    if (MODE === "bad-weights") {
      await viewer.getByTestId("dp-env").waitFor({ state: "visible", timeout: 120_000 });
      const prob = (await viewer.getByTestId("dp-env-problem").textContent()) ?? "";
      await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-bad-weights.png") });
      const st0 = await state(viewer);
      check(/teeth-seg\.pt/.test(prob) && /(sha256|固定した版|pinned|differs)/i.test(prob), "固定した版と違う歯の重みが理由つきで止まる", prob.slice(0, 200));
      const uiJa = JA.test((await viewer.getByTestId("dp-run").textContent()) ?? "");
      check(uiJa ? JA.test(prob) && !/does not match/.test(prob) : /does not match the pinned version/.test(prob) && !JA.test(prob), `理由文が画面の言語（${uiJa ? "日本語" : "英語"}）だけで出る（もう一方の言語が混ざらない）`, prob.slice(0, 200));
      check(st0.phase === "idle" && !(await viewer.getByTestId("dp-result").isVisible()), "止まったとき本処理は出ない（結果の欄も出ない）", st0.phase);
      const events0 = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      check(events0.filter((e: { event: string }) => e.event === "egress-requested").length === 1, "監査: 送信の要求は事前チェックの 1 件だけ（画像は出ていない）");
      if (summary() > 0) process.exitCode = 1;
      return;
    }
    if (MODE === "missing-weights") {
      await viewer.getByTestId("dp-env").waitFor({ state: "visible", timeout: 120_000 });
      const box = (await viewer.getByTestId("dp-env").textContent()) ?? "";
      await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-env-panel.png") });
      const st0 = await state(viewer);
      check(/teeth-seg\.pt/.test(box) && box.includes(path.join(emptyHome, ".graphy-next")), "不足した重みと置き場が枠に出る", box.slice(0, 300));
      check(st0.phase === "idle" && !(await viewer.getByTestId("dp-result").isVisible()), "不足のとき本処理は出ない（結果の欄も出ない）", st0.phase);
      const events0 = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      check(events0.filter((e: { event: string }) => e.event === "egress-requested").length === 1, "監査: 送信の要求は事前チェックの 1 件だけ（画像は出ていない）");
      if (summary() > 0) process.exitCode = 1;
      return;
    }

    console.log("\n[3] 本処理（同意 2 回目・画像あり）");
    const win = await consentWindow(driver, 120_000).catch(async (e) => {
      await viewer.screenshot({ path: path.join(OUT_DIR, "fail-consent2.png") });
      console.log("  状態:", JSON.stringify(await state(viewer))?.slice(0, 1500));
      throw e;
    });
    const code = (await win.locator("#code").textContent()) ?? "";
    check(code.includes("retina_masks=True") && code.includes("8.4.208"), "同意画面のコードに推論の呼び出しと固定した版が見える");
    await win.screenshot({ path: path.join(OUT_DIR, "consent.png") });
    await win.getByTestId("consent-ack").check();
    await win.getByTestId("consent-send").click();
    await viewer.waitForFunction(
      () => ["done", "failed"].includes((window as unknown as { __dentalPanoState?: { phase: string } }).__dentalPanoState?.phase ?? ""),
      null,
      { timeout: 900_000 },
    );
    const st = await state(viewer);
    fs.writeFileSync(path.join(OUT_DIR, "state.json"), JSON.stringify({ ...st, result: undefined, resultTeeth: st.result?.teeth?.length }, null, 2));
    await viewer.waitForTimeout(1_500);
    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-result.png") });

    console.log("\n[4] 結果");
    check(st.phase === "done", "最後まで走る", { phase: st.phase, error: st.error, status: st.status });
    const res = st.result ?? {};
    const nTeeth: number = res.teeth?.length ?? 0;
    check(nTeeth >= 20 && nTeeth <= 32, "歯が 20〜32 本検出される（この画像は 26 本前後）", nTeeth);
    check(res.teeth?.every((t: { fdi: number }) => t.fdi >= 11 && t.fdi <= 48 && t.fdi % 10 >= 1 && t.fdi % 10 <= 8), "番号はすべて永久歯の FDI");
    const wantDx = MODE === "ok-dx";
    check(wantDx ? Array.isArray(res.dx) : res.dx === null, wantDx ? "診断モデルがあるので dx は配列" : "診断モデルが無いので dx は null（空配列ではない）", res.dx);
    check(String(res.model).includes("teeth=teeth-seg.pt@75dd697a") && String(res.model).includes(wantDx ? "dx=dx-det.pt@62a498a7" : "dx=none"), "使った重みの版（sha256 の先頭）が結果に残る", res.model);
    const nDx: number = res.dx?.length ?? 0;
    if (wantDx) {
      const refPath = process.env.GRAPHY_DENTAL_REF;
      if (!refPath || !fs.existsSync(refPath)) throw new Error("ok-dx には GRAPHY_DENTAL_REF が要る");
      const ref = JSON.parse(fs.readFileSync(refPath, "utf8")) as { teeth: { fdi: number; bbox: number[] }[]; dx: { cls: string; bbox: number[] }[] };
      const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 3);
      check(res.teeth.length === ref.teeth.length && ref.teeth.every((r) => res.teeth.some((t: { fdi: number; bbox: number[] }) => t.fdi === r.fdi && near(t.bbox, r.bbox))), "歯: 本数・番号・枠が、直接動かした結果（参照）と一致（枠の差 3 px 以内）", { app: res.teeth.length, ref: ref.teeth.length });
      check(nDx === ref.dx.length && ref.dx.every((r) => res.dx.some((d: { cls: string; bbox: number[] }) => d.cls === r.cls && near(d.bbox, r.bbox))), "診断: 件数・クラス・枠が、直接動かした結果（参照）と一致（枠の差 3 px 以内）", { app: res.dx?.map((d: { cls: string }) => d.cls), ref: ref.dx.map((d) => d.cls) });
      check(res.dx.every((d: { fdi: number | null; overlap: number }) => d.fdi !== null && d.overlap > 0.5), "どの診断も、重なりの大きい歯に割り当てられている（歯を特定できずが 0 件）", res.dx.map((d: { fdi: number | null; overlap: number }) => `${d.fdi}:${d.overlap.toFixed(2)}`));
    }
    const detected = await viewer.locator('[data-testid^="fdi-"][data-state="detected"]').count();
    const missing = await viewer.locator('[data-testid^="fdi-"][data-state="missing"]').count();
    check(detected === nTeeth && detected + missing === 32, "チャート: 検出の数が結果と一致し、合計 32 マス", { detected, missing, nTeeth });
    const report = await viewer.getByTestId("dp-report").inputValue();
    const noModelText = /(診断モデルは使っていません|No diagnosis model was used)/.test(report);
    check(new RegExp(`(検出した歯: ${nTeeth} 本|Detected teeth: ${nTeeth} )`).test(report) && noModelText === !wantDx, wantDx ? "レポートの本数が結果と一致し、『診断モデル無し』が出ていない" : "レポートの本数と『診断モデル無し』が結果と一致（本体のロケールの言語で）", report.slice(0, 200));
    if (wantDx) {
      const pairs = new Set<string>(res.dx.map((d: { fdi: number; cls: string }) => `${d.fdi}:${d.cls}`));
      check((await viewer.locator("[data-dx-key]").count()) === pairs.size, "チャート: 診断の印の数が、（歯, クラス）の組の数と一致", { marks: await viewer.locator("[data-dx-key]").count(), pairs: pairs.size });
      check((await viewer.getByTestId("dp-dx-row").count()) === nDx, "診断の表の行数が結果の件数と一致", await viewer.getByTestId("dp-dx-row").count());
      for (const g of new Set<string>(res.dx.map((d: { cls: string }) => d.cls))) {
        const teeth = [...new Set<number>(res.dx.filter((d: { cls: string }) => d.cls === g).map((d: { fdi: number }) => d.fdi))].sort((a, b) => a - b);
        check(teeth.every((f) => report.includes(String(f))), `レポートに ${g} の歯の番号が全部載る`, { g, teeth });
      }
    }
    check(((await viewer.getByTestId("dp-disclaimer").textContent()) ?? "").length > 20, "結果が出た後も免責が残る");

    console.log("\n[4b] tooltip（各機能の補足）");
    const ids = wantDx ? TIP_IDS : TIP_IDS.filter((i) => i !== "dp-dx-row");
    const noTitle: string[] = await viewer.evaluate((list: string[]) => list.filter((id) => {
      const els = Array.from(document.querySelectorAll(`[data-testid="${id}"]`));
      return !els.length || els.some((e) => !(e.getAttribute("title") ?? "").trim());
    }), ids);
    check(noTitle.length === 0, "操作部品・見出し・診断の行に title（tooltip）がある", noTitle);
    const cells: { id: string; t: string }[] = await viewer.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="fdi-"]')).map((g) => ({ id: g.getAttribute("data-testid") ?? "", t: g.querySelector(":scope > title")?.textContent ?? "" })));
    check(cells.length === 32 && cells.every((c) => c.t.trim()), "チャートの 32 マスすべてに <title>", cells.filter((c) => !c.t.trim()).map((c) => c.id));
    const detectedCells = cells.filter((c) => res.teeth.some((t: { fdi: number }) => `fdi-${t.fdi}` === c.id));
    check(detectedCells.length === nTeeth && detectedCells.every((c) => c.t.includes(`FDI ${c.id.slice(4)}`) && /(confidence|信頼度)/.test(c.t)), "検出したマスの tooltip に FDI と信頼度が入る", detectedCells.slice(0, 1));
    const legend: string[] = await viewer.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="legend-"]')).map((g) => g.querySelector("title")?.textContent ?? ""));
    check(legend.length === 4 && legend.every((t) => t.trim().length > 10), "凡例の 4 項目に tooltip", legend.length);
    if (wantDx) {
      const marks: string[] = await viewer.evaluate(() => Array.from(document.querySelectorAll("[data-dx-key]")).map((r) => r.querySelector("title")?.textContent ?? ""));
      check(marks.length > 0 && marks.every((t) => /(歯単位|tooth, not the exact lesion)/.test(t)), "診断の印の tooltip に『枠は歯単位で病変の位置ではない』が入る", marks.length);
    }
    // 本体の画面の部品（ツールバーなど）の title を混ぜない: プラグインの窓の中（実行ボタンを含む親）だけを数える
    const titles: string[] = await viewer.evaluate(() => {
      const root = document.querySelector('[data-testid="dp-run"]')?.parentElement ?? document.createElement("div");
      return Array.from(root.querySelectorAll("[title]")).map((e) => e.getAttribute("title") ?? "").concat(Array.from(root.querySelectorAll("svg title")).map((e) => e.textContent ?? ""));
    });
    const jaCount = titles.filter((t) => JA.test(t)).length;
    check(titles.length >= 40 && (jaCount === 0 || jaCount === titles.length), "tooltip の言語が画面とそろい、日本語と英語が混ざらない", { total: titles.length, ja: jaCount });
    // ホバー（best effort）: 標準の tooltip は OS が描くので撮れないことがある。撮れたら見る。撮れなくても失敗にはしない
    try {
      const box = await viewer.getByTestId(wantDx ? "fdi-16" : "dp-run").boundingBox();
      if (box) {
        await viewer.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await viewer.waitForTimeout(2_500);
        const { execFileSync } = await import("node:child_process");
        execFileSync("xwd", ["-root", "-display", process.env.DISPLAY ?? ":0", "-out", path.join(OUT_DIR, "tooltip-hover.xwd")], { timeout: 20_000 });
        console.log("  （ホバーの X 画面を tooltip-hover.xwd に保存。PNG に直して、tooltip が写っているかを目で見る）");
      }
    } catch {
      console.log("  （ホバーの X 画面の撮影はできなかった。tooltip の見た目は未確認）");
    }

    if (MODE === "no-spacing") {
      console.log("\n[5] 本体が ROI を置けない画像（画素間隔なし）");
      const msg = (await viewer.getByTestId("dp-overlay-msg").textContent()) ?? "";
      check(st.overlay?.placed === 0 && st.overlay?.reasons?.["no-geometry"] === nTeeth, "歯の輪郭はすべて no-geometry で置けなかった（黙って成功にしない）", st.overlay);
      check(/no-geometry/.test(msg) && /(画素間隔|pixel spacing)/.test(msg), "理由が画面に出ている", msg);
      check((await annotationCount(viewer)) === before, "本体の注釈は増えていない", await annotationCount(viewer));
      await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-no-geometry.png") });
      if (summary() > 0) process.exitCode = 1;
      return;
    }

    console.log("\n[5] 画像への重ね表示（既定のまま）");
    const after = await annotationCount(viewer);
    check(st.overlay?.placed === nTeeth + nDx && st.overlay?.failed === 0, "歯の輪郭と診断の枠がすべて置かれた（失敗 0）", st.overlay);
    check(after - before === nTeeth + nDx, "本体の注釈が歯と診断の数だけ増えた（実際に置かれている）", { before, after, nTeeth, nDx });
    if (wantDx) {
      await viewer.getByTestId("dp-show-dx").uncheck();
      await viewer.waitForTimeout(800);
      check((await annotationCount(viewer)) - before === nTeeth, "診断の枠のチェックだけを外すと、歯の輪郭だけが残る", (await annotationCount(viewer)) - before);
      await viewer.getByTestId("dp-show-dx").check();
      await viewer.waitForTimeout(800);
      check((await annotationCount(viewer)) - before === nTeeth + nDx, "チェックを戻すと診断の枠が再び置かれる");
    }
    const firstFdi: number = res.teeth[0].fdi;
    await viewer.getByTestId(`fdi-${firstFdi}`).click();
    await viewer.waitForTimeout(500);
    check((await state(viewer)).selectedFdi === firstFdi, "チャートの歯を押すと、その歯が選ばれる", (await state(viewer)).selectedFdi);
    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-selected.png") });
    await viewer.getByTestId("dp-show-teeth").uncheck();
    if (wantDx) await viewer.getByTestId("dp-show-dx").uncheck();
    await viewer.waitForTimeout(800);
    const off = await annotationCount(viewer);
    check(off === before, "チェックを全部外すと注釈が元の数に戻る", { before, off });
    await viewer.getByTestId("dp-show-teeth").check();
    if (wantDx) await viewer.getByTestId("dp-show-dx").check();
    await viewer.waitForTimeout(800);
    check((await annotationCount(viewer)) - before === nTeeth + nDx, "チェックを戻すと再び置かれる");
    // プラグインが置いた ROI は、統計の文字（Area / Mean）を出さない設定になっている。利用者の ROI など、印の無い ROI は出る（対照）
    const rows = await textBoxRows(viewer);
    const mine = rows.filter((r) => !uidsBefore.has(r.uid));
    check(mine.length === nTeeth + nDx, "プラグインが置いた ROI の textBoxVisibility を読めた（歯と診断の数）", { mine: mine.length, nTeeth, nDx });
    const notOff = mine.filter((r) => r.textBoxVisibility !== false);
    check(mine.length > 0 && notOff.length === 0, "プラグインが置いた ROI はすべて textBoxVisibility が false（統計の文字を出さない）", { 件数: mine.length, 出る設定のまま: notOff.length });
    check(mine.length > 0 && mine.every((r) => r.statsOffMark), "プラグインが置いた ROI はすべて統計の文字を出さない印が付いている");
    const plainUid = await viewer.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = (window as any).__graphyDebug;
      return d?.addPlainRoiForTest ? (d.addPlainRoiForTest() as string | null) : null;
    });
    if (plainUid === null) {
      console.log("  未達: 対照（印の無い ROI）を置けなかった。「消しすぎていない」ことは未確認");
    } else {
      await viewer.waitForTimeout(1_000);
      const plain = (await textBoxRows(viewer)).find((r) => r.uid === plainUid);
      check(plain?.statsOffMark === false && plain?.textBoxVisibility === true, "対照: 印の無い ROI（利用者の ROI と同じ扱い）は textBoxVisibility が true のまま（消しすぎていない）", plain);
    }
    if (plainUid !== null) {
      // 対照 ROI の脇に統計の文字が実際に描かれているかを、画面で見る（数値だけでは描画の不具合を見逃す）。文字の枠の位置も数値で残す
      const box = (await viewer.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (window as any).__graphyDebug;
        return d?.getAnnotationCanvasPoints ? d.getAnnotationCanvasPoints() : [];
      })) as { uid: string; points: number[][]; textBox: number[][] | null }[];
      const pb = box.find((b) => b.uid === plainUid);
      const root = await viewer.locator('[data-testid="series-viewer-root"]').first().boundingBox();
      console.log("  対照 ROI の canvas 座標:", JSON.stringify({ points: pb?.points?.slice(0, 2), textBox: pb?.textBox, viewerRoot: root }));
      check(!!pb?.textBox, "対照: 印の無い ROI には統計の文字の枠（textBox）が作られている", pb?.textBox);
      // プラグインの窓が対照 ROI を隠すので、撮る間だけ窓を見えなくする（撮ったら戻す。窓は閉じない＝ROI は消えない）
      const setDialog = (hidden: boolean): Promise<boolean> => viewer.evaluate((h: boolean) => {
        let el = document.querySelector('[data-testid="dp-run"]') as HTMLElement | null;
        while (el && !["fixed", "absolute"].includes(getComputedStyle(el).position)) el = el.parentElement;
        if (!el) return false;
        el.style.visibility = h ? "hidden" : "";
        return true;
      }, hidden);
      const hid = await setDialog(true);
      await viewer.waitForTimeout(500);
      await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-control-roi.png") });
      console.log(`  対照 ROI の撮影: プラグインの窓を一時的に隠した=${hid}`);
      if (pb?.points?.length && root) {
        const xs = pb.points.map((q) => q[0]).concat((pb.textBox ?? []).map((q) => q[0]));
        const ys = pb.points.map((q) => q[1]).concat((pb.textBox ?? []).map((q) => q[1]));
        const x0 = Math.max(0, root.x + Math.min(...xs) - 60), y0 = Math.max(0, root.y + Math.min(...ys) - 60);
        await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-control-roi-zoom.png"), clip: { x: x0, y: y0, width: Math.min(500, Math.max(...xs) - Math.min(...xs) + 120 + 160), height: Math.min(400, Math.max(...ys) - Math.min(...ys) + 120 + 100) } });
      }
      await setDialog(false);
    }
    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-result-final.png") });

    console.log("\n[6] 保存");
    await viewer.getByTestId("dp-save-sr").click();
    const dlg = viewer.getByRole("button", { name: "Save", exact: true });
    await dlg.waitFor({ state: "visible", timeout: 15_000 });
    const dlgText = (await viewer.locator("body").innerText()).replace(/\s+/g, " ");
    const classes = new Set<string>((res.dx ?? []).map((d: { cls: string }) => d.cls)).size;
    const wantFindings = 3 + classes; // 検出した歯・検出されなかった歯・注意 + （dx なし: 診断の候補の注記 1 件 / dx あり: 見つかったクラスごとに 1 件）
    const findingsExpected = wantDx ? wantFindings : 4;
    check(/Measurement groups \(lesions\) 0/.test(dlgText) && new RegExp(`Finding texts ${findingsExpected}\\b`).test(dlgText), `SR の確認ダイアログ: 計測グループ 0・所見 ${findingsExpected}（偽の計測を入れていない）`, dlgText.match(/Finding texts \d+/)?.[0]);
    await dlg.click();
    await viewer.waitForFunction(() => (window as unknown as { __dentalPanoState?: { sr?: unknown } }).__dentalPanoState?.sr !== undefined, null, { timeout: 30_000 });
    const sr = (await state(viewer)).sr;
    check(sr?.ok === true, "SR が保存された", sr);
    await viewer.waitForTimeout(1_500);
    const after2 = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as { modality: string; seriesDescription?: string }[];
    const srSeries = after2.find((x) => x.modality === "SR");
    check(!!srSeries && /\[Plugin\] Dental panoramic AI draft/.test(srSeries.seriesDescription ?? ""), "保管庫に SR のシリーズが入っている（説明に [Plugin] 接頭辞）", after2.map((x) => `${x.modality}:${x.seriesDescription}`));
    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-sr-saved.png") });

    const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const reqs = events.filter((e: { event: string }) => e.event === "egress-requested");
    const want = MODE === "missing-deps" ? 3 : 2; // 事前チェック・（再確認の事前チェック）・本処理
    check(reqs.length === want && reqs.every((e: { endpointKind: string }) => e.endpointKind === "local"), `監査: 送信の要求は ${want} 件（事前チェックと本処理）で、すべて endpointKind=local`, reqs);

    console.log("\n[7] 保存して、ビューアを開き直した後の復元（プラグインの窓は閉じない）");
    {
      const patientKey = (study as unknown as { patientId?: string; patientName?: string }).patientId || (study as unknown as { patientName?: string }).patientName || study.studyInstanceUid;
      const marked = mine.map((r) => r.uid);
      const expectUids = plainUid === null ? marked : [...marked, plainUid];
      type SavedRow = { roiUid: string; custom?: Record<string, string> };
      const readSaved = async (): Promise<SavedRow[]> => {
        const res = await fetch(`${base}/api/rois?patientKey=${encodeURIComponent(patientKey)}`);
        if (res.status !== 200) return [];
        const dto = (await res.json()) as { json: string | null };
        return dto.json ? ((JSON.parse(dto.json) as { rois?: SavedRow[] }).rois ?? []) : [];
      };
      let saved: SavedRow[] = [];
      for (let i = 0; i < 40; i++) {
        saved = await readSaved();
        if (expectUids.every((u) => saved.some((r) => r.roiUid === u))) break;
        await viewer.waitForTimeout(500);
      }
      const savedMarked = saved.filter((r) => marked.includes(r.roiUid) && r.custom?.["graphy.statsOff"] === "1");
      check(expectUids.every((u) => saved.some((r) => r.roiUid === u)), "保存先（backend）に、プラグインが置いた ROI（と対照）が全部入っている（待ってから読んだ）", { 保存件数: saved.length, 期待: expectUids.length });
      check(marked.length > 0 && savedMarked.length === marked.length, "保存された内容に、統計の文字を出さない印（graphy.statsOff）が全部残っている", { 印あり: savedMarked.length, 期待: marked.length });
      check(!(await viewer.getByTestId("dp-run").isHidden()), "（前提）開き直す前は、プラグインの窓が開いたまま");

      type CP = { uid: string; polyline: number[][]; points: number[][] };
      const canvasPts = (): Promise<CP[]> => viewer.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (window as any).__graphyDebug;
        return d?.getAnnotationCanvasPoints ? d.getAnnotationCanvasPoints() : [];
      });
      {
        const rawDoc = (await (await fetch(`${base}/api/rois?patientKey=${encodeURIComponent(patientKey)}`)).json()) as { json: string };
        const first = (JSON.parse(rawDoc.json) as { rois: { roiUid: string; tool: string; points: number[][]; worldSpacing?: number[] }[] }).rois[0];
        console.log("  保存内容の例:", JSON.stringify({ tool: first.tool, p0: first.points[0], worldSpacing: first.worldSpacing }));
      }
      const ptsBefore = new Map((await canvasPts()).filter((c) => expectUids.includes(c.uid)).map((c) => [c.uid, c.points[0]]));
      await viewer.reload({ waitUntil: "domcontentloaded" });
      await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
      let restored: TextBoxRow[] = [];
      for (let i = 0; i < 60; i++) {
        await viewer.waitForTimeout(500);
        restored = (await textBoxRows(viewer)).filter((r) => expectUids.includes(r.uid));
        if (restored.length >= expectUids.length) break;
      }
      await viewer.waitForTimeout(2_000);
      restored = (await textBoxRows(viewer)).filter((r) => expectUids.includes(r.uid));
      const rMarked = restored.filter((r) => marked.includes(r.uid));
      await viewer.waitForTimeout(3_000);
      console.log("  復元後の画素間隔の照合:", JSON.stringify(await viewer.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (window as any).__graphyDebug;
        return d?.getSpacingProbe ? d.getSpacingProbe() : "no-api";
      })).slice(0, 900));
      await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-restored.png") });
      // 切り分け用: 描画が走っていないだけか。ビューア上でマウスを動かして撮り直す（判定には使わない）
      await viewer.mouse.move(900, 600);
      await viewer.mouse.move(950, 640);
      await viewer.waitForTimeout(1_000);
      await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-restored-after-move.png") });
      {
        const cp = (await viewer.evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const d = (window as any).__graphyDebug;
          return d?.getAnnotationCanvasPoints ? d.getAnnotationCanvasPoints() : [];
        })) as { uid: string; polyline: number[][]; points: number[][] }[];
        const mk = cp.filter((c) => marked.includes(c.uid));
        console.log("  復元後の例（canvas 座標）:", JSON.stringify(mk.slice(0, 2).map((c) => ({ uid: c.uid.slice(0, 8), p: c.points.slice(0, 2), poly: c.polyline.length }))));
      }
      console.log(`  復元された ROI: 印つき ${rMarked.length} / ${marked.length}, 全注釈 ${(await textBoxRows(viewer)).length}`);
      {
        const after = new Map((await canvasPts()).filter((c) => expectUids.includes(c.uid)).map((c) => [c.uid, c.points[0]]));
        const moved = [...ptsBefore].filter(([u, p0]) => { const q = after.get(u); return !q || Math.hypot(q[0] - p0[0], q[1] - p0[1]) > 3; });
        check(ptsBefore.size > 0 && moved.length === 0, "復元された ROI の位置（画面の座標）が、開き直す前と同じ（3 px 以内）", { 件数: ptsBefore.size, ずれた: moved.length, 例: moved.slice(0, 2).map(([u, p0]) => ({ 前: p0.map(Math.round), 後: after.get(u)?.map(Math.round) })) });
      }
      check(rMarked.length > 0, "復元された（印つきの）ROI が 0 件でない（検査が空振りしていない）", { 復元: rMarked.length });
      check(rMarked.length === marked.length, "置いた ROI が全部復元された", { 復元: rMarked.length, 期待: marked.length });
      const shown = rMarked.filter((r) => r.textBoxVisibility !== false);
      check(rMarked.length > 0 && shown.length === 0, "復元後も、印のある ROI はすべて textBoxVisibility が false（統計の文字を出さない）", { 件数: rMarked.length, 出る設定: shown.length, 例: shown.slice(0, 2) });
      check(rMarked.length > 0 && rMarked.every((r) => r.statsOffMark), "復元後も、印のある ROI はすべて印が付いている", rMarked.filter((r) => !r.statsOffMark).length);
      if (plainUid !== null) {
        const p = restored.find((r) => r.uid === plainUid);
        if (!p) console.log("  未達: 対照（印の無い ROI）は復元されなかった。復元後に『消しすぎていない』ことは未確認");
        else check(p.statsOffMark === false && p.textBoxVisibility === true, "復元後の対照: 印の無い ROI は textBoxVisibility が true のまま", p);
      }
    }
  } catch (e) {
    for (const [i, pg] of driver.app.windows().entries()) await pg.screenshot({ path: path.join(OUT_DIR, `fail-window-${i}.png`) }).catch(() => undefined);
    throw e;
  } finally {
    await driver.stop();
    fs.rmSync(emptyHome, { recursive: true, force: true }); // 一時の HOME（重みは symlink なので実体は消えない）
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

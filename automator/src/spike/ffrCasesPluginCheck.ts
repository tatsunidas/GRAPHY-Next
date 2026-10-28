/*
 * 新手順（プラグイン angio-quant の 2 方向窓）での 3D 再構成の実機検査 — FFR 2 症例検証「試行 C」の土台。
 *
 * 実行（専用ポート・前景）:
 *   cd automator
 *   GRAPHY_AUTOMATOR_HTTP_PORT=18390 GRAPHY_AUTOMATOR_SCP_PORT=18391 GRAPHY_AUTOMATOR_VITE_PORT=18393 \
 *     FFR_MODE=control-pos npx tsx src/spike/ffrCasesPluginCheck.ts
 *
 * FFR_MODE:
 *   control-pos  仮想血管 Case1（真値あり）。検算用アンカーを正しい対応で置く（陽性対照）。
 *   control-neg  同じ入力で、検算用アンカーの B 側だけ血管に沿って FFR_SHIFT_SAMPLES サンプルずらす（陰性対照:
 *                別の解剖点を指す取り違え）。
 *   spec         FFR_SPEC が指す JSON（ローカル・非コミット）を再生する。実症例用。
 *
 * <h3>これは何を確かめ、何を確かめないか</h3>
 * - 確かめる: 窓の操作（シリーズ選択・フレーム・始点終点・アンカーの移動と確認・検算用アンカー・再構成）が
 *   JSON の再生で通ること、出力（再投影誤差・検算誤差・径の食い違い・モデル登録）を読めること。
 * - 確かめない: QFR の精度。ガイド線を使わない点の入力なので、再投影ゲートの通過が循環にならない対照として使える。
 *
 * 🚨 アンカーは中心線へ吸着する（窓の仕様）。要求した位置と実際に収まった位置の差を必ず記録する。
 * 🚨 実症例の座標・患者識別子はこのファイルに書かない（FFR_SPEC はローカルの JSON）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

type Pt = [number, number];
interface Spec {
  label: string;
  files: { A: string; B: string };
  /** 0 始まりのフレーム番号。 */
  frames: { A: number; B: number };
  ends: { A: { start: Pt; end: Pt }; B: { start: Pt; end: Pt } };
  /** 補正・再構成に使うアンカー（血管に沿った順・近位から。3 点以上）。 */
  anchors: { a: Pt; b: Pt }[];
  /** 検算用アンカー（使うものより遠位であること。補正・再構成に使わない）。 */
  heldOut?: { a: Pt; b: Pt };
  proximal: "start" | "end" | "";
  /** 平均大動脈圧 [mmHg]。無ければ QFR は計算しない（負例の確認に使う）。control の値は配管の確認用で、意味を持たない。 */
  pa?: number;
}

const QUANT_REPO = path.resolve(AUTOMATOR_ROOT, "..", "..", "graphy-next-plugin-angio-quant");
const VV_DIR = process.env.FFR_VV_DIR ?? path.join(os.homedir(), "graphy_sample_images", "virtual-vessel");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "ffr-plugin");
const MODE = process.env.FFR_MODE ?? "control-pos";
const SHIFT = Number(process.env.FFR_SHIFT_SAMPLES ?? "130");
const IMG = 512;

const log = (...a: unknown[]) => console.log(...a);
const results: { name: string; ok: boolean | null; detail?: unknown }[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  results.push({ name, ok, detail });
  log(ok ? "PASS" : "FAIL", name, detail !== undefined ? JSON.stringify(detail) : "");
}
const txt = async (p: Page, id: string) => ((await p.getByTestId(id).first().innerText().catch(() => "")) as string).replace(/\s+/g, " ");

/** 仮想血管 Case1 の真値から入力を作る。同じ添字は両方向で同じ 3D 点。 */
function controlSpec(shiftSamples: number): Spec {
  const truth = JSON.parse(fs.readFileSync(path.join(VV_DIR, "truth.json"), "utf8"));
  const A: Pt[] = truth.views.Case1_A.centerlinePx;
  const B: Pt[] = truth.views.Case1_B.centerlinePx;
  const at = (v: Pt[], i: number): Pt => [v[i][0], v[i][1]];
  const [s0, e0] = [60, 1140];
  const used = [300, 560, 800];
  const held = 1000;
  return {
    label: shiftSamples === 0 ? "control-pos" : `control-neg-shift${shiftSamples}`,
    files: { A: path.join(VV_DIR, "Case1_A.dcm"), B: path.join(VV_DIR, "Case1_B.dcm") },
    frames: { A: 37, B: 36 },
    ends: { A: { start: at(A, s0), end: at(A, e0) }, B: { start: at(B, s0), end: at(B, e0) } },
    anchors: used.map((i) => ({ a: at(A, i), b: at(B, i) })),
    heldOut: { a: at(A, held), b: at(B, Math.min(1199, held + shiftSamples)) },
    proximal: "start",
    pa: 100,
  };
}

function installPlugin(): void {
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", "angio-quant");
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(QUANT_REPO, n), path.join(dst, n));
  const v = JSON.parse(fs.readFileSync(path.join(QUANT_REPO, "plugin.json"), "utf8")).version as string;
  log(`プラグイン配置: 版 ${v}・ui.js ${(fs.statSync(path.join(QUANT_REPO, "ui.js")).size / 1024).toFixed(1)} KB`);
}

async function toClient(page: Page, key: string, p: Pt): Promise<{ x: number; y: number }> {
  const b = await page.getByTestId(`dual-canvas-${key}`).boundingBox();
  if (!b) throw new Error("canvas なし");
  return { x: b.x + (p[0] / IMG) * b.width, y: b.y + (p[1] / IMG) * b.height };
}

async function anchorsOf(page: Page, key: string): Promise<[number, number, boolean][]> {
  return JSON.parse((await page.getByTestId(`dual-canvas-${key}`).getAttribute("data-anchors")) ?? "[]");
}

/** アンカー i を掴んで target へドラッグする。 */
async function dragAnchor(page: Page, key: string, i: number, target: Pt): Promise<void> {
  const cur = (await anchorsOf(page, key))[i];
  if (!cur) throw new Error(`アンカー ${i} が ${key} に無い`);
  const from = await toClient(page, key, [cur[0], cur[1]]);
  const to = await toClient(page, key, target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

async function setFrame(page: Page, key: string, frame: number): Promise<void> {
  await page.evaluate(
    `(() => { const el = document.querySelector('[data-testid="dual-frame-${key}"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '${frame}'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await page.waitForTimeout(1_500);
}

async function listSeries(base: string): Promise<{ study: string; series: string; modality: string }[]> {
  const out: { study: string; series: string; modality: string }[] = [];
  for (const st of (await (await fetch(`${base}/studies`)).json()) as { studyInstanceUid: string }[]) {
    for (const se of (await (await fetch(`${base}/studies/${st.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; modality: string }[]) {
      out.push({ study: st.studyInstanceUid, series: se.seriesInstanceUid, modality: se.modality });
    }
  }
  return out;
}

const num = (s: string, re: RegExp): number | null => {
  const m = re.exec(s);
  return m ? Number(m[1]) : null;
};

/** 2 方向窓の次に QFR 窓を開き、入力 → 計算 → 結果を読む。計算できない場合は理由（ボタンの無効・文言）を返す。 */
async function runQfr(viewer: Page, spec: Spec, outDir: string): Promise<Record<string, unknown>> {
  const q: Record<string, unknown> = {};
  // 2 方向窓が QFR ボタンを覆うので閉じる。登録した血管モデルはセッション中は残る（QFR 窓の説明）。
  const dualWin = viewer.getByRole("dialog", { name: /アンギオ 3D/ });
  await dualWin.getByRole("button", { name: "×" }).click();
  await viewer.waitForTimeout(400);
  const guard = viewer.getByTestId("plugin-window-close-guard-close");
  if (await guard.isVisible().catch(() => false)) await guard.click();
  await viewer.waitForTimeout(500);
  await viewer.getByTestId("angio-quant-qfr").click({ timeout: 8_000 }).catch(async (e) => {
    log("QFR ボタンを押せない:", String(e).slice(0, 160));
    await viewer.screenshot({ path: path.join(outDir, `${spec.label}-3-qfr-open-fail.png`) });
    throw e;
  });
  await viewer.getByTestId("qfr-panel").waitFor({ state: "visible", timeout: 10_000 });
  await viewer.waitForTimeout(800);
  q.modelOptions = await viewer.getByTestId("qfr-model").locator("option").count();
  q.directionRowVisible = await viewer.getByTestId("qfr-direction").isVisible().catch(() => false);
  const run = viewer.getByTestId("qfr-run");
  q.runEnabledWithoutPa = await run.isEnabled();
  check("[Q1] ★Pa 未入力では「QFR を計算する」が無効（計算しない）", !q.runEnabledWithoutPa, { enabled: q.runEnabledWithoutPa });
  if (spec.pa !== undefined) {
    // 流速モデルは固定流速（fQFR）に明示する。cQFR は造影フレームカウント（別窓での ROI 操作）が要り、この検査では未達として扱う。
    await viewer.getByTestId("qfr-velocity").selectOption("fixed");
    q.velocityModel = await viewer.getByTestId("qfr-velocity").inputValue();
    await viewer.getByTestId("qfr-pa").fill(String(spec.pa));
    await viewer.waitForTimeout(300);
    q.directionRowVisible = await viewer.getByTestId("qfr-direction").isVisible().catch(() => false);
    q.runEnabledWithPa = await run.isEnabled();
    q.directionConfirmed = spec.proximal !== "" ;
    if (spec.proximal === "") {
      check("[Q2] ★近位端が未確認なら、Pa を入れても計算できない（向きの確認が要る）", !q.runEnabledWithPa, { enabled: q.runEnabledWithPa, directionRowVisible: q.directionRowVisible });
    } else {
      check("[Q2] 近位端を選んであれば、Pa を入れると計算できる", !!q.runEnabledWithPa, { enabled: q.runEnabledWithPa });
    }
    if (q.runEnabledWithPa) {
      await run.click();
      await viewer.waitForTimeout(4_000);
      const txt2 = async (id: string) => (await viewer.getByTestId(id).first().innerText({ timeout: 2_000 }).catch(() => "")).replace(/\s+/g, " ");
      q.value = await txt2("qfr-value");
      q.primary = await txt2("qfr-primary");
      q.cross = await txt2("qfr-cross");
      q.diff = await txt2("qfr-diff");
      q.caveats = (await txt2("qfr-caveats")).slice(0, 600);
      log("QFR:", q.value, "| 主:", q.primary, "| 検算:", q.cross, "| 差:", q.diff);
      check("[Q3] QFR の値が出た（数値）", /\d\.\d{2,}/.test(String(q.value)), { value: q.value });
      await viewer.screenshot({ path: path.join(outDir, `${spec.label}-3-qfr.png`) });
    }
  }
  return q;
}

async function main(): Promise<void> {
  const spec: Spec =
    MODE === "control-pos" ? controlSpec(0)
    : MODE === "control-neg" ? controlSpec(SHIFT)
    : (JSON.parse(fs.readFileSync(process.env.FFR_SPEC ?? "", "utf8")) as Spec);
  if (spec.anchors.length < 3) throw new Error("アンカーは 3 点以上");
  // 負例用の上書き: FFR_PROXIMAL=none|start|end（none = 近位端を未確認のまま）。
  const pxEnv = process.env.FFR_PROXIMAL;
  if (pxEnv !== undefined) {
    if (!["none", "start", "end"].includes(pxEnv)) throw new Error("FFR_PROXIMAL は none|start|end");
    spec.proximal = pxEnv === "none" ? "" : (pxEnv as "start" | "end");
    spec.label += `-prox-${pxEnv}`;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();
  const driver = new DesktopDriver();
  await driver.start();
  const report: Record<string, unknown> = { label: spec.label, mode: MODE };
  try {
    const page = driver.page;
    page.on("pageerror", (e) => log("PAGEERROR:", String(e.stack ?? e).slice(0, 300)));
    page.on("dialog", (d) => void d.accept().catch(() => {}));
    const base = `http://127.0.0.1:${driver.ports.http}/api`;
    await resetDb(driver.ports.http);
    const imp: Record<"A" | "B", { study: string; series: string }> = {} as never;
    for (const k of ["A", "B"] as const) {
      const before = new Set((await listSeries(base)).map((s) => s.series));
      const r = await importPaths(driver.ports.http, [spec.files[k]]);
      const added = (await listSeries(base)).filter((s) => !before.has(s.series) && s.modality === "XA");
      check(`[準備] 方向 ${k} を取り込めた（XA シリーズが 1 本増えた）`, r.imported >= 1 && added.length === 1, { imported: r.imported, added: added.length });
      imp[k] = added[0];
    }
    await waitForMainScreenReady(page, 60_000);
    await dismissStartupDialogs(page);
    await page.getByRole("button", { name: /^(All|全期間)$/ }).click();
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${imp.A.study}"]`).click();
    const row = page.locator(`[data-testid="series-row-${imp.A.series}"]`);
    await row.waitFor({ state: "visible", timeout: 20_000 });
    await row.click();
    await page.waitForTimeout(500);
    const viewer: Page = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);

    await viewer.getByTestId("viewer2d-menu-plugins").click();
    await viewer.waitForTimeout(300);
    await viewer.getByTestId("plugin-item-angio-quant").click();
    await viewer.waitForTimeout(1_500);
    await viewer.getByTestId("angio-quant-dual").click();
    await viewer.getByTestId("dual-panel").waitFor({ state: "visible", timeout: 10_000 });
    await viewer.getByTestId("dual-pick").click();
    await viewer.getByTestId("pickseries-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await viewer.waitForTimeout(1_000);
    for (const st of new Set([imp.A.study, imp.B.study])) {
      const exp = viewer.getByTestId(`pickseries-expand-${st}`);
      if ((await exp.count()) && (await exp.getAttribute("aria-expanded")) !== "true") await exp.click();
    }
    await viewer.waitForTimeout(800);
    // 選択順がそのまま A → B になる。
    await viewer.getByTestId(`pickseries-series-check-${imp.A.series}`).check();
    await viewer.getByTestId(`pickseries-series-check-${imp.B.series}`).check();
    await viewer.getByTestId("pickseries-ok").click();
    await viewer.waitForTimeout(4_000);
    const stA0 = await txt(viewer, "dual-status-A");
    const stB0 = await txt(viewer, "dual-status-B");
    check("[1] 2 方向が読み込まれた", /フレーム/.test(stA0) && /フレーム/.test(stB0), { stA0: stA0.slice(0, 80), stB0: stB0.slice(0, 80) });

    await setFrame(viewer, "A", spec.frames.A);
    await setFrame(viewer, "B", spec.frames.B);
    // 中心線: 始点・終点をクリック
    for (const k of ["A", "B"] as const) {
      for (const p of [spec.ends[k].start, spec.ends[k].end]) {
        const c = await toClient(viewer, k, p);
        await viewer.mouse.click(c.x, c.y);
        await viewer.waitForTimeout(400);
      }
      await viewer.waitForTimeout(1_500);
    }
    const sA = await txt(viewer, "dual-status-A");
    const sB = await txt(viewer, "dual-status-B");
    check("[2] 両方向で中心線が引けた", /中心線を引きました/.test(sA) && /中心線を引きました/.test(sB), { sA: sA.slice(0, 120), sB: sB.slice(0, 120) });
    await viewer.screenshot({ path: path.join(OUT_DIR, `${spec.label}-1-centerlines.png`) });

    // アンカーを 3 → 必要数へ（使う + 検算用）。
    const want = spec.anchors.length + (spec.heldOut ? 1 : 0);
    for (let n = (await anchorsOf(viewer, "A")).length; n < want; n++) {
      await viewer.getByTestId("dual-add-anchor").click();
      await viewer.waitForTimeout(300);
    }
    const nA = (await anchorsOf(viewer, "A")).length;
    const nB = (await anchorsOf(viewer, "B")).length;
    check(`[3] アンカーが ${want} 点になった（A・B で同数）`, nA === want && nB === want, { nA, nB });

    // 目標位置へ動かして確認。隣を追い越せないので、数回まわして収束させる。
    const targets: { a: Pt; b: Pt }[] = [...spec.anchors, ...(spec.heldOut ? [spec.heldOut] : [])];
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < targets.length; i++) {
        await dragAnchor(viewer, "A", i, targets[i].a);
        await dragAnchor(viewer, "B", i, targets[i].b);
      }
    }
    for (let i = 0; i < targets.length; i++) {
      await dragAnchor(viewer, "A", i, targets[i].a);
      await dragAnchor(viewer, "B", i, targets[i].b);
      await viewer.getByTestId("dual-confirm").click();
      await viewer.waitForTimeout(250);
    }
    const gotA = await anchorsOf(viewer, "A");
    const gotB = await anchorsOf(viewer, "B");
    const off = (got: [number, number, boolean][], key: "a" | "b") => got.map((g, i) => Math.hypot(g[0] - targets[i][key][0], g[1] - targets[i][key][1]));
    const offA = off(gotA, "a");
    const offB = off(gotB, "b");
    report.anchorOffsetPx = { A: offA.map((v) => +v.toFixed(2)), B: offB.map((v) => +v.toFixed(2)) };
    log("要求位置と実際の位置の差(px) A:", JSON.stringify(report.anchorOffsetPx));
    check("[4] アンカーがすべて確認済み", gotA.every((g) => g[2]) && gotB.every((g) => g[2]), { A: gotA.map((g) => g[2]), B: gotB.map((g) => g[2]) });

    if (spec.heldOut) await viewer.getByTestId("dual-holdout").check();
    if (spec.proximal) await viewer.getByTestId("dual-proximal").selectOption(spec.proximal);
    await viewer.waitForTimeout(300);
    const reconBtn = viewer.getByTestId("dual-recon");
    check("[5] 再構成ボタンが有効", await reconBtn.isEnabled(), { title: await reconBtn.getAttribute("title") });
    await reconBtn.click();
    await viewer.waitForTimeout(2_500);
    const rec = await txt(viewer, "dual-result");
    const held = await txt(viewer, "dual-holdout-result");
    const agree = await txt(viewer, "dual-diam-agree");
    const reg = await txt(viewer, "dual-registered");
    await viewer.screenshot({ path: path.join(OUT_DIR, `${spec.label}-2-recon.png`) });
    report.result = rec;
    report.reprojectionPx = num(rec, /アンカーの再投影誤差 ([\d.]+) px/);
    report.heldOutPx = num(held, /再投影誤差 ([\d.]+) px/);
    report.diameterAgreement = agree;
    report.registered = reg;
    report.lengthMm = num(rec, /3D 中心線の長さ ([\d.]+) mm/);
    log("再構成:", rec.slice(0, 500));
    log("検算用アンカー:", held);
    log("径の食い違い:", agree);
    log("モデル登録:", reg);
    check("[6] 再構成が結果を出した（ブロック警告なし）", !!rec && !/結果を出しません|再構成できませんでした/.test(rec), rec.slice(0, 160));
    if (spec.heldOut) check("[7] 検算用アンカーの誤差が表示された（数値）", report.heldOutPx !== null, held.slice(0, 160));
    check("[8] 径の食い違いが表示された、または出せない理由が分かる", /2 方向の径の差|断面積・狭窄率は出せません/.test(rec + " " + agree), agree.slice(0, 120));

    /* ── QFR 窓 ── */
    if (process.env.FFR_QFR !== "0") {
      const q = await runQfr(viewer, spec, OUT_DIR);
      report.qfr = q;
    }

    fs.writeFileSync(path.join(OUT_DIR, `${spec.label}.json`), JSON.stringify({ ...report, checks: results }, null, 1));
  } finally {
    await driver.stop();
    const fails = results.filter((r) => r.ok === false);
    log(`\n合格 ${results.filter((r) => r.ok).length} / 失敗 ${fails.length}`);
    if (fails.length) process.exitCode = 1;
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

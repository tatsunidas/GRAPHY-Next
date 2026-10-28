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
 * FFR_COLOR3D=l2|l3  QFR のあと、3D 画面への色表示を確かめる（仮想血管専用。`colorCheck3d` の注記を参照）。
 * FFR_DUMP2D=1   再構成の後、両方向の 2D の中心線・経路番号・径を .results/ffr-plugin/<label>-2d.json へ書く（試行 E2。ローカルのみ）。
 * FFR_MANUAL=1   試行 G。［3D に再構成］の手前で止まり、利用者がエッジを手で直して再構成するのを待つ（<label>-manual。完了の合図は .results/ffr-plugin/manual-done、
 *                最大 FFR_MANUAL_TIMEOUT_S 秒 = 既定 2700）。FFR_MANUAL_AUTO=1 は編集なしでスクリプトが再構成する（ハーネスの確認）。
 * FFR_GUIDE=1    補正に使うアンカーを、B を基準に［ガイドに合わせる］で A へ寄せて決める（点の選定用。検算用は寄せない）。
 *                寄せた後の位置は report.finalAnchors に出る（それを ffr-cases-segments-C.json に写して固定する）。
 *                ガイドで選んだ対応点は再投影ゲートが循環になるので、通過は「整合性ゲート通過」としか言えない。
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
/** 1: 補正に使うアンカーを、B を基準に［ガイドに合わせる］で A へ寄せて決める（検算用は寄せない）。 */
const GUIDE = process.env.FFR_GUIDE === "1";

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

/** 試行 G: 画面の属性から 2 方向の 2D の状態（中心線・径・エッジ・手修正の印）を読む。座標を含むので .results/ のみ。 */
async function read2d(page: Page): Promise<Record<"A" | "B", Record<string, unknown>>> {
  const out = {} as Record<"A" | "B", Record<string, unknown>>;
  for (const k of ["A", "B"] as const) {
    const cv = page.getByTestId(`dual-canvas-${k}`);
    const attr = async (n: string) => JSON.parse((await cv.getAttribute(`data-${n}`)) ?? "null");
    out[k] = {
      clpts: await attr("clpts"), range: await attr("range"), diameters: await attr("diameters"),
      edgepts: await attr("edgepts"), edgeoffsets: await attr("edgeoffsets"), editedEdges: await attr("edited-edges"), edited: await attr("edited"),
    };
  }
  return out;
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


interface Geo3dStats { total: number; nonBackground: number; fraction: number; warm: number; cool: number; neutral: number }
const GEO_CTX_KEY = "graphy-geometry3d-ctx";

async function geo3dStats(page: Page): Promise<Geo3dStats | null> {
  const raw = (await page.evaluate(`(() => {
    const g = window.__graphyDebug;
    const s = g && g.getGeometry3dStats ? g.getGeometry3dStats() : null;
    return s ? JSON.stringify(s) : null;
  })()`)) as string | null;
  return raw ? (JSON.parse(raw) as Geo3dStats) : null;
}

/**
 * QFR 窓の「3D に色マップとして送る」→ 本体の 3D 画面（geometry3d）に色が乗るか。仮想血管専用（実症例では使わない）。
 *   FFR_COLOR3D=l2  入口の確認（注入なし）: 送信ボタンだけで 3D 画面が開き、色・凡例が出るか。送る前は開いていないこと（負例）も見る。
 *   FFR_COLOR3D=l3  検査だけの注入（localStorage の 3D コンテキスト）で 3D 画面を開き、色・凡例を見る。
 *                   「表示側は動く」ことの確認で、「利用者が行ける」ことの確認ではない。
 */
async function colorCheck3d(driver: DesktopDriver, viewer: Page, mode: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { mode };
  const modelRaw = (await viewer.evaluate(`(() => {
    const g = window.__graphyDebug; const m = g && g.getVesselModel ? g.getVesselModel() : null;
    return m ? JSON.stringify({ runId: m.runId, pts: (m.segments && m.segments[0] ? m.segments[0].points : []) }) : null;
  })()`)) as string | null;
  const model = modelRaw ? (JSON.parse(modelRaw) as { runId: string; pts: number[][] }) : null;
  check("[C0] 本体のストアに登録済みの血管モデルがある（H73）", !!model && model.pts.length > 10, { runId: model?.runId?.slice(0, 40), points: model?.pts.length });
  if (!model) return out;
  out.points = model.pts.length;
  out.modelEnds = [model.pts[0], model.pts[model.pts.length - 1]]; // 仮想血管の真値（近位・遠位）との照合用
  const put = viewer.getByTestId("qfr-put");
  check("[C1] 「3D に色マップとして送る」ボタンがある（本体が putVesselAnalysis を持つ）", (await put.count()) === 1);
  const panelTail = async () => ((await viewer.getByTestId("qfr-panel").textContent()) ?? "").replace(/\s+/g, " ").trim().slice(-220);
  const urls = () => viewer.context().pages().map((pg) => pg.url().replace(/^.*?#/, "#").slice(0, 40));

  if (mode === "l2") {
    // 入口の確認（注入なし）: 利用者と同じ操作（QFR 窓の送信ボタン）だけで 3D 画面が開き、色と凡例が出るか。
    out.windowsBefore = urls();
    check("[L2-0] 負例: 送る前は 3D 画面（geometry3d）が開いていない", !(out.windowsBefore as string[]).some((u) => u.includes("geometry3d")), out.windowsBefore);
    let geo: Page | null = null;
    try {
      geo = await driver.waitForNewPage(() => put.click(), (u) => u.includes("geometry3d"), 20_000);
    } catch (e) {
      out.openError = String(e).slice(0, 160);
    }
    out.panelTail = await panelTail();
    out.windowsAfter = urls();
    check("[L2-1] 送信後、窓の表示は「3D ビューへ送りました」", /3D ビューへ送りました/.test(String(out.panelTail)), String(out.panelTail).slice(-120));
    check("[L2-2] ★送信だけで 3D 画面（geometry3d）が開く＝利用者の入口がある", !!geo, out.openError ?? out.windowsAfter);
    if (!geo) return out;
    await geo.getByTestId("geometry3d-root").waitFor({ state: "visible", timeout: 30_000 });
    await geo.waitForTimeout(3_500);
    const st = await geo3dStats(geo);
    const lg = geo.getByTestId("vessel-legend");
    out.stats = st; out.legendCount = await lg.count();
    await geo.screenshot({ path: path.join(OUT_DIR, "color3d-l2-open.png") }).catch(() => {});
    check("[L2-3] ★開いた 3D 画面に凡例が 1 つ出る", out.legendCount === 1, { legend: out.legendCount });
    check("[L2-4] ★開いた 3D 画面に勾配が乗る（neutral・cool が立つ。注入なし）", !!st && st.neutral > 0 && st.cool > 0, st);
    out.legendLabel = await lg.getAttribute("data-label").catch(() => null);
    check("[L2-5] 凡例の量の名前が QFR", String(out.legendLabel).includes("QFR"), out.legendLabel);
    // 色の向きの観測（合否に数えない）: 同じ runId で中心線の点列だけ逆順にして渡すと、画面上の色の並びが入れ替わるはず（色は頂点の添字に乗る）。
    await viewer.evaluate(`(() => { const k = ${JSON.stringify(GEO_CTX_KEY)}; const c = JSON.parse(localStorage.getItem(k)); c.centerlineLps = c.centerlineLps.slice().reverse(); c.ts = Date.now();
      localStorage.setItem(k, JSON.stringify(c)); const bc = new BroadcastChannel("graphy-geometry3d"); bc.postMessage({ type: "updated" }); bc.close(); })()`);
    await geo.waitForTimeout(2_500);
    await geo.screenshot({ path: path.join(OUT_DIR, "color3d-l2-reversed.png") }).catch(() => {});
    results.push({ name: "[L2-6 観測] 中心線を逆順にした画面を撮った（color3d-l2-reversed.png。色の並びが入れ替わるかは目視）", ok: null });
    return out;
  }

  const inject = async (runId: string) => {
    const ctx = { kind: "xa-qca3d", name: "QFR 3D 色表示の検査", runId, centerlineLps: model.pts.map((q) => [q[0], q[1], q[2]]), ts: Date.now() };
    await viewer.evaluate(`(() => { localStorage.setItem(${JSON.stringify(GEO_CTX_KEY)}, ${JSON.stringify(JSON.stringify(ctx))});
      const bc = new BroadcastChannel("graphy-geometry3d"); bc.postMessage({ type: "updated" }); bc.close(); })()`);
  };
  await inject(model.runId);
  const geo = await driver.waitForNewPage(
    () => viewer.evaluate(`window.graphyDesktop.openViewer("geometry3d")`).then(() => undefined),
    (u) => u.includes("geometry3d"),
  );
  await geo.getByTestId("geometry3d-root").waitFor({ state: "visible", timeout: 30_000 });
  await geo.waitForTimeout(3_000);
  out.windowsWhenOpen = urls();
  check("[L3-W] 検出器の確認: 3D 画面を開けば、ウィンドウ一覧に geometry3d が出る（L2-2 は空振りでない）", (out.windowsWhenOpen as string[]).some((u) => u.includes("geometry3d")), out.windowsWhenOpen);
  const before = await geo3dStats(geo);
  const legendBefore = await geo.getByTestId("vessel-legend").count();
  await geo.screenshot({ path: path.join(OUT_DIR, "color3d-1-before.png") }).catch(() => {});
  check("[L3-0] 3D 画面が描かれている（血管の画素がある）", !!before && before.nonBackground > 0, before);
  check("[L3-1] ★負例: 送る前は凡例が無く、勾配も無い（neutral 0）", legendBefore === 0 && !!before && before.neutral === 0, { legendBefore, before });

  await put.click();
  await geo.waitForTimeout(3_500);
  out.panelTail = await panelTail();
  const after = await geo3dStats(geo);
  const legend = geo.getByTestId("vessel-legend");
  const legendAfter = await legend.count();
  out.before = before; out.after = after; out.legendAfter = legendAfter;
  await geo.screenshot({ path: path.join(OUT_DIR, "color3d-2-after.png") }).catch(() => {});
  // 予測（実行前に決めたもの）: 仮想血管の QFR は 0.88〜1.00、範囲 0.60〜1.00 なので、近位は青（cool）、狭窄の遠位は緑寄り（neutral）。赤（warm）は出ない。
  check("[L3-2] ★正例: 送ると凡例が出る", legendAfter === 1, { legendAfter });
  check("[L3-3] ★正例: 送ると勾配が乗る（neutral が立ち、cool も残る。単色シアンから変わった）", !!after && after.neutral > 0 && after.cool > 0, { before, after });
  // 観測のみ（合否に数えない）。実行前の予測「赤（warm）は出ない」は外れた（warm=20）。warm は r−b>30 で、赤ではなく黄緑も含む:
  // 遠位端 QFR 0.882 は t=0.705（黄と緑の間、f=0.82）で RGB ≈ (106,199,76)、r−b ≈ 30.5 ＞ 30。画面に赤は無い（color3d-2-after.png）。
  log("[L3-4 観測] warm 画素", after?.warm, "（遠位端 t=0.705 の黄緑が r−b>30 に入る。赤ではない）");
  results.push({ name: "[L3-4 観測] 赤の有無（予測は外れた: warm は黄緑の遠位端を含む。画面に赤は無い）", ok: null, detail: { warm: after?.warm } });
  if (legendAfter === 1) {
    out.legendLabel = await legend.getAttribute("data-label").catch(() => null);
    out.legendRange = [await geo.getByTestId("vessel-legend-min").textContent().catch(() => null), await geo.getByTestId("vessel-legend-max").textContent().catch(() => null)];
    out.legendDisclaimer = ((await geo.getByTestId("vessel-legend-disclaimer").textContent().catch(() => "")) ?? "").trim().slice(0, 80);
    check("[L3-5] 凡例に量の名前（QFR）と範囲 0.6〜1 が出る", String(out.legendLabel).includes("QFR") && Number((out.legendRange as string[])[0]) === 0.6 && Number((out.legendRange as string[])[1]) === 1, { label: out.legendLabel, range: out.legendRange });
  }
  await inject("run-that-does-not-exist");
  await geo.waitForTimeout(2_500);
  const neg = await geo3dStats(geo);
  const legendNeg = await geo.getByTestId("vessel-legend").count();
  out.negRun = { neg, legendNeg };
  await geo.screenshot({ path: path.join(OUT_DIR, "color3d-3-otherrun.png") }).catch(() => {});
  check("[L3-6] ★負例: 別の runId では色も凡例も出ない", legendNeg === 0 && !!neg && neg.neutral === 0, { legendNeg, neg });
  return out;
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
  // 試行 G の手動モード: 試行 C の出力（<label>.json・<label>-2d.json。ベンチが読む）を上書きしないよう、ラベルを分ける。
  if (process.env.FFR_MANUAL === "1") spec.label += "-manual";
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
    const guidedLog: { i: number; roughA: Pt; snappedA: [number, number]; note: string }[] = [];
    for (let i = 0; i < targets.length; i++) {
      if (GUIDE && i < spec.anchors.length) {
        // B を基準に置き、A は概略位置で掴んでから［ガイドに合わせる］で B のガイド線と A 中心線の交点へ寄せる。
        // 検算用アンカー（i >= anchors.length）は独立でなければならないので、寄せずに直接置く。
        await dragAnchor(viewer, "B", i, targets[i].b);
        await viewer.getByTestId("dual-confirm").click();
        await dragAnchor(viewer, "A", i, targets[i].a);
        await viewer.getByTestId("dual-snap").click();
        await viewer.waitForTimeout(300);
        const s = (await anchorsOf(viewer, "A"))[i];
        guidedLog.push({ i, roughA: targets[i].a, snappedA: [s[0], s[1]], note: await txt(viewer, "dual-info") });
      } else {
        await dragAnchor(viewer, "A", i, targets[i].a);
        await dragAnchor(viewer, "B", i, targets[i].b);
      }
      await viewer.getByTestId("dual-confirm").click();
      await viewer.waitForTimeout(250);
    }
    const gotA = await anchorsOf(viewer, "A");
    const gotB = await anchorsOf(viewer, "B");
    if (GUIDE) {
      report.guided = guidedLog;
      report.finalAnchors = { A: gotA.map((g) => [+g[0].toFixed(2), +g[1].toFixed(2)]), B: gotB.map((g) => [+g[0].toFixed(2), +g[1].toFixed(2)]) };
      log("ガイドで寄せた A:", JSON.stringify(guidedLog.map((g) => ({ i: g.i, rough: g.roughA, snapped: g.snappedA.map((v) => +v.toFixed(1)) }))));
    }
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
    const manual = process.env.FFR_MANUAL === "1";
    const manualAuto = process.env.FFR_MANUAL_AUTO === "1";
    if (!manual) {
      await reconBtn.click();
      await viewer.waitForTimeout(2_500);
    } else {
      // 試行 G: ［3D に再構成］の手前で止まり、利用者がエッジを手で直して［3D に再構成］を押すのを待つ（座標を含むので .results/ のみ）。
      fs.writeFileSync(path.join(OUT_DIR, `${spec.label}-before-2d.json`), JSON.stringify(await read2d(viewer)));
      await viewer.screenshot({ path: path.join(OUT_DIR, `${spec.label}-before.png`) });
      const marker = path.join(OUT_DIR, "manual-done");
      fs.rmSync(marker, { force: true });
      const stopHere = (status: string, name: string, detail: unknown) => {
        results.push({ name, ok: null, detail });
        report.manual = { status };
        fs.writeFileSync(path.join(OUT_DIR, `${spec.label}.json`), JSON.stringify({ ...report, checks: results }, null, 1));
        log(`【未達】${name}`);
      };
      if (manualAuto) {
        // ハーネスの確認用: 編集なしで、スクリプト自身が［3D に再構成］を押す（試行 C と同じ値に戻るはず）。
        await reconBtn.click();
        await viewer.waitForTimeout(2_500);
      } else {
        const limitS = Number(process.env.FFR_MANUAL_TIMEOUT_S ?? "2700");
        log(`【手動編集】アプリの窓で、方向 B（必要なら A）のエッジを［操作: エッジを直す］で直し、［3D に再構成］を押してください（経由点は足さない・アンカーは動かさない）。終わったら ${marker} を作ってください（最大 ${limitS} 秒待ちます）。`);
        const deadline = Date.now() + limitS * 1000;
        while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, Math.min(5_000, Math.max(100, deadline - Date.now()))));
        if (!fs.existsSync(marker)) {
          stopHere("timeout", "[G] 完了の合図が時間内に無かった", { limitS });
          return;
        }
        await viewer.waitForTimeout(1_000);
      }
      const t0 = await txt(viewer, "dual-result");
      if (!/3D 再構成の結果/.test(t0)) {
        stopHere("no-recon", "[G] ［3D に再構成］の結果が画面に無い", t0.slice(0, 120));
        return;
      }
      fs.writeFileSync(path.join(OUT_DIR, `${spec.label}-after-2d.json`), JSON.stringify(await read2d(viewer)));
      report.manual = { status: "ok", auto: manualAuto };
    }
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
    if (process.env.FFR_DUMP2D === "1") {
      // 試行 E2: 2D の中心線・経路番号・径を、画面の属性から読んでローカルへ書く（座標を含むので .results/ のみ。コミットしない）。
      const dump: Record<string, unknown> = {};
      for (const k of ["A", "B"] as const) {
        const cv = viewer.getByTestId(`dual-canvas-${k}`);
        const attr = async (n: string) => JSON.parse((await cv.getAttribute(`data-${n}`)) ?? "null");
        dump[k] = { clpts: await attr("clpts"), range: await attr("range"), diameters: await attr("diameters") };
      }
      fs.writeFileSync(path.join(OUT_DIR, `${spec.label}-2d.json`), JSON.stringify(dump));
      const d = dump as Record<"A" | "B", { clpts: unknown[]; range: { n: number; pi: unknown[] }; diameters: unknown[] }>;
      log("2D 点列を書き出し（ローカルのみ）: 中心線の点数 A/B =", d.A.clpts.length, d.B.clpts.length, "／ 径 A/B =", d.A.diameters.length, d.B.diameters.length, "／ 経路番号 A/B =", d.A.range.pi.length, d.B.range.pi.length);
    }
    check("[6] 再構成が結果を出した（ブロック警告なし）", !!rec && !/結果を出しません|再構成できませんでした/.test(rec), rec.slice(0, 160));
    if (spec.heldOut) check("[7] 検算用アンカーの誤差が表示された（数値）", report.heldOutPx !== null, held.slice(0, 160));
    check("[8] 径の食い違いが表示された、または出せない理由が分かる", /2 方向の径の差|断面積・狭窄率は出せません/.test(rec + " " + agree), agree.slice(0, 120));

    /* ── QFR 窓 ── */
    if (process.env.FFR_QFR !== "0") {
      const q = await runQfr(viewer, spec, OUT_DIR);
      report.qfr = q;
      if (process.env.FFR_COLOR3D) report.color3d = await colorCheck3d(driver, viewer, process.env.FFR_COLOR3D);
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

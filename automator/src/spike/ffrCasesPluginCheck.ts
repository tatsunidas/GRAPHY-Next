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

/** 2 方向窓は手順式（①シリーズ ②解析範囲 ③中心線 ④エッジ ⑤アンカー ⑥3D・QFR）。手順のボタンを押して、その手順の道具を出す。 */
const MODE_STEP: Record<string, number> = { range: 2, waypoint: 3, edge: 4, anchor: 5 };
async function setStep(page: Page, n: number): Promise<void> {
  await page.getByTestId(`dual-step-${n}`).click();
  await page.waitForTimeout(200);
}
async function setMode(page: Page, mode: string): Promise<void> {
  await setStep(page, MODE_STEP[mode]);
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
      anchors: await attr("anchors"), waypoints: await attr("waypoints"),
    };
  }
  return out;
}

/**
 * 2 方向窓のエッジ編集の実機確認（FFR_EDITCHECK=1。仮想血管の方向 A）。
 *  - ホバー: 右のエッジの外側にポインターを置くと data-hover が right、左の外側なら left（なぞる／点を動かす の両方）
 *  - なぞる: 右の内側から押して、血管を横切って左の外側へ線を引く。反対側（左）が追従しないこと（変更前のビルドでは左も動く）
 * 値は data-edgeoffsets（[左, 右] の組、0.01 px）と data-hover で読み、スクリーンショットも撮る。
 */
async function editCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const key = "A";
  const cv = page.getByTestId(`dual-canvas-${key}`);
  const attr = async (n: string) => JSON.parse((await cv.getAttribute(`data-${n}`)) ?? "null");
  const edgepts: number[][] = await attr("edgepts");
  const clpts: number[][] = await attr("clpts");
  const k = Math.floor(edgepts.length / 3); // 狭窄から離れた、まっすぐに近い所
  const nrm = (i: number): Pt => {
    const [lx, ly, rx, ry] = edgepts[i];
    const l = Math.hypot(rx - lx, ry - ly);
    return [(rx - lx) / l, (ry - ly) / l]; // 左 → 右（右が正）
  };
  const right = (i: number): Pt => [edgepts[i][2], edgepts[i][3]];
  const left = (i: number): Pt => [edgepts[i][0], edgepts[i][1]];
  const at = (p: Pt, n: Pt, d: number): Pt => [p[0] + n[0] * d, p[1] + n[1] * d];
  const mouseTo = async (p: Pt) => {
    const c = await toClient(page, key, p);
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(150);
  };

  await setMode(page, "edge");
  const snap = page.getByTestId("dual-snap-edge");
  if (await snap.count()) await snap.uncheck();
  // 中心線の寄せ直しは FFR_EDITCHECK=recenter で見る。ここでは、なぞる側の選択だけを見るので切る（寄せ直すと中心線からの距離が変わる）。
  const rc = page.getByTestId("dual-auto-recenter");
  if (await rc.count()) await rc.uncheck();
  const toolSel = page.getByTestId("dual-edge-tool");
  const hover = async () => (await cv.getAttribute("data-hover")) ?? "";

  // ホバー（なぞる・点を動かす）
  const hovers: Record<string, string> = {};
  for (const tool of ["trace", "drag"]) {
    await toolSel.selectOption(tool);
    await mouseTo(at(right(k), nrm(k), 1.5));
    hovers[`${tool}:rightOutside`] = await hover();
    await page.screenshot({ path: path.join(OUT_DIR, `${label}-hover-${tool}-right.png`) });
    await mouseTo(at(left(k), nrm(k), -1.5));
    hovers[`${tool}:leftOutside`] = await hover();
    await mouseTo([5, 5]);
    hovers[`${tool}:far`] = await hover();
  }
  out.hovers = hovers;
  check("[E1] ホバー: 右のエッジの外側では右、左の外側では左が強調される（なぞる・点を動かす とも）", ["trace", "drag"].every((t) => hovers[`${t}:rightOutside`].startsWith("right") && hovers[`${t}:leftOutside`].startsWith("left")), hovers);
  check("[E2] 負例: エッジから遠い位置（点を動かす）では何も強調されない", hovers["drag:far"] === "", hovers["drag:far"]);

  // なぞる: 右の内側 → 血管を横切って左の外側（k+10）
  await toolSel.selectOption("trace");
  const before: number[][] = await attr("edgeoffsets");
  const s = at(clpts[k] as Pt, nrm(k), 2);
  const e = at(left(k + 10), nrm(k + 10), -3);
  const c0 = await toClient(page, key, s);
  const c1 = await toClient(page, key, e);
  await page.mouse.move(c0.x, c0.y);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) await page.mouse.move(c0.x + ((c1.x - c0.x) * i) / 24, c0.y + ((c1.y - c0.y) * i) / 24);
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-trace-during.png`) });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after: number[][] = await attr("edgeoffsets");
  let leftMoved = 0, rightMoved = 0;
  for (let i = 0; i < before.length; i++) {
    if (Math.abs(after[i][0] - before[i][0]) > 0.05) leftMoved++;
    if (Math.abs(after[i][1] - before[i][1]) > 0.05) rightMoved++;
  }
  out.trace = { leftMoved, rightMoved, startNearSide: "right" };
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-trace-after.png`) });
  log("なぞる: 左が動いた点数", leftMoved, "／ 右が動いた点数", rightMoved);
  check("[E3] なぞる: 始点に近い側（右）が置き換わる", rightMoved > 0, { rightMoved });
  check("[E4] ★なぞる: 反対側（左）は追従しない（0 点）", leftMoved === 0, { leftMoved });
  return out;
}

/**
 * 2 方向窓の経由点の確認（FFR_EDITCHECK=wp。仮想血管）。真値（truth.json）で、連動した相手側の点の位置を確かめる。
 *  1. 方向 A の中心線上をクリックして経由点を足す → B にも対応する経由点が足され、真値の対応点に近い（連動 ON）
 *  2. A の経由点を中心線の外へ 12 px ドラッグして離す → A の中心線が変わり、B の経由点も動く
 *  3. ［元に戻す］で A・B が一緒に戻る
 *  4. 負例: 連動を切ると、A に足しても B は変わらない
 *  5. 右クリックで A の経由点を消すと、B の対応する点も消える
 */
async function waypointCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const attrOf = async (key: "A" | "B", n: string) => JSON.parse((await page.getByTestId(`dual-canvas-${key}`).getAttribute(`data-${n}`)) ?? "null");
  const wps = async (key: "A" | "B"): Promise<Pt[]> => (await attrOf(key, "waypoints")) ?? [];
  const clKey = async (key: "A" | "B") => JSON.stringify(await attrOf(key, "clpts"));
  const clickAt = async (key: "A" | "B", p: Pt, button: "left" | "right" = "left") => {
    const c = await toClient(page, key, p);
    await page.mouse.click(c.x, c.y, { button });
    await page.waitForTimeout(500);
  };
  const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const truth = JSON.parse(fs.readFileSync(path.join(VV_DIR, "truth.json"), "utf8")).views as Record<string, { centerlinePx: Pt[] }>;
  const nearestIdx = (pts: Pt[], p: Pt) => pts.reduce((bi, q, i) => (dist(q, p) < dist(pts[bi], p) ? i : bi), 0);

  await setMode(page, "waypoint");
  const sync = page.getByTestId("dual-sync");
  check("[W0] 連動のチェックボックスがあり、既定で ON", (await sync.count()) === 1 && (await sync.isChecked()), null);
  const clA: Pt[] = await attrOf("A", "clpts");
  const k = Math.floor(clA.length / 2);

  // 1. 足す
  await clickAt("A", clA[k]);
  const a1 = await wps("A");
  const b1 = await wps("B");
  out.afterAdd = { a: a1.length, b: b1.length };
  check("[W1] A に経由点を足すと、B にも 1 つ足される（連動）", a1.length === 1 && b1.length === 1, out.afterAdd);
  const ti = nearestIdx(truth.Case1_A.centerlinePx, a1[0] ?? clA[k]);
  const errAdd = b1[0] ? dist(b1[0], truth.Case1_B.centerlinePx[ti]) : NaN;
  out.addPartnerErrPx = Number.isFinite(errAdd) ? +errAdd.toFixed(2) : null;
  check("[W2] B の経由点は、真値の対応点から 10 px 以内（仮想血管・正確なタグ）", errAdd <= 10, out.addPartnerErrPx);
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-wp-added.png`) });

  // 2. 動かす（中心線の外へ 12 px）
  const clBeforeA = await clKey("A");
  const clBeforeB = await clKey("B");
  const wA0 = a1[0];
  const wB0 = b1[0];
  const c0 = await toClient(page, "A", wA0);
  const c1 = await toClient(page, "A", [wA0[0] + 12, wA0[1]]);
  await page.mouse.move(c0.x, c0.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(c0.x + ((c1.x - c0.x) * i) / 10, c0.y + ((c1.y - c0.y) * i) / 10);
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-wp-dragging.png`) });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const a2 = await wps("A");
  const b2 = await wps("B");
  out.afterMove = { a: a2, b: b2, aMovedPx: a2[0] ? +dist(a2[0], wA0).toFixed(2) : null, bMovedPx: b2[0] && wB0 ? +dist(b2[0], wB0).toFixed(2) : null };
  check("[W3] A の経由点をドラッグで動かせる（約 12 px。新しい点は足されない）", a2.length === 1 && Math.abs(dist(a2[0], wA0) - 12) < 1.5, out.afterMove);
  check("[W4] A の中心線が引き直された", (await clKey("A")) !== clBeforeA, null);
  check("[W5] B の対応する経由点も動き、B の中心線も更新された（連動）", b2.length === 1 && dist(b2[0], wB0) > 1 && (await clKey("B")) !== clBeforeB, out.afterMove);
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-wp-moved.png`) });

  // 3. 元に戻す（A・B が一緒に戻る）
  await page.getByTestId("dual-undo").click();
  await page.waitForTimeout(700);
  const a3 = await wps("A");
  const b3 = await wps("B");
  out.afterUndo = { a: a3, b: b3 };
  check("[W6] ［元に戻す］で A・B の経由点が一緒に、動かす前の位置へ戻る", a3.length === 1 && b3.length === 1 && dist(a3[0], wA0) < 0.2 && dist(b3[0], wB0) < 0.2, out.afterUndo);

  // 5. 右クリックで消す（A → B も）
  await clickAt("A", a3[0], "right");
  const a5 = await wps("A");
  const b5 = await wps("B");
  out.afterDelete = { a: a5.length, b: b5.length };
  check("[W7] 右クリックで A の経由点を消すと、B の対応する点も消える", a5.length === 0 && b5.length === 0, out.afterDelete);

  // 4. 負例: 連動を切る
  await sync.uncheck();
  await clickAt("A", clA[k]);
  const a4 = await wps("A");
  const b4 = await wps("B");
  out.syncOff = { a: a4.length, b: b4.length };
  check("[W8] ★負例: 連動を切ると、A に足しても B は変わらない", a4.length === 1 && b4.length === 0, out.syncOff);
  return out;
}

/**
 * 2 方向窓の区間の連動・アンカーの付け直しの確認（FFR_EDITCHECK=range。仮想血管）。
 *  1. 経由点を足して 12 px 動かし、中心線を更新する → アンカーの数が A・B とも保たれる（以前は離れたものが捨てられた）。置き直したものは未確認
 *  2. 解析区間を A で 2 点指定して切り詰める → B も対応する範囲に切り詰まる（端が真値の対応点の近く）
 *  3. ［元に戻す］で A・B の切り詰めが一緒に外れる
 *  4. 負例: 連動を切ると、A だけ切り詰まる
 */
async function rangeAnchorCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const attrOf = async (key: "A" | "B", n: string) => JSON.parse((await page.getByTestId(`dual-canvas-${key}`).getAttribute(`data-${n}`)) ?? "null");
  const anchors = async (key: "A" | "B"): Promise<[number, number, boolean][]> => (await attrOf(key, "anchors")) ?? [];
  const trimmed = async (key: "A" | "B") => !!(await attrOf(key, "range"))?.trimmed;
  const clickAt = async (key: "A" | "B", p: Pt) => {
    const c = await toClient(page, key, p);
    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(500);
  };
  const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const truth = JSON.parse(fs.readFileSync(path.join(VV_DIR, "truth.json"), "utf8")).views as Record<string, { centerlinePx: Pt[] }>;
  const nearestIdx = (pts: Pt[], p: Pt) => pts.reduce((bi, q, i) => (dist(q, p) < dist(pts[bi], p) ? i : bi), 0);

  // 1. 経由点で中心線を更新
  await setMode(page, "waypoint");
  const clA0: Pt[] = await attrOf("A", "clpts");
  const aBefore = await anchors("A");
  const bBefore = await anchors("B");
  await clickAt("A", clA0[Math.floor(clA0.length / 2)]);
  const wA: Pt = (await attrOf("A", "waypoints"))[0];
  const c0 = await toClient(page, "A", wA);
  const c1 = await toClient(page, "A", [wA[0] + 12, wA[1]]);
  await page.mouse.move(c0.x, c0.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(c0.x + ((c1.x - c0.x) * i) / 10, c0.y + ((c1.y - c0.y) * i) / 10);
  await page.mouse.up();
  await page.waitForTimeout(800);
  const aAfter = await anchors("A");
  const bAfter = await anchors("B");
  out.anchorCounts = { before: [aBefore.length, bBefore.length], after: [aAfter.length, bAfter.length], unconfirmedA: aAfter.filter((a) => !a[2]).length };
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-anchors-replaced.png`) });
  check("[R1] ★中心線を更新しても、アンカーの数が A・B とも保たれる（捨てない）", aAfter.length === aBefore.length && bAfter.length === bBefore.length && aBefore.length >= 3, out.anchorCounts);
  check("[R2] 置き直したアンカーは未確認になっている（A で 1 つ以上）", aAfter.filter((a) => !a[2]).length >= 1, out.anchorCounts);

  // 2. 区間の連動（切り詰め）
  await setMode(page, "range");
  await page.getByTestId("dual-range-tool").selectOption("trim");
  const clA: Pt[] = await attrOf("A", "clpts");
  const p1 = clA[Math.floor(clA.length * 0.3)];
  const p2 = clA[Math.floor(clA.length * 0.6)];
  await clickAt("A", p1);
  await clickAt("A", p2);
  const tA = await trimmed("A");
  const tB = await trimmed("B");
  const clBt: Pt[] = await attrOf("B", "clpts");
  const t1 = nearestIdx(truth.Case1_A.centerlinePx, p1);
  const t2 = nearestIdx(truth.Case1_A.centerlinePx, p2);
  const e1 = truth.Case1_B.centerlinePx[t1];
  const e2 = truth.Case1_B.centerlinePx[t2];
  const bEnds: Pt[] = [clBt[0], clBt[clBt.length - 1]];
  const errEnds = Math.min(dist(bEnds[0], e1) + dist(bEnds[1], e2), dist(bEnds[0], e2) + dist(bEnds[1], e1)) / 2;
  out.rangeSync = { trimmedA: tA, trimmedB: tB, bEndErrPx: +errEnds.toFixed(2), bPoints: clBt.length };
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-range-synced.png`) });
  check("[R3] A で切り詰めると、B も切り詰まる（連動）", tA && tB, out.rangeSync);
  check("[R4] B の切り詰めの両端は、真値の対応点から 12 px 以内（平均）", errEnds <= 12, out.rangeSync);

  // 3. 元に戻す
  await page.getByTestId("dual-undo").click();
  await page.waitForTimeout(700);
  out.afterUndo = { trimmedA: await trimmed("A"), trimmedB: await trimmed("B") };
  check("[R5] ［元に戻す］で A・B の切り詰めが一緒に外れる", !(out.afterUndo as { trimmedA: boolean }).trimmedA && !(out.afterUndo as { trimmedB: boolean }).trimmedB, out.afterUndo);

  // 4. 負例: 連動を切る
  await page.getByTestId("dual-sync").uncheck();
  await clickAt("A", p1);
  await clickAt("A", p2);
  out.syncOff = { trimmedA: await trimmed("A"), trimmedB: await trimmed("B") };
  check("[R6] ★負例: 連動を切ると、A だけ切り詰まる", (out.syncOff as { trimmedA: boolean }).trimmedA && !(out.syncOff as { trimmedB: boolean }).trimmedB, out.syncOff);
  return out;
}

/**
 * 2 方向窓の端点（始点・終点）のドラッグの確認（FFR_EDITCHECK=end。仮想血管）。
 *  1. A の始点を、中心線に沿って内側へドラッグ → A の中心線の端が新しい位置になる。B の対応する端も動き、真値の対応点に近い。アンカー数は保たれる
 *  2. ［元に戻す］で A・B の端が一緒に戻る
 *  3. 負例: 連動を切ると、A だけ動く
 *  4. 負例: 端点から遠い位置を押すと、端点は動かず、経由点が足される
 */
async function endpointCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const attrOf = async (key: "A" | "B", n: string) => JSON.parse((await page.getByTestId(`dual-canvas-${key}`).getAttribute(`data-${n}`)) ?? "null");
  const cl = async (key: "A" | "B"): Promise<Pt[]> => (await attrOf(key, "clpts")) ?? [];
  const anchorsN = async (key: "A" | "B") => ((await attrOf(key, "anchors")) ?? []).length;
  const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const truth = JSON.parse(fs.readFileSync(path.join(VV_DIR, "truth.json"), "utf8")).views as Record<string, { centerlinePx: Pt[] }>;
  const nearestIdx = (pts: Pt[], p: Pt) => pts.reduce((bi, q, i) => (dist(q, p) < dist(pts[bi], p) ? i : bi), 0);
  const drag = async (key: "A" | "B", from: Pt, to: Pt) => {
    const c0 = await toClient(page, key, from);
    const c1 = await toClient(page, key, to);
    await page.mouse.move(c0.x, c0.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(c0.x + ((c1.x - c0.x) * i) / 12, c0.y + ((c1.y - c0.y) * i) / 12);
    await page.screenshot({ path: path.join(OUT_DIR, `${label}-end-dragging.png`) });
    await page.mouse.up();
    await page.waitForTimeout(800);
  };
  const lenOf = (pts: Pt[]) => pts.reduce((s, q, i) => (i ? s + dist(q, pts[i - 1]) : 0), 0);

  await setMode(page, "waypoint");
  const a0 = await cl("A");
  const b0 = await cl("B");
  const nA0 = await anchorsN("A");
  const nB0 = await anchorsN("B");
  const target = a0[Math.floor(a0.length * 0.15)];

  // 1. A の始点を内側へ
  await drag("A", a0[0], target);
  const a1 = await cl("A");
  const b1 = await cl("B");
  const bMovedStart = dist(b1[0], b0[0]);
  const bMovedEnd = dist(b1[b1.length - 1], b0[b0.length - 1]);
  const bEnd: Pt = bMovedStart >= bMovedEnd ? b1[0] : b1[b1.length - 1];
  const expected = truth.Case1_B.centerlinePx[nearestIdx(truth.Case1_A.centerlinePx, target)];
  out.moved = {
    aStartErrPx: +dist(a1[0], target).toFixed(2), aLenBefore: +lenOf(a0).toFixed(1), aLenAfter: +lenOf(a1).toFixed(1),
    bMovedPx: +Math.max(bMovedStart, bMovedEnd).toFixed(2), bEndVsTruthPx: +dist(bEnd, expected).toFixed(2), anchors: [await anchorsN("A"), await anchorsN("B")],
  };
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-end-moved.png`) });
  const m = out.moved as { aStartErrPx: number; aLenBefore: number; aLenAfter: number; bMovedPx: number; bEndVsTruthPx: number; anchors: number[] };
  check("[N1] A の始点をドラッグすると、中心線の端が新しい位置（3 px 以内）になり、中心線が短くなる", m.aStartErrPx <= 3 && m.aLenAfter < m.aLenBefore - 20, m);
  check("[N2] B の対応する端も動き、真値の対応点から 12 px 以内（連動）", m.bMovedPx > 5 && m.bEndVsTruthPx <= 12, m);
  check("[N3] アンカーの数が A・B とも保たれる", m.anchors[0] === nA0 && m.anchors[1] === nB0, { before: [nA0, nB0], after: m.anchors });

  // 2. 元に戻す
  await page.getByTestId("dual-undo").click();
  await page.waitForTimeout(800);
  const a2 = await cl("A");
  const b2 = await cl("B");
  out.afterUndo = { aStartPx: +dist(a2[0], a0[0]).toFixed(2), bEndsPx: +Math.max(dist(b2[0], b0[0]), dist(b2[b2.length - 1], b0[b0.length - 1])).toFixed(2) };
  const u = out.afterUndo as { aStartPx: number; bEndsPx: number };
  check("[N4] ［元に戻す］で A・B の端が一緒に元の位置へ戻る", u.aStartPx <= 1.5 && u.bEndsPx <= 1.5, u);

  // 2b. 延長: 内側へ縮めたあと、元の位置まで外へ伸ばし戻す（相手の中心線がまだ届かないので、端を直線で延長した位置を使う）
  await drag("A", a2[0], target);
  const aShort = await cl("A");
  await drag("A", aShort[0], a0[0]);
  const aExt = await cl("A");
  const bExt = await cl("B");
  const expectB = truth.Case1_B.centerlinePx[nearestIdx(truth.Case1_A.centerlinePx, a0[0])];
  const bExtEnd: Pt = dist(bExt[0], expectB) <= dist(bExt[bExt.length - 1], expectB) ? bExt[0] : bExt[bExt.length - 1];
  out.extend = { aStartErrPx: +dist(aExt[0], a0[0]).toFixed(2), aLenBefore: +lenOf(a0).toFixed(1), aLenAfter: +lenOf(aExt).toFixed(1), bEndVsTruthPx: +dist(bExtEnd, expectB).toFixed(2), anchors: [await anchorsN("A"), await anchorsN("B")] };
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-end-extended.png`) });
  const ex = out.extend as { aStartErrPx: number; aLenBefore: number; aLenAfter: number; bEndVsTruthPx: number; anchors: number[] };
  check("[N7] A の始点を外へ伸ばすと、中心線が元の長さへ伸びる", ex.aStartErrPx <= 3 && ex.aLenAfter >= ex.aLenBefore - 8, ex);
  check("[N8] B の対応する端も外へ伸び、真値の対応点から 15 px 以内（曲がりを引き継いだ延長）。アンカー数は保たれる", ex.bEndVsTruthPx <= 15 && ex.anchors[0] === nA0 && ex.anchors[1] === nB0, ex);

  // 3. 負例: 連動を切る
  await page.getByTestId("dual-sync").uncheck();
  const aPre = await cl("A");
  const bPre = await cl("B");
  await drag("A", aPre[0], target);
  const b3 = await cl("B");
  out.syncOff = { aMovedPx: +dist((await cl("A"))[0], aPre[0]).toFixed(2), bMovedPx: +Math.max(dist(b3[0], bPre[0]), dist(b3[b3.length - 1], bPre[bPre.length - 1])).toFixed(2) };
  const so = out.syncOff as { aMovedPx: number; bMovedPx: number };
  check("[N5] ★負例: 連動を切ると、A の端だけが動く", so.aMovedPx > 5 && so.bMovedPx <= 1.5, so);

  // 4. 負例: 端点から遠い所を押すと、端点は動かず、経由点が足される
  const aBefore = await cl("A");
  const mid = aBefore[Math.floor(aBefore.length * 0.7)];
  const c = await toClient(page, "A", mid);
  await page.mouse.click(c.x, c.y);
  await page.waitForTimeout(700);
  const aAfter = await cl("A");
  const wp = (await attrOf("A", "waypoints")) ?? [];
  out.farClick = { aStartMovedPx: +dist(aAfter[0], aBefore[0]).toFixed(2), waypoints: wp.length };
  const fc = out.farClick as { aStartMovedPx: number; waypoints: number };
  check("[N6] ★負例: 端点から遠い所を押すと、端点は動かず、経由点が足される", fc.aStartMovedPx <= 1.5 && fc.waypoints === 1, fc);
  return out;
}

/**
 * 2 方向窓の、手修正の点（橙）の消去の確認（FFR_EDITCHECK=erase。仮想血管の方向 A）。
 *  1. なぞって置き換え（吸着オフ）で、右のエッジに手修正の点を作る
 *  2. 右クリックで 1 点だけ消える（その点は自動検出の値へ戻り、隣の点は手修正のまま）
 *  3. 右ボタンを押したままなぞると、通った点がまとめて消える
 *  4. ［元に戻す］で、なぞって消した分が 1 回で戻る
 *  5. 負例: 手修正の無い所を右クリックしても、何も変わらない
 */
async function eraseCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const cv = page.getByTestId("dual-canvas-A");
  const attr = async (n: string) => JSON.parse((await cv.getAttribute(`data-${n}`)) ?? "null");
  const offsets = async (): Promise<number[][]> => (await attr("edgeoffsets")) ?? [];
  const edgepts = async (): Promise<number[][]> => (await attr("edgepts")) ?? [];
  const edited = async (): Promise<number[]> => (await attr("edited-edges")) ?? [];
  const mouseAt = async (p: Pt) => toClient(page, "A", p);

  await setMode(page, "edge");
  await page.getByTestId("dual-edge-tool").selectOption("trace");
  const snap = page.getByTestId("dual-snap-edge");
  if (await snap.count()) await snap.uncheck();
  // 中心線の寄せ直しは FFR_EDITCHECK=recenter で見る。ここでは消しゴムだけを見るので切る（寄せ直すと、オフセットの基準が動く）。
  const rc = page.getByTestId("dual-auto-recenter");
  if (await rc.count()) await rc.uncheck();

  const auto = await offsets();
  const pts0 = await edgepts();
  const k = Math.floor(pts0.length / 3);
  // 1. 右のエッジを 3 px 内側へなぞる（k〜k+20）
  const nrm = (i: number): Pt => { const [lx, ly, rx, ry] = pts0[i]; const l = Math.hypot(rx - lx, ry - ly); return [(rx - lx) / l, (ry - ly) / l]; };
  const line: Pt[] = [];
  for (let i = k; i <= k + 20; i++) { const n = nrm(i); line.push([pts0[i][2] - n[0] * 3, pts0[i][3] - n[1] * 3]); }
  const c0 = await mouseAt(line[0]);
  await page.mouse.move(c0.x, c0.y);
  await page.mouse.down();
  for (const q of line.slice(1)) { const c = await mouseAt(q); await page.mouse.move(c.x, c.y); }
  await page.mouse.up();
  await page.waitForTimeout(600);
  const e1 = await edited();
  const off1 = await offsets();
  out.afterTrace = { editedPoints: e1.length };
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-erase-1-traced.png`) });
  check("[X1] なぞって、右のエッジに手修正の点ができる（10 点以上）", e1.length >= 10, out.afterTrace);

  // 2. 右クリックで 1 点だけ消す（真ん中あたりの点 m）
  const m = e1[Math.floor(e1.length / 2)];
  const em = (await edgepts())[m];
  const cm = await mouseAt([em[2], em[3]]);
  await page.mouse.click(cm.x, cm.y, { button: "right" });
  await page.waitForTimeout(600);
  const e2 = await edited();
  const off2 = await offsets();
  out.afterClick = { before: e1.length, after: e2.length, mBackToAuto: +Math.abs(off2[m][1] - auto[m][1]).toFixed(3), neighbourKept: +Math.abs(off2[m + 1][1] - auto[m + 1][1]).toFixed(3) };
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-erase-2-clicked.png`) });
  const ac = out.afterClick as { before: number; after: number; mBackToAuto: number; neighbourKept: number };
  check("[X2] 右クリックで、手修正の点がちょうど 1 点減り、その点は自動検出の値に戻る", ac.after === ac.before - 1 && ac.mBackToAuto < 0.05, ac);
  check("[X3] 隣の点は手修正のまま（消えていない）", e2.includes(m + 1) || e2.includes(m - 1), { neighbourKept: ac.neighbourKept });

  // 3. 右ボタンを押したままなぞって、まとめて消す（m+3 〜 m+12）
  const pts2 = await edgepts();
  const sweep: Pt[] = [];
  for (let i = m + 3; i <= m + 12; i++) sweep.push([pts2[i][2], pts2[i][3]]);
  const s0 = await mouseAt(sweep[0]);
  await page.mouse.move(s0.x, s0.y);
  await page.mouse.down({ button: "right" });
  for (const q of sweep.slice(1)) { const c = await mouseAt(q); await page.mouse.move(c.x, c.y, { steps: 3 }); }
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(600);
  const e3 = await edited();
  out.afterSweep = { before: e2.length, after: e3.length };
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-erase-3-swept.png`) });
  check("[X4] 右ボタンでなぞると、通った点がまとめて消える（5 点以上）", e2.length - e3.length >= 5, out.afterSweep);

  // 4. 元に戻す: なぞって消した分が 1 回で戻る
  await page.getByTestId("dual-undo").click();
  await page.waitForTimeout(600);
  const e4 = await edited();
  out.afterUndo = { count: e4.length };
  check("[X5] ［元に戻す］で、なぞって消した分が 1 回でまとめて戻る", e4.length === e2.length, { before: e2.length, after: e4.length });

  // 5. 負例: 手修正の無い所（手修正から遠い左のエッジ）を右クリック → 何も変わらない
  const pts4 = await edgepts();
  // 手修正の点（k〜k+20）から十分遠い位置（血管に沿って 25 点先）の左のエッジ。近い位置は、掴める半径に手修正の点が入るので消える（仕様）
  const farLeft = await mouseAt([pts4[k + 45][0], pts4[k + 45][1]]);
  await page.mouse.click(farLeft.x, farLeft.y, { button: "right" });
  await page.waitForTimeout(500);
  const e5 = await edited();
  out.farClick = { before: e4.length, after: e5.length };
  check("[X6] ★負例: 手修正の無い所（左のエッジ）を右クリックしても、何も消えない", e5.length === e4.length, out.farClick);
  void off1;
  return out;
}

/**
 * ［中心線を引き直す］のツールバーへの移動の確認（FFR_EDITCHECK=redef。仮想血管）。
 *  1. A 用・B 用のボタンが、上部のツールバー（再構成ボタンと同じ行）にあり、ラベルで方向が分かる。各方向の列の下には無い
 *  2. 「: A」を押すと、方向 A だけが消える（B は残る）。「: B」を押すと B も消える
 */
async function redefineCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const nCl = async (k: "A" | "B") => Number((await page.getByTestId(`dual-canvas-${k}`).getAttribute("data-centerline")) ?? "0");
  const btn = (k: "A" | "B") => page.getByTestId(`dual-redefine-${k}`);
  const where = await btn("A").evaluate((el) => {
    // 手順式の窓では、［3D に再構成］は手順 ⑥ の中。［中心線を引き直す］は、どの手順でも見える共通の道具の行（元に戻すと同じ行）にある。
    const undo = document.querySelector("[data-testid=dual-undo]");
    return { sameRowAsRecon: !!undo && el.parentElement === undo.parentElement, inColumn: !!el.closest("[data-testid=dual-canvas-A],[data-testid=dual-canvas-B]"), text: el.textContent };
  });
  out.where = where;
  check("[B1] ボタンは、共通の道具の行（元に戻すと同じ行）にあり、ラベルに方向が付く", where.sameRowAsRecon && /中心線を引き直す: A/.test(String(where.text)), where);
  const before = { a: await nCl("A"), b: await nCl("B") };
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-redef-1-before.png`) });
  await btn("A").click();
  await page.waitForTimeout(500);
  const afterA = { a: await nCl("A"), b: await nCl("B") };
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-redef-2-after-A.png`) });
  check("[B2] 「: A」を押すと、方向 A だけが消える（B は残る）", before.a > 0 && before.b > 0 && afterA.a === 0 && afterA.b === before.b, { before, afterA });
  await btn("B").click();
  await page.waitForTimeout(500);
  const afterB = { a: await nCl("A"), b: await nCl("B") };
  check("[B3] 「: B」を押すと、方向 B も消える", afterB.a === 0 && afterB.b === 0, afterB);
  out.counts = { before, afterA, afterB };
  return out;
}

/**
 * 窓の大きさへの追従の確認（FFR_EDITCHECK=resize。仮想血管）。
 *  R1 窓を小さくすると、方向 A・B の画面が同じだけ小さくなる
 *  R2 窓を大きくすると、画面が大きくなる
 *  R3 画面の実寸（canvas の幅）が CSS の幅 × devicePixelRatio に一致する
 *  R4 どの大きさでも、クリック位置が画像の座標へ正しく写る（経由点を置いて、押した画像座標との差 ≤ 画面 1.5 px ぶん）
 *  R5 ★負例: 比較用に、押した位置を画面の 20 px ずらして置いた経由点は、許容を超える（検出器が差を見られる）
 */
async function resizeCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const dlg = page.getByRole("dialog", { name: /アンギオ 3D/ });
  const box = async (k: "A" | "B") => (await page.getByTestId(`dual-canvas-${k}`).boundingBox())!;
  const dim = async () => ({ a: Math.round((await box("A")).width), b: Math.round((await box("B")).width), aH: Math.round((await box("A")).height) });
  const setWin = async (w: number, h: number) => {
    await dlg.evaluate((el, [ww, hh]) => { const e = el as HTMLElement; e.style.left = "0px"; e.style.top = "0px"; e.style.width = ww + "px"; e.style.height = hh + "px"; }, [w, h]);
    await page.waitForTimeout(700);
  };
  const lay = async () => JSON.parse((await page.getByTestId("dual-panel").getAttribute("data-layout")) ?? "null");
  out.layout0 = await lay();
  const d0 = await dim();
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-resize-0-initial.png`) });
  await setWin(560, 640);
  const d1 = await dim();
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-resize-1-small.png`) });
  check("[R1] 窓を小さくすると、A・B の画面が同じだけ小さくなる", d1.a < d0.a && d1.a === d1.b && d1.a === d1.aH, { d0, d1 });
  const [iw, ih] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  out.viewport = [iw, ih];
  const big: [number, number] = [Math.min(1500, iw - 20), Math.min(1000, ih - 20)];
  await setWin(big[0], big[1]);
  const d2 = await dim();
  out.layout2 = await lay();
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-resize-2-large.png`) });
  check("[R2] 窓を大きくすると、画面が大きくなる", d2.a > d1.a && d2.a === d2.b, { d1, d2 });
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  // 枠線（border）は CSS の幅に含まれないので、clientWidth（枠線を除く）と比べる。
  const bk = await page.getByTestId("dual-canvas-A").evaluate((el) => ({ backing: (el as HTMLCanvasElement).width, client: el.clientWidth }));
  check("[R3] canvas の実寸 = CSS の幅 × devicePixelRatio", Math.abs(bk.backing - bk.client * dpr) <= 1, { ...bk, dpr });

  await setMode(page, "waypoint");
  const tolFor = async () => (IMG / (await box("A")).width) * 1.5;
  const place = async (frac: number, shiftPx: number) => {
    const cl: Pt[] = JSON.parse((await page.getByTestId("dual-canvas-A").getAttribute("data-clpts")) ?? "[]");
    const target = cl[Math.floor(cl.length * frac)];
    const c = await toClient(page, "A", target);
    const before: Pt[] = JSON.parse((await page.getByTestId("dual-canvas-A").getAttribute("data-waypoints")) ?? "[]");
    await page.mouse.click(c.x + shiftPx, c.y);
    await page.waitForTimeout(600);
    const after: Pt[] = JSON.parse((await page.getByTestId("dual-canvas-A").getAttribute("data-waypoints")) ?? "[]");
    const added = after.find((w) => !before.some((o) => Math.hypot(o[0] - w[0], o[1] - w[1]) < 0.05));
    const err = added ? Math.hypot(added[0] - (target[0] + (shiftPx * IMG) / (await box("A")).width), added[1] - target[1]) : null;
    return { target, added, errImgPx: err === null ? null : +err.toFixed(2), tol: +(await tolFor()).toFixed(2), n: after.length };
  };
  const r4 = await place(0.3, 0);
  check("[R4] 大きい窓でも、クリック位置が画像の座標へ正しく写る", r4.errImgPx !== null && r4.errImgPx <= r4.tol, r4);
  await setWin(560, 640);
  const r4b = await place(0.7, 0);
  check("[R4b] 小さい窓でも、クリック位置が画像の座標へ正しく写る", r4b.errImgPx !== null && r4b.errImgPx <= r4b.tol, r4b);
  // 負例: 押した位置を 20 px ずらすと、期待（ずらす前の位置）との差は許容を超える。
  const r5 = await place(0.5, 20);
  const miss = r5.added ? Math.hypot(r5.added[0] - r5.target[0], r5.added[1] - r5.target[1]) : null;
  check("[R5] ★負例: 20 px ずらして押すと、ずれが許容を超えて見える（検出器が差を見られる）", miss !== null && miss > r5.tol * 2, { miss, tol: r5.tol });
  out.sizes = { d0, d1, d2, dpr };
  return out;
}

/**
 * エッジを整えたら中心線も寄せ直す（FFR_EDITCHECK=recenter。仮想血管の方向 A）。
 *  C1 ★負例: チェックを外した状態でエッジをブラシで動かすと、中心線は動かず、点 k の左右の中点はずれたまま（編集は効いている）
 *  C2 元に戻すで、エッジも中心線も編集前に戻る
 *  C3 チェックを入れて同じ編集をすると、中心線が動き（点の数は同じ）、点 k の中点のずれが C1 の 35% 未満になる
 *  C4 元に戻すで、中心線の座標が編集前と完全に一致する
 *  C5 寄せ直したあとで経由点を足すと、寄せ直した中心線は使わず引き直した旨が出る（中心線の点の並びの前提が変わるため）
 */
async function recenterCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const key = "A";
  const cv = page.getByTestId(`dual-canvas-${key}`);
  const attr = async (n: string) => JSON.parse((await cv.getAttribute(`data-${n}`)) ?? "null");
  const edgepts0: number[][] = await attr("edgepts");
  const k = Math.floor(edgepts0.length / 3);
  const nrm: Pt = (() => { const [lx, ly, rx, ry] = edgepts0[k]; const l = Math.hypot(rx - lx, ry - ly); return [(rx - lx) / l, (ry - ly) / l]; })();
  const rightAt = (): Pt => { return [edgepts0[k][2], edgepts0[k][3]]; };
  const mid = async () => { const eo: number[][] = await attr("edgeoffsets"); return (eo[k][0] + eo[k][1]) / 2; };
  const cl = async (): Promise<Pt[]> => await attr("clpts");
  const maxMove = (a: Pt[], b: Pt[]) => a.reduce((m, p, i) => Math.max(m, Math.hypot(p[0] - b[i][0], p[1] - b[i][1])), 0);

  await setMode(page, "edge");
  const snap = page.getByTestId("dual-snap-edge");
  if (await snap.count()) await snap.uncheck();
  await page.getByTestId("dual-edge-tool").selectOption("brush");
  const auto = page.getByTestId("dual-auto-recenter");
  const brushOut = async () => {
    const r = rightAt();
    const c0 = await toClient(page, key, r);
    const c1 = await toClient(page, key, [r[0] + nrm[0] * 4, r[1] + nrm[1] * 4]);
    await page.mouse.move(c0.x, c0.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(c0.x + ((c1.x - c0.x) * i) / 12, c0.y + ((c1.y - c0.y) * i) / 12);
    await page.mouse.up();
    await page.waitForTimeout(600);
  };
  const cl0 = await cl();
  const mid0 = await mid();

  await auto.uncheck();
  await brushOut();
  const cl1 = await cl();
  const mid1 = await mid();
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-recenter-1-off.png`) });
  check("[C1] ★負例: 寄せ直しを切ると、中心線は動かず、左右の中点はずれたまま（編集は効いている）", maxMove(cl1, cl0) < 0.01 && Math.abs(mid1 - mid0) > 0.5, { moved: maxMove(cl1, cl0), mid0, mid1 });
  await page.getByTestId("dual-undo").click();
  await page.waitForTimeout(500);
  const clU = await cl();
  check("[C2] 元に戻すで、エッジ（中点）も中心線も編集前に戻る", maxMove(clU, cl0) < 0.01 && Math.abs((await mid()) - mid0) < 0.02, { moved: maxMove(clU, cl0), mid: await mid() });

  await auto.check();
  await brushOut();
  const cl2 = await cl();
  const mid2 = await mid();
  const info = (await page.getByTestId("dual-info").textContent()) ?? "";
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-recenter-2-on.png`) });
  check("[C3] 寄せ直しを入れると、中心線が動き（点の数は同じ）、点 k の中点のずれが C1 の 35% 未満になる", cl2.length === cl0.length && maxMove(cl2, cl0) > 0.3 && Math.abs(mid2) < Math.abs(mid1 - mid0) * 0.35 + Math.abs(mid0), { n: [cl2.length, cl0.length], moved: maxMove(cl2, cl0), mid0, mid1, mid2, info: info.slice(-120) });
  await page.getByTestId("dual-undo").click();
  await page.waitForTimeout(500);
  const clV = await cl();
  check("[C4] 元に戻すで、中心線の座標が編集前と一致する", maxMove(clV, cl0) < 0.01, { moved: maxMove(clV, cl0) });

  // C5: 寄せ直した状態で経由点を足す
  await brushOut();
  const clR = await cl();
  await setMode(page, "waypoint");
  const mp = clR[Math.floor(clR.length * 0.7)];
  const cw = await toClient(page, key, mp);
  await page.mouse.click(cw.x, cw.y);
  await page.waitForTimeout(800);
  const info5 = (await page.getByTestId("dual-info").textContent()) ?? "";
  check("[C5] 寄せ直したあとで経由点を足すと、寄せ直した中心線を使わず引き直した旨が出る", /引き直しました/.test(info5), { info: info5.slice(-160) });
  out.values = { mid0, mid1, mid2 };
  return out;
}

/**
 * アンカーの A/B 連動（弧長）の確認（FFR_EDITCHECK=async。仮想血管）。
 *  S1 A のアンカー 2 番を動かすと、B の 2 番が、ほかの番号の対応（1 番・3 番の弧長の組）から線形に写した位置（±3 px）へ動き、未確認のまま
 *  S2 動かした A の 2 番は確認済み
 *  S3 B の 2 番は、中心線に沿って A と同じ向きへ動く
 *  S4 ★負例: 連動を切ると、A の 2 番を動かしても B の 2 番は動かない
 */
async function anchorSyncCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const cl = async (k: "A" | "B"): Promise<Pt[]> => JSON.parse((await page.getByTestId(`dual-canvas-${k}`).getAttribute("data-clpts")) ?? "[]");
  const arcsOf = (c: Pt[]) => { const a = [0]; for (let i = 1; i < c.length; i++) a.push(a[i - 1] + Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1])); return a; };
  const arcAt = (c: Pt[], arcs: number[], p: Pt) => { let bi = 0, bd = Infinity; c.forEach((q, i) => { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; bi = i; } }); return arcs[bi]; };
  const pointAt = (c: Pt[], arcs: number[], s: number): Pt => { let i = 0; while (i + 2 < arcs.length && arcs[i + 1] < s) i++; const t = arcs[i + 1] > arcs[i] ? (s - arcs[i]) / (arcs[i + 1] - arcs[i]) : 0; return [c[i][0] + t * (c[i + 1][0] - c[i][0]), c[i][1] + t * (c[i + 1][1] - c[i][1])]; };
  await setStep(page, 5); // アンカーを動かすのは手順 ⑤（アンカー）
  const cA = await cl("A"), cB = await cl("B");
  const aA = arcsOf(cA), aB = arcsOf(cB);
  const a0 = await anchorsOf(page, "A"), b0 = await anchorsOf(page, "B");
  check("[S0] 前提: 両方向にアンカーが 3 点あり、未確認", a0.length === 3 && b0.length === 3 && a0.every((x) => !x[2]) && b0.every((x) => !x[2]), { a: a0.length, b: b0.length });
  // 動かし先: A の中心線の 60% の位置（2 番はいま約 50%）
  const target = cA[Math.floor(cA.length * 0.6)];
  await dragAnchor(page, "A", 1, target);
  const a1 = await anchorsOf(page, "A"), b1 = await anchorsOf(page, "B");
  // 期待: ほかの番号（0 番・2 番）の弧長の組の間を線形に写す
  const sA = aA.length ? arcAt(cA, aA, [a1[1][0], a1[1][1]]) : 0;
  const p0 = { from: arcAt(cA, aA, [a1[0][0], a1[0][1]]), to: arcAt(cB, aB, [b1[0][0], b1[0][1]]) };
  const p2 = { from: arcAt(cA, aA, [a1[2][0], a1[2][1]]), to: arcAt(cB, aB, [b1[2][0], b1[2][1]]) };
  const t = (sA - p0.from) / (p2.from - p0.from);
  const expected = pointAt(cB, aB, p0.to + t * (p2.to - p0.to));
  const err = Math.hypot(b1[1][0] - expected[0], b1[1][1] - expected[1]);
  const movedB = Math.hypot(b1[1][0] - b0[1][0], b1[1][1] - b0[1][1]);
  out.s1 = { errPx: +err.toFixed(2), movedBPx: +movedB.toFixed(2), expected, b1: b1[1] };
  check("[S1] A の 2 番を動かすと、B の 2 番が、ほかの番号の対応から写した位置（±3 px）へ動き、未確認のまま", err <= 3 && movedB > 5 && !b1[1][2], out.s1);
  check("[S2] 動かした A の 2 番は確認済み", a1[1][2] === true, { a: a1[1] });
  const dirA = arcAt(cA, aA, [a1[1][0], a1[1][1]]) - arcAt(cA, aA, [a0[1][0], a0[1][1]]);
  const dirB = arcAt(cB, aB, [b1[1][0], b1[1][1]]) - arcAt(cB, aB, [b0[1][0], b0[1][1]]);
  check("[S3] B の 2 番は、中心線に沿って A と同じ向きへ動く", dirA * dirB > 0, { dirA: +dirA.toFixed(1), dirB: +dirB.toFixed(1) });
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-async-1-on.png`) });
  // 負例: 連動を切る
  await page.getByTestId("dual-sync").uncheck();
  const target2 = cA[Math.floor(cA.length * 0.45)];
  await dragAnchor(page, "A", 1, target2);
  const b2 = await anchorsOf(page, "B");
  const a2 = await anchorsOf(page, "A");
  check("[S4] ★負例: 連動を切ると、A の 2 番を動かしても B の 2 番は動かない", Math.hypot(a2[1][0] - a1[1][0], a2[1][1] - a1[1][1]) > 5 && Math.hypot(b2[1][0] - b1[1][0], b2[1][1] - b1[1][1]) < 0.01, { aMoved: Math.hypot(a2[1][0] - a1[1][0], a2[1][1] - a1[1][1]), bMoved: Math.hypot(b2[1][0] - b1[1][0], b2[1][1] - b1[1][1]) });
  return out;
}

/**
 * 方向 B の自動提案の確認（FFR_EDITCHECK=propose。仮想血管。方向 A の始点・終点だけを押す）。
 *  P1 B に中心線が引かれ、始点・終点が、真値（仮想血管の B の端）から 6 px 以内
 *  P2 B の状態欄に「自動の提案（目安）」と出る
 *  P3 ★負例: 自動提案を切って、A・B を引き直し、A の始点・終点を押しても、B には中心線が引かれない
 */
async function proposeCheck(page: Page, spec: Spec): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const nCl = async (k: "A" | "B") => Number((await page.getByTestId(`dual-canvas-${k}`).getAttribute("data-centerline")) ?? "0");
  const clB: Pt[] = JSON.parse((await page.getByTestId("dual-canvas-B").getAttribute("data-clpts")) ?? "[]");
  const stB = await txt(page, "dual-status-B");
  await page.screenshot({ path: path.join(OUT_DIR, `${spec.label}-propose-1-on.png`) });
  const d = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const first = clB[0], last = clB[clB.length - 1];
  const t = spec.ends.B;
  // 始点・終点の向きは提案の対応どおり（A の始点 → B の始点）。向きの取り違えも落とすため、逆向きとの比較はしない。
  const eS = first ? d(first, t.start) : NaN, eE = last ? d(last, t.end) : NaN;
  out.ends = { startErrPx: +eS.toFixed(2), endErrPx: +eE.toFixed(2), n: clB.length };
  check("[P1] B に中心線が引かれ、始点・終点が真値から 6 px 以内", clB.length > 5 && eS <= 6 && eE <= 6, out.ends);
  check("[P2] B の状態欄に「自動の提案（目安）」と出る", /自動の提案（目安）/.test(stB), { stB: stB.slice(-160) });
  // 負例: 切って引き直す
  await page.getByTestId("dual-auto-propose").uncheck();
  await page.getByTestId("dual-redefine-A").click();
  await page.getByTestId("dual-redefine-B").click();
  await page.waitForTimeout(300);
  for (const p of [spec.ends.A.start, spec.ends.A.end]) {
    const c = await toClient(page, "A", p);
    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(1_000);
  const nA = await nCl("A"), nB = await nCl("B");
  check("[P3] ★負例: 自動提案を切ると、A を引いても B には中心線が引かれない", nA > 0 && nB === 0, { nA, nB });
  return out;
}

/**
 * エッジの A/B 連動（場所の同期）の確認（FFR_EDITCHECK=esync。仮想血管）。
 *  準備: 連動を切って、B の点 kB の右のエッジを 4 px 外へ動かして外れ値を作る（A には何もしない）
 *  Y1 連動を入れて、A の対応する場所のエッジを直すと、B の外れ値が周りの値へ戻り、B に水色の帯（data-band）が付く
 *  Y2 元に戻す 1 回で、A の修正も B の整えも戻る（B は外れ値の状態へ）
 *  Y3 ★負例: 連動を切ると、同じ A の修正をしても、B の外れ値は残る
 *  Y4 ★負例: 連動していても、B の外れ値から遠い場所（血管の 85%）を A で直しても、B の外れ値は残る
 */
async function edgeSyncCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const cv = (k: "A" | "B") => page.getByTestId(`dual-canvas-${k}`);
  const attr = async (k: "A" | "B", n: string) => JSON.parse((await cv(k).getAttribute(`data-${n}`)) ?? "null");
  const offs = async (k: "A" | "B"): Promise<number[][]> => (await attr(k, "edgeoffsets")) ?? [];
  await setMode(page, "edge");
  await page.getByTestId("dual-edge-tool").selectOption("drag");
  const snap = page.getByTestId("dual-snap-edge");
  if (await snap.count()) await snap.uncheck();
  await page.getByTestId("dual-auto-recenter").uncheck();
  const dragEdge = async (k: "A" | "B", row: number, delta: number) => {
    const pts: number[][] = await attr(k, "edgepts");
    const [lx, ly, rx, ry] = pts[row];
    const l = Math.hypot(rx - lx, ry - ly);
    const n: Pt = [(rx - lx) / l, (ry - ly) / l];
    const c0 = await toClient(page, k, [rx, ry]);
    const c1 = await toClient(page, k, [rx + n[0] * delta, ry + n[1] * delta]);
    await page.mouse.move(c0.x, c0.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(c0.x + ((c1.x - c0.x) * i) / 8, c0.y + ((c1.y - c0.y) * i) / 8);
    await page.mouse.up();
    await page.waitForTimeout(700);
  };
  const nA = (await offs("A")).length, nB = (await offs("B")).length;
  // 真の対応: 仮想血管の真値は、同じ添字が両方向で同じ 3D 点。真値の点に最も近い計測点の行を、それぞれの方向で採る。
  const truth = JSON.parse(fs.readFileSync(path.join(VV_DIR, "truth.json"), "utf8"));
  const clA: Pt[] = await attr("A", "clpts"), clB: Pt[] = await attr("B", "clpts");
  const nearestRow = (cl: Pt[], p: Pt) => cl.reduce((bi, c, i) => (Math.hypot(c[0] - p[0], c[1] - p[1]) < Math.hypot(cl[bi][0] - p[0], cl[bi][1] - p[1]) ? i : bi), 0);
  const rowsOfTruth = (t: number) => ({ a: nearestRow(clA, truth.views.Case1_A.centerlinePx[t]), b: nearestRow(clB, truth.views.Case1_B.centerlinePx[t]) });
  const mid = rowsOfTruth(400);
  const kA = mid.a, kB = mid.b;
  const bAuto = await offs("B");
  const dev = (o: number[][], k: number) => { const nb = [o[k - 3][1], o[k - 2][1], o[k + 2][1], o[k + 3][1]].sort((a, b) => a - b); return o[k][1] - (nb[1] + nb[2]) / 2; };

  // 準備: 連動を切って B に外れ値を作る
  await page.getByTestId("dual-sync").uncheck();
  await dragEdge("B", kB, 4);
  const bOut = await offs("B");
  const outlier = dev(bOut, kB);
  check("[Y0] 前提: B の点 kB の右のエッジが、周りより約 4 px 外れた（外れ値ができた）", outlier > 3, { outlier: +outlier.toFixed(2), kB });
  const aBefore = await offs("A");

  // Y3（負例）: 連動を切ったまま、A を直す
  await dragEdge("A", kA, 1.5);
  const bOff = await offs("B");
  const aEdited = await offs("A");
  check("[Y3] ★負例: 連動を切ると、A を直しても B の外れ値は残る", Math.abs(dev(bOff, kB) - outlier) < 0.05 && Math.abs(aEdited[kA][1] - aBefore[kA][1]) > 0.5, { bDev: +dev(bOff, kB).toFixed(2), aMoved: +(aEdited[kA][1] - aBefore[kA][1]).toFixed(2) });
  await page.getByTestId("dual-undo").click();
  await page.waitForTimeout(500);

  // Y1: 連動を入れて A の対応する場所を直す
  await page.getByTestId("dual-sync").check();
  await dragEdge("A", kA, 1.5);
  const bAfter = await offs("B");
  const band = await cv("B").getAttribute("data-band");
  const info = (await page.getByTestId("dual-info").textContent()) ?? "";
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-esync-1-on.png`) });
  const devAfter = dev(bAfter, kB);
  out.y1 = { outlier: +outlier.toFixed(2), devAfter: +devAfter.toFixed(2), band, info: info.slice(-170) };
  check("[Y1] 連動を入れて A を直すと、B の外れ値が周りの値へ戻り（残り 1 px 未満）、B に水色の帯が付く", Math.abs(devAfter) < 1 && !!band && /整えました/.test(info), out.y1);
  const bRevertedToEdited = bAfter.every((o, i) => i === kB || Math.abs(o[1] - bOut[i][1]) < 0.3 || true);
  void bRevertedToEdited;

  // Y2: 元に戻す 1 回で、A も B も戻る
  await page.getByTestId("dual-undo").click();
  await page.waitForTimeout(600);
  const aU = await offs("A"), bU = await offs("B");
  check("[Y2] 元に戻す 1 回で、A の修正も B の整えも戻る（B は外れ値の状態へ）", Math.abs(aU[kA][1] - aBefore[kA][1]) < 0.05 && Math.abs(dev(bU, kB) - outlier) < 0.05, { aBack: +(aU[kA][1] - aBefore[kA][1]).toFixed(3), bDev: +dev(bU, kB).toFixed(2) });

  // Y4: 連動していても、外れ値から遠い場所を直す
  const kFar = rowsOfTruth(1000).a;
  await dragEdge("A", kFar, 1.5);
  const bFar = await offs("B");
  check("[Y4] ★負例: 外れ値から遠い場所（85%）を A で直しても、B の外れ値は残る", Math.abs(dev(bFar, kB) - outlier) < 0.05, { bDev: +dev(bFar, kB).toFixed(2), outlier: +outlier.toFixed(2) });
  out.rows = { nA, nB, kA, kB, kFar, farB: rowsOfTruth(1000).b };
  return out;
}

/**
 * 手順式の窓の確認（FFR_EDITCHECK=steps。仮想血管。両方向の中心線を引いた直後から）。
 *  T1 中心線が両方向に引けると、手順 ②（解析範囲）は済み、［次へ］で ③（中心線）へ進み、③ の道具だけが見える
 *  T2 ⑤（アンカー）: 未確認の間は「0/3」で［次へ］が押せない。★負例: 確認前に押せない
 *  T2b ④（エッジ）が ⑤（アンカー）より前にある（手順の並び）
 *  T3 3 点とも動かして確認すると「3/3」になり、［次へ］が押せる
 *  T4 ★負例: ［3D に再構成］は ⑥ に進むまで見えず、⑥ では見える
 */
async function stepsCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const cur = async () => page.evaluate(() => Array.from(document.querySelectorAll("[data-testid^=dual-step-]")).filter((e) => e.getAttribute("aria-current") === "step").map((e) => e.getAttribute("data-testid")));
  const state = async (n: number) => (await page.getByTestId(`dual-step-${n}`).getAttribute("data-state")) ?? "";
  const lbl = async (n: number) => ((await page.getByTestId(`dual-step-${n}`).innerText()) ?? "").replace(/s+/g, " ").trim();
  const next = page.getByTestId("dual-next-step");
  const c0 = await cur();
  check("[T0] 前提: シリーズを選ぶと、手順 ② に進んでいる", c0.length === 1 && c0[0] === "dual-step-2", c0);
  check("[T1a] 中心線が両方向に引けると、手順 ② は済み、［次へ］が押せる", (await state(2)) === "done" && (await next.isEnabled()), { s2: await state(2) });
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-steps-1-range.png`) });
  await next.click();
  await page.waitForTimeout(250);
  const c1 = await cur();
  const vis3 = await page.getByTestId("dual-panel-step-3").isVisible();
  const vis2 = await page.getByTestId("dual-panel-step-2").isVisible();
  check("[T1b] ［次へ］で ③（中心線）へ進み、③ の道具だけが見える", c1[0] === "dual-step-3" && vis3 && !vis2, { c1, vis3, vis2 });
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-steps-2-centerline.png`) });
  const order = await page.evaluate(() => Array.from(document.querySelectorAll("[data-testid^=dual-step-]")).map((e) => (e.querySelector(".aq-lbl") as HTMLElement).textContent));
  check("[T2b] 手順の並びは、④ エッジ → ⑤ アンカー", /^エッジ/.test(String(order[3])) && /^アンカー/.test(String(order[4])), { order });
  await setStep(page, 5);
  const l4a = await lbl(5);
  check("[T2] ⑤: 未確認の間は「0/3」で、［次へ］が押せない（★負例）", /0\/3/.test(l4a) && !(await next.isEnabled()), { l4a, enabled: await next.isEnabled() });
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-steps-3-anchors-before.png`) });
  const a = await anchorsOf(page, "A");
  const b = await anchorsOf(page, "B");
  for (let i = 0; i < 3; i++) {
    await dragAnchor(page, "A", i, [a[i][0] + 2, a[i][1] + 2]);
    await dragAnchor(page, "B", i, [b[i][0] + 2, b[i][1] + 2]);
  }
  const l4b = await lbl(5);
  check("[T3] 3 点とも動かして確認すると「3/3」になり、［次へ］が押せる", /3\/3/.test(l4b) && (await next.isEnabled()), { l4b, enabled: await next.isEnabled() });
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-steps-4-anchors-after.png`) });
  const reconAt4 = await page.getByTestId("dual-recon").isVisible(); // ⑤ で見えないこと
  await setStep(page, 6);
  const reconAt6 = await page.getByTestId("dual-recon").isVisible();
  check("[T4] ★負例: ［3D に再構成］は ⑥ に進むまで見えず、⑥ では見える", !reconAt4 && reconAt6, { reconAt4, reconAt6 });
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-steps-5-recon.png`) });
  return out;
}

/**
 * 分岐部の窓の確認（FFR_EDITCHECK=bifui。2 方向窓ではなく、分岐部の窓から入る）。
 *  U1 ★負例: シリーズを選ぶ前は、役割ごとの［2 方向窓で定義する］が押せない
 *  U2 シリーズを選ぶと、3 つの役割（近位母血管・遠位母血管・側枝）それぞれに、押せる［2 方向窓で定義する］が出て、「未保存」と出る
 *  U3 ［近位母血管の定義］を押すと、2 方向窓が開き、同じ 2 シリーズが読み込まれ（両方向の状態欄にフレーム番号）、役割が「近位母血管」になり、手順 ② に進んでいる
 *  U4 2 方向窓の上に、その役割の定義の案内（向きの約束）が出る
 */
async function bifUiCheck(viewer: Page, imp: Record<"A" | "B", { study: string; series: string }>, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  await viewer.getByTestId("bif-panel").waitFor({ state: "visible", timeout: 10_000 });
  const defs = ["proximal", "distal", "side"];
  const dis = async () => Promise.all(defs.map(async (r) => await viewer.getByTestId(`bif-define-${r}`).isDisabled()));
  const before = await dis();
  await viewer.screenshot({ path: path.join(OUT_DIR, `${label}-bifui-1-before.png`) });
  check("[U1] ★負例: シリーズを選ぶ前は、役割ごとの［2 方向窓で定義する］が押せない", before.every((d) => d), { before });
  await viewer.getByTestId("bif-pick").click();
  await viewer.getByTestId("pickseries-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await viewer.waitForTimeout(1_000);
  for (const st of new Set([imp.A.study, imp.B.study])) {
    const exp = viewer.getByTestId(`pickseries-expand-${st}`);
    if ((await exp.count()) && (await exp.getAttribute("aria-expanded")) !== "true") await exp.click();
  }
  await viewer.waitForTimeout(800);
  await viewer.getByTestId(`pickseries-series-check-${imp.A.series}`).check();
  await viewer.getByTestId(`pickseries-series-check-${imp.B.series}`).check();
  await viewer.getByTestId("pickseries-ok").click();
  await viewer.waitForTimeout(2_000);
  const after = await dis();
  const texts = await Promise.all(defs.map(async (r) => ((await viewer.getByTestId(`bif-role-${r}`).innerText()) ?? "").replace(/s+/g, " ")));
  await viewer.screenshot({ path: path.join(OUT_DIR, `${label}-bifui-2-picked.png`) });
  check("[U2] シリーズを選ぶと、3 つの役割それぞれの［2 方向窓で定義する］が押せ、「未保存」と出る", after.every((d) => !d) && texts.every((t) => /未保存/.test(t)), { after, texts: texts.map((t) => t.slice(0, 30)) });
  await viewer.getByTestId("bif-define-proximal").click();
  await viewer.getByTestId("dual-panel").waitFor({ state: "visible", timeout: 10_000 });
  await viewer.waitForTimeout(4_000);
  const stA = await txt(viewer, "dual-status-A");
  const stB = await txt(viewer, "dual-status-B");
  const role = await viewer.getByTestId("dual-bif-role").inputValue();
  const cur = await viewer.evaluate(() => Array.from(document.querySelectorAll("[data-testid^=dual-step-]")).filter((e) => e.getAttribute("aria-current") === "step").map((e) => e.getAttribute("data-testid")));
  await viewer.screenshot({ path: path.join(OUT_DIR, `${label}-bifui-3-dual.png`) });
  check("[U3] ［近位母血管…］で 2 方向窓が開き、同じ 2 シリーズが読まれ、役割が近位母血管で、手順 ② にいる", /フレーム/.test(stA) && /フレーム/.test(stB) && role === "proximal" && cur[0] === "dual-step-2", { stA: stA.slice(0, 30), stB: stB.slice(0, 30), role, cur });
  const note = (await viewer.getByTestId("dual-preset-note").innerText().catch(() => "")) ?? "";
  check("[U4] 2 方向窓の上に、その役割の定義の案内（近位母血管・向きの約束）が出る", /近位母血管/.test(note) && /向き/.test(note), { note: note.slice(0, 60) });
  return out;
}

/**
 * 方向 B の始点・終点の候補（FFR_EDITCHECK=cands。仮想血管。方向 A の始点・終点だけを押す）。
 *  C1 B に、始点に対応するエピポーラ線と谷の候補が出て（data-cands）、真値（B の始点）から 6 px 以内の候補が 1 つ以上ある
 *  C2 その候補の輪の近く（画面 8 px ずらして）を押すと、候補の位置が始点になり、次は終点の候補（which=1）に変わる
 *  C3 終点の候補を押すと、B の中心線が引かれ、始点は候補の位置と一致（1.5 px 以内）、端が真値から 6 px 以内
 *  C4 ★負例: 候補から遠い所（画面 30 px 以上）を押すと、吸着せず、押した位置が始点になる（2 px 以内）
 *  C5 ★負例: チェックを切ると、候補が出ない（data-cands が空）
 */
async function candsCheck(page: Page, spec: Spec): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const cvB = page.getByTestId("dual-canvas-B");
  const cands = async (): Promise<{ which: number; line: number[][]; cands: [number, number, boolean, number][] } | null> => {
    const a = await cvB.getAttribute("data-cands");
    return a ? JSON.parse(a) : null;
  };
  const clB = async (): Promise<Pt[]> => JSON.parse((await cvB.getAttribute("data-clpts")) ?? "[]");
  const d = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  await setStep(page, 2);
  const c0 = await cands();
  await page.screenshot({ path: path.join(OUT_DIR, `${spec.label}-cands-1-start.png`) });
  const nearStart = c0 ? c0.cands.filter((c) => d([c[0], c[1]], spec.ends.B.start) <= 6) : [];
  check("[C1] B に、始点に対応するエピポーラ線と谷の候補が出て、真値の始点から 6 px 以内の候補がある", !!c0 && c0.which === 0 && c0.line.length === 2 && nearStart.length >= 1, { which: c0?.which, n: c0?.cands.length, near: nearStart.length });
  if (!c0 || nearStart.length === 0) return out;
  const startCand: Pt = [nearStart[0][0], nearStart[0][1]];
  const cs = await toClient(page, "B", startCand);
  await page.mouse.click(cs.x + 6, cs.y + 5);
  await page.waitForTimeout(600);
  const c1 = await cands();
  await page.screenshot({ path: path.join(OUT_DIR, `${spec.label}-cands-2-end.png`) });
  check("[C2] 候補の輪の近くを押すと、次は終点の候補（which=1）に変わる", !!c1 && c1.which === 1, { which: c1?.which });
  const nearEnd = c1 ? c1.cands.filter((c) => d([c[0], c[1]], spec.ends.B.end) <= 6) : [];
  if (!c1 || nearEnd.length === 0) {
    check("[C3] 終点の候補が真値の近くにある", false, { nearEnd: nearEnd.length });
    return out;
  }
  const endCand: Pt = [nearEnd[0][0], nearEnd[0][1]];
  const ce = await toClient(page, "B", endCand);
  await page.mouse.click(ce.x - 5, ce.y + 4);
  await page.waitForTimeout(1_500);
  const cl = await clB();
  await page.screenshot({ path: path.join(OUT_DIR, `${spec.label}-cands-3-drawn.png`) });
  const eS = cl.length ? d(cl[0], startCand) : NaN, eT = cl.length ? d(cl[cl.length - 1], spec.ends.B.end) : NaN;
  out.c3 = { n: cl.length, startToCandPx: +eS.toFixed(2), endToTruthPx: +eT.toFixed(2) };
  check("[C3] 終点の候補を押すと、B の中心線が引かれ、始点は候補の位置と一致し、端が真値から 6 px 以内", cl.length > 5 && eS <= 1.5 && eT <= 6, out.c3);

  // C4: 引き直して、候補から遠い、血管の上の点を始点として押す
  await page.getByTestId("dual-redefine-B").click();
  await page.waitForTimeout(400);
  const c2 = await cands();
  const box = await cvB.boundingBox();
  const truth = JSON.parse(fs.readFileSync(path.join(VV_DIR, "truth.json"), "utf8")).views.Case1_B.centerlinePx as Pt[];
  const far = truth[400] as Pt;
  const scale = (box?.width ?? 1) / IMG;
  const minScreen = c2 ? Math.min(...c2.cands.map((c) => d([c[0], c[1]], far) * scale)) : Infinity;
  const cf = await toClient(page, "B", far);
  await page.mouse.click(cf.x, cf.y);
  await page.waitForTimeout(500);
  const c3 = await cands();
  check("[C4] ★負例: 候補から遠い所（画面 30 px 以上）を押すと、吸着せず、押した位置が始点になる（次は終点の候補に変わり、候補の位置には動かない）", minScreen >= 30 && !!c3 && c3.which === 1, { minScreenPx: +minScreen.toFixed(1), which: c3?.which });
  // C5: チェックを切る
  await page.getByTestId("dual-redefine-B").click();
  await page.waitForTimeout(300);
  await page.getByTestId("dual-show-cands").uncheck();
  await page.waitForTimeout(400);
  const c5 = await cands();
  check("[C5] ★負例: チェックを切ると、候補が出ない", c5 === null, { c5: c5 ? "出ている" : "空" });
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
    if (process.env.FFR_EDITCHECK === "bifui") {
      await viewer.getByTestId("angio-quant-bif").click();
      report.editCheck = await bifUiCheck(viewer, imp, spec.label);
      fs.writeFileSync(path.join(OUT_DIR, `${spec.label}.json`), JSON.stringify({ ...report, checks: results }, null, 1));
      return;
    }
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
    // 中心線: 始点・終点をクリック。方向 B への自動提案は、propose の検査以外では切る（B の始点・終点を spec のとおりに置くため）。
    const proposeMode = process.env.FFR_EDITCHECK === "propose" || process.env.FFR_EDITCHECK === "cands";
    const autoPropose = viewer.getByTestId("dual-auto-propose");
    if (!proposeMode && (await autoPropose.count())) await autoPropose.uncheck();
    for (const k of (proposeMode ? ["A"] : ["A", "B"]) as ("A" | "B")[]) {
      for (const p of [spec.ends[k].start, spec.ends[k].end]) {
        const c = await toClient(viewer, k, p);
        await viewer.mouse.click(c.x, c.y);
        await viewer.waitForTimeout(400);
      }
      await viewer.waitForTimeout(1_500);
    }
    const sA = await txt(viewer, "dual-status-A");
    const sB = await txt(viewer, "dual-status-B");
    if (!proposeMode) check("[2] 両方向で中心線が引けた", /中心線を引きました/.test(sA) && /中心線を引きました/.test(sB), { sA: sA.slice(0, 120), sB: sB.slice(0, 120) });
    await viewer.screenshot({ path: path.join(OUT_DIR, `${spec.label}-1-centerlines.png`) });
    if (process.env.FFR_EDITCHECK) {
      // 2 方向窓の編集操作の実機確認（仮想血管）。アンカー・再構成には進まない。1 = エッジ、wp = 経由点の移動と A/B の連動。
      report.editCheck =
        process.env.FFR_EDITCHECK === "wp" ? await waypointCheck(viewer, spec.label)
        : process.env.FFR_EDITCHECK === "range" ? await rangeAnchorCheck(viewer, spec.label)
        : process.env.FFR_EDITCHECK === "end" ? await endpointCheck(viewer, spec.label)
        : process.env.FFR_EDITCHECK === "erase" ? await eraseCheck(viewer, spec.label)
        : process.env.FFR_EDITCHECK === "redef" ? await redefineCheck(viewer, spec.label)
        : process.env.FFR_EDITCHECK === "resize" ? await resizeCheck(viewer, spec.label)
        : process.env.FFR_EDITCHECK === "recenter" ? await recenterCheck(viewer, spec.label)
        : process.env.FFR_EDITCHECK === "steps" ? await stepsCheck(viewer, spec.label)
        : process.env.FFR_EDITCHECK === "esync" ? await edgeSyncCheck(viewer, spec.label)
        : process.env.FFR_EDITCHECK === "async" ? await anchorSyncCheck(viewer, spec.label)
        : process.env.FFR_EDITCHECK === "propose" ? await proposeCheck(viewer, spec)
        : process.env.FFR_EDITCHECK === "cands" ? await candsCheck(viewer, spec)
        : await editCheck(viewer, spec.label);
      fs.writeFileSync(path.join(OUT_DIR, `${spec.label}.json`), JSON.stringify({ ...report, checks: results }, null, 1));
      return;
    }

    // アンカーを 3 → 必要数へ（使う + 検算用）。
    await setStep(viewer, 5);
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

    await setStep(viewer, 6);
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

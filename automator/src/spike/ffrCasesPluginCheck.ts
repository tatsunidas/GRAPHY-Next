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
 * FFR_RESUME=1   解析状態の再開。DB の初期化でプラグイン保存領域だけ残し（keepPluginStore）、2 方向窓でシリーズを選んだところで止まる（自動で始点・終点・アンカーを置かない）。
 *                窓の［保存した解析状態を復元］で再開する。終わりの合図は FFR_MANUAL と同じ .results/ffr-plugin/manual-done。
 * FFR_DUALQFR=1  再構成のあと、2 方向窓の QFR 欄（Pa・流速モデル・計算・3D への色）を確かめる（`dualQfrCheck`）。
 * FFR_QFR3D=1   FFR_DUALQFR=1 のとき、QFR 結果ダイアログ（3D・図・造影像）を確かめる（`qfr3dCheck`）。FFR_QFR3D=0 で省く。QFR 窓から開く経路（D7-5）はこの値が 1 のときだけ。
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
  // 道具の行が高いと、画面の下側が表示領域の外になる。クリックの前に、画面が見えるところへスクロールする。
  const loc = page.getByTestId(`dual-canvas-${key}`);
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
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
  // 画面の 1 辺は窓の幅で決まる: 期待 = max(240, min((幅 − 36) / 2, max(320, 高さ − 32)))。上の道具の高さには左右されない（以前は 320 px に張り付いた）。
  const lay0 = out.layout0 as { w: number; h: number; size: number } | null;
  const expect0 = lay0 ? Math.max(240, Math.min(Math.floor((lay0.w - 36) / 2), Math.max(320, Math.floor(lay0.h - 32)))) : -1;
  check("[R6] 初期の窓で、画面の 1 辺は窓の幅で決まった値になり、320 px に張り付かない", !!lay0 && lay0.size === expect0 && (lay0.w < 800 || lay0.size > 330), { lay0, expect0 });
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
 * アンカーを手で動かしても相手が動かないことの確認（FFR_EDITCHECK=async。仮想血管）。旧版は［A/B で連動］で、B の同番号が弧長の対応で動いた。
 *  S1 連動がオンでも、A のアンカー 2 番を約 10% ずらすと、B の 2 番は動かない（旧版: 5 px 超動く＝旧 ui.js ではここが落ちる負例）
 *  S2 動かした A の 2 番は確認済み
 *  S3 補助線の基準が動かないので、B の 2 番から引いた線（A の画面）は動かない＝B のアンカーの位置が 0.01 px 以内で不変（S1 と同じ量を、別の見方で）
 *  S4 連動を切っても同じ（B の 2 番は動かない）
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
  const movedA = Math.hypot(a1[1][0] - a0[1][0], a1[1][1] - a0[1][1]);
  out.s1 = { movedAPx: +movedA.toFixed(2), movedBPx: +movedB.toFixed(4), wouldHaveGoneTo: expected, errIfSyncedPx: +err.toFixed(2) };
  check("[S1] 連動オンでも、A の 2 番を動かして（5 px 超）、B の 2 番は動かない（0.01 px 以内）", movedA > 5 && movedB < 0.01, out.s1);
  check("[S2] 動かした A の 2 番は確認済み", a1[1][2] === true, { a: a1[1] });
  const bAll = b1.every((x, k) => Math.hypot(x[0] - b0[k][0], x[1] - b0[k][1]) < 0.01);
  check("[S3] B の 3 点とも、位置も確認の有無も変わらない（A のアンカーを動かした前後）", bAll && b1.every((x, k) => x[2] === b0[k][2]), { b0, b1 });
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-async-1-on.png`) });
  // 負例: 連動を切る
  await page.getByTestId("dual-sync").uncheck();
  const target2 = cA[Math.floor(cA.length * 0.45)];
  await dragAnchor(page, "A", 1, target2);
  const b2 = await anchorsOf(page, "B");
  const a2 = await anchorsOf(page, "A");
  check("[S4] 連動を切っても、A の 2 番を動かして（5 px 超）B の 2 番は動かない", Math.hypot(a2[1][0] - a1[1][0], a2[1][1] - a1[1][1]) > 5 && Math.hypot(b2[1][0] - b1[1][0], b2[1][1] - b1[1][1]) < 0.01, { aMoved: Math.hypot(a2[1][0] - a1[1][0], a2[1][1] - a1[1][1]), bMoved: Math.hypot(b2[1][0] - b1[1][0], b2[1][1] - b1[1][1]) });
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
 *  T3b 検算用をオンにすると、同じ 3 組で「3/4」になり、［次へ］も［3D に再構成］も無効（数のそろい）。理由の 1 行が出る。4 組目を確認すると「4/4」で、［次へ］も［3D に再構成］も有効
 *      ★負例: 旧ビルドは「3/3」のまま［次へ］が有効になり、ここが落ちる
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
  // T3b: 検算用オン（4 組要る）。チェックは ⑥ の画面にあるので、⑥ で入れて ⑤ へ戻って読む。
  await setStep(page, 6);
  await page.getByTestId("dual-holdout").check();
  await setStep(page, 5);
  await page.waitForTimeout(300);
  const l5a = await lbl(5);
  const info5a = await txt(page, "dual-info");
  const nextA = await next.isEnabled();
  await setStep(page, 6);
  const reconA = await page.getByTestId("dual-recon").isEnabled();
  await setStep(page, 5);
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-steps-4b-holdout-3of4.png`) });
  await page.getByTestId("dual-add-anchor").click();
  await page.waitForTimeout(500);
  const a4 = await anchorsOf(page, "A"), b4 = await anchorsOf(page, "B");
  // 足したアンカーは、中心線の間に入る（番号は末尾とは限らない）。未確認のものを動かして確認する。
  const iNew = a4.findIndex((g) => !g[2]);
  await dragAnchor(page, "A", iNew, [a4[iNew][0] + 2, a4[iNew][1] + 2]);
  await dragAnchor(page, "B", iNew, [b4[iNew][0] + 2, b4[iNew][1] + 2]);
  const l5b = await lbl(5);
  const nextB = await next.isEnabled();
  await setStep(page, 6);
  const reconB = await page.getByTestId("dual-recon").isEnabled();
  await setStep(page, 5);
  check("[T3b] 検算用オン: 3 組では「3/4」で［次へ］・［3D に再構成］とも無効（理由の 1 行あり）。4 組目で「4/4」になり、どちらも有効", /3\/4/.test(l5a) && !nextA && !reconA && /4 組要ります/.test(info5a) && /4\/4/.test(l5b) && nextB && reconB, { l5a, nextA, reconA, info5a: info5a.slice(-80), l5b, nextB, reconB });
  await setStep(page, 6);
  await page.getByTestId("dual-holdout").uncheck();
  await setStep(page, 5);
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

/**
 * 画像ツール（パン・W/L・拡大・畳み・連動）の確認（FFR_EDITCHECK=imgtools。仮想血管。両方向の中心線がある状態から）。
 * 解析の状態の「指紋」（中心線・エッジ・径・アンカー・経由点・取り消しの可否）を、ツールの操作の前後で取って比べる。
 *  M1 ［＋］で拡大しても、解析の指紋は同じ
 *  M2 パン: ドラッグで data-view が動き、指紋は同じ
 *  M3 ★負例: パン中に画面をクリックしても、経由点は増えない（ツール中は解析が起きない）
 *  M4 W/L: ドラッグで data-wl が変わり、画面の平均輝度が変わり、指紋は同じ（径・エッジは W/L を読まない）
 *  M5 ページ送りしても W/L は保たれ、［W/L 自動］で自動に戻る
 *  M6 拡大: ドラッグで data-zoom が増え、押した点の下の画像が動かない（1 px 以内）。指紋は同じ
 *  M7 ★負例（検出器の確認）: ［解析］に戻して同じクリックをすると、経由点が増える（解析が効く）
 *  M8 ［道具を畳む］で、画面の 1 辺が増え、解析の指紋は同じ。クリック位置→画像座標の対応は 1.5 画面 px 以内
 *  M9 ★負例: A・B で同じ表示にそろえる、がオフなら、A のパンは B に写らない。オンなら写る
 */
async function imgToolsCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const cv = (k: "A" | "B") => page.getByTestId(`dual-canvas-${k}`);
  const at = async (k: "A" | "B", n: string) => (await cv(k).getAttribute(`data-${n}`)) ?? "";
  const finger = async (): Promise<string> => {
    const parts: string[] = [];
    for (const k of ["A", "B"] as const) for (const n of ["clpts", "edgepts", "diameters", "anchors", "waypoints", "edgeoffsets", "centerline", "range"]) parts.push(await at(k, n));
    parts.push(String(await page.getByTestId("dual-undo").isDisabled()), String(await page.getByTestId("dual-redo").isDisabled()));
    return parts.join("|");
  };
  const nWp = async (k: "A" | "B") => (JSON.parse((await at(k, "waypoints")) || "[]") as Pt[]).length;
  const mean = async (k: "A" | "B") =>
    page.evaluate((id) => {
      const c = document.querySelector(`[data-testid=${id}]`) as HTMLCanvasElement;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i];
      return s / (d.length / 4);
    }, `dual-canvas-${k}`);
  const view = async (k: "A" | "B") => (await at(k, "view")).split(",").map(Number) as [number, number];
  const drag = async (k: "A" | "B", dx: number, dy: number, from: [number, number] = [0.5, 0.5]) => {
    const b = (await cv(k).boundingBox())!;
    const x0 = b.x + b.width * from[0], y0 = b.y + b.height * from[1];
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + (dx * i) / 8, y0 + (dy * i) / 8);
    await page.mouse.up();
    await page.waitForTimeout(400);
  };

  // 準備: 経由点を 1 つ置いて、取り消し履歴を作る（解析の状態を、指紋に厚くする）
  await setMode(page, "waypoint");
  const clA: Pt[] = JSON.parse(await at("A", "clpts"));
  const cw = await toClient(page, "A", clA[Math.floor(clA.length * 0.4)]);
  await page.mouse.click(cw.x, cw.y);
  await page.waitForTimeout(800);
  const wp0 = await nWp("A");
  const fp0 = await finger();
  check("[M0] 前提: 経由点が置かれ、取り消しが効く状態", wp0 >= 1 && !(await page.getByTestId("dual-undo").isDisabled()), { wp0 });

  // M1: ［＋］
  await page.getByTestId("dual-zoom-in").click();
  await page.getByTestId("dual-zoom-in").click();
  await page.waitForTimeout(300);
  const z1 = Number(await at("A", "zoom"));
  check("[M1] ［＋］で拡大しても、解析の指紋は同じ", z1 > 1.4 && (await finger()) === fp0, { zoom: z1 });

  // M2/M3: パン
  await page.getByTestId("dual-tool-pan").click();
  const v0 = await view("A");
  await drag("A", -80, -60);
  const v1 = await view("A");
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-imgtools-1-pan.png`) });
  check("[M2] パン: ドラッグで画像が動き（data-view）、解析の指紋は同じ", Math.hypot(v1[0] - v0[0], v1[1] - v0[1]) > 10 && (await finger()) === fp0, { v0, v1 });
  const cw2 = await toClient(page, "A", clA[Math.floor(clA.length * 0.7)]);
  const bBefore = (await cv("A").boundingBox())!;
  void bBefore;
  await page.mouse.click(cw2.x, cw2.y);
  await page.waitForTimeout(600);
  check("[M3] ★負例: パン中に画面をクリックしても、経由点は増えず、指紋は同じ", (await nWp("A")) === wp0 && (await finger()) === fp0, { wp: await nWp("A"), wp0 });

  // M4/M5: W/L
  await page.getByTestId("dual-tool-wl").click();
  const m0 = await mean("A");
  const win0 = await at("A", "window");
  await drag("A", 70, -50);
  const m1 = await mean("A");
  const wl1 = await at("A", "wl");
  const win1 = await at("A", "window");
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-imgtools-2-wl.png`) });
  check("[M4] W/L: ドラッグで階調（data-wl・data-window）と画面の平均輝度が変わり、解析の指紋は同じ", wl1 !== "auto" && win1 !== win0 && Math.abs(m1 - m0) > 1 && (await finger()) === fp0, { wl1, win0, win1, mean0: +m0.toFixed(1), mean1: +m1.toFixed(1) });
  await setFrame(page, "A", 30);
  const wl2 = await at("A", "wl");
  await page.getByTestId("dual-wl-auto").click();
  await page.waitForTimeout(300);
  const wl3 = await at("A", "wl");
  await setFrame(page, "A", 37);
  check("[M5] ページ送りしても W/L は保たれ、［W/L 自動］で自動に戻る", wl2 === wl1 && wl3 === "auto" && (await finger()) === fp0, { wl1, wl2, wl3 });

  // M6: 拡大のドラッグ
  await page.getByTestId("dual-tool-zoom").click();
  const bb = (await cv("A").boundingBox())!;
  const fx = 0.3, fy = 0.6;
  const imgPt = async () => {
    const [ox, oy] = await view("A");
    const z = Number(await at("A", "zoom"));
    return [ox + (fx * IMG) / z, oy + (fy * IMG) / z] as Pt;
  };
  const p0 = await imgPt();
  const zb = Number(await at("A", "zoom"));
  await drag("A", 0, -90, [fx, fy]);
  const za = Number(await at("A", "zoom"));
  const p1 = await imgPt();
  void bb;
  check("[M6] 拡大: ドラッグ（上）で拡大し、押した点の下の画像が動かない（1 px 以内）。解析の指紋は同じ", za > zb * 1.2 && Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) <= 1 && (await finger()) === fp0, { zb, za, driftPx: +Math.hypot(p1[0] - p0[0], p1[1] - p0[1]).toFixed(2) });

  // M7: 解析に戻す
  await page.getByTestId("dual-tool-analyse").click();
  // 拡大・パンで見え方が変わっているので、全体表示に戻してから、血管の上の同じ画像の点を押す（古い画面座標を使わない）。
  await page.getByTestId("dual-zoom-reset").click();
  await page.waitForTimeout(300);
  const cw7 = await toClient(page, "A", clA[Math.floor(clA.length * 0.7)]);
  await page.mouse.click(cw7.x, cw7.y);
  await page.waitForTimeout(800);
  const wp7 = await nWp("A");
  check("[M7] ★負例（検出器の確認）: ［解析］に戻して同じクリックをすると、経由点が増える", wp7 === wp0 + 1 || wp7 > wp0, { wp0, wp7 });

  // M8: 畳む
  await page.getByTestId("dual-zoom-reset").click();
  const lay = async () => JSON.parse((await page.getByTestId("dual-panel").getAttribute("data-layout")) ?? "null") as { size: number; top: number; h: number };
  // 窓が低いと、畳んでも画面は下限（320 px）のままなので、可能なら表示領域を広げて、増えることを見る（Electron で効かなければ、そのまま）。
  await page.setViewportSize({ width: 1500, height: 1250 }).catch(() => undefined);
  await page.waitForTimeout(800);
  const l0 = await lay();
  const fp8 = await finger();
  await page.getByTestId("dual-collapse").click();
  await page.waitForTimeout(1_800);
  const l1 = await lay();
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-imgtools-3-collapsed.png`) });
  const target = clA[Math.floor(clA.length * 0.25)];
  const cm = await toClient(page, "A", target);
  const wpBefore = JSON.parse(await at("A", "waypoints")) as Pt[];
  await page.mouse.click(cm.x, cm.y);
  await page.waitForTimeout(700);
  const wpAfter = JSON.parse(await at("A", "waypoints")) as Pt[];
  const added = wpAfter.find((w) => !wpBefore.some((o) => Math.hypot(o[0] - w[0], o[1] - w[1]) < 0.05));
  const tol = (IMG / (await cv("A").boundingBox())!.width) * 1.5;
  const err = added ? Math.hypot(added[0] - target[0], added[1] - target[1]) : NaN;
  out.m8 = { size0: l0.size, size1: l1.size, errImgPx: +err.toFixed(2), tol: +tol.toFixed(2) };
  out.m8 = { ...(out.m8 as object), top0: l0.top, top1: l1.top, h: l1.h };
  check("[M8] ［道具を畳む］で、画面より上の部品の高さが減り、画面の 1 辺が増えるか同じ（下限・幅で頭打ちのとき）。クリック位置→画像座標の対応が 1.5 画面 px 以内（畳んだ状態でも解析が効く）", l1.top < l0.top && l1.size >= l0.size && err <= tol && fp8.length > 0, out.m8);
  await page.getByTestId("dual-collapse").click();
  await page.waitForTimeout(400);

  // M9: A・B の連動
  await page.getByTestId("dual-zoom-in").click();
  await page.getByTestId("dual-zoom-in").click();
  await page.getByTestId("dual-tool-pan").click();
  const b0 = await view("B");
  await drag("A", -60, -40);
  const b1 = await view("B");
  const offMoved = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]);
  await page.getByTestId("dual-view-link").check();
  await drag("A", -40, -30);
  const a2 = await view("A"), b2 = await view("B");
  check("[M9] ★負例: 連動がオフなら A のパンは B に写らず、オンなら写る", offMoved < 0.01 && Math.hypot(a2[0] - b2[0], a2[1] - b2[1]) < 0.5, { offMoved, a2, b2 });
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-imgtools-4-linked.png`) });
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

/**
 * 蛇行した仮想血管（~/graphy_sample_images/virtual-vessel-snake。FFR_VV_DIR で向ける）の、曲がりでのエッジ編集の確認（FFR_EDITCHECK=curve。方向 A）。
 *  C0 前提: 画面の中心線の最小の曲がり半径が、真値の投影の曲がり半径と 25% 以内で合う（うねりが画面に出ている）
 *  C1 一番きつい曲がりで「なぞる」: 右のエッジの 3 px 内側の線 → 曲がりの中ほど（±6 行）のオフセットが目標の 1 px 以内
 *  C2 曲がりのすぐ外で「点を動かす」: 目標（3 px 内側）の 1 px 以内で、符号（右 > 0）を保つ
 *  C3（記録のみ）折り返し（data-folds）の中ほどの数。予想は 0（曲がり半径 ÷ 半幅 ≒ 1）。合否にしない
 *  C4 ★負例: 血管から 40 px 離れた線をなぞっても、置き換わる行は 0（オフセット不変）
 */
async function curveCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const cv = page.getByTestId("dual-canvas-A");
  const attr = async (n: string) => JSON.parse((await cv.getAttribute(`data-${n}`)) ?? "null");
  const cl: Pt[] = await attr("clpts");
  const radiusAt = (c: Pt[], i: number, h = 4): number => {
    const a = c[Math.max(0, i - h)], b = c[i], d = c[Math.min(c.length - 1, i + h)];
    const abx = b[0] - a[0], aby = b[1] - a[1], bdx = d[0] - b[0], bdy = d[1] - b[1];
    const cross = Math.abs(abx * bdy - aby * bdx);
    const la = Math.hypot(abx, aby), lb = Math.hypot(bdx, bdy), lc = Math.hypot(d[0] - a[0], d[1] - a[1]);
    return cross < 1e-9 ? Infinity : (la * lb * lc) / (2 * cross); // 3 点を通る円の半径
  };
  const n = cl.length;
  let kb = Math.floor(n * 0.1);
  let rmin = Infinity;
  for (let i = Math.floor(n * 0.1); i < Math.floor(n * 0.9); i++) {
    const r = radiusAt(cl, i);
    if (r < rmin) { rmin = r; kb = i; }
  }
  const truth = JSON.parse(fs.readFileSync(path.join(VV_DIR, "truth.json"), "utf8")).views.Case1_A.centerlinePx as Pt[];
  let tmin = Infinity;
  for (let i = Math.floor(truth.length * 0.1); i < Math.floor(truth.length * 0.9); i += 2) tmin = Math.min(tmin, radiusAt(truth, i, 8));
  out.c0 = { screenMinRadiusPx: +rmin.toFixed(1), truthMinRadiusPx: +tmin.toFixed(1), row: kb, rows: n };
  check("[C0] 前提: 画面の中心線の最小の曲がり半径が、真値の投影と 25% 以内で合う（うねりが出ている）", Math.abs(rmin - tmin) / tmin <= 0.25, out.c0);

  await setMode(page, "edge");
  const snap = page.getByTestId("dual-snap-edge");
  if (await snap.count()) await snap.uncheck();
  const rc = page.getByTestId("dual-auto-recenter");
  if (await rc.count()) await rc.uncheck();
  const toolSel = page.getByTestId("dual-edge-tool");
  const rows = async () => ({ pts: (await attr("edgepts")) as number[][], off: (await attr("edgeoffsets")) as number[][] });
  const normalOf = (pts: number[][], i: number): Pt => {
    const l = Math.hypot(pts[i][2] - pts[i][0], pts[i][3] - pts[i][1]) || 1;
    return [(pts[i][2] - pts[i][0]) / l, (pts[i][3] - pts[i][1]) / l];
  };
  const atOff = (pts: number[][], i: number, d: number): Pt => {
    const c: Pt = [(pts[i][0] + pts[i][2]) / 2, (pts[i][1] + pts[i][3]) / 2];
    const nm = normalOf(pts, i);
    // 中心線の点そのものは edgepts に無いので、左右の点から、オフセット（左 < 0 < 右）の基準点を戻す
    return [c[0] + nm[0] * d, c[1] + nm[1] * d];
  };

  // C1: なぞる
  await toolSel.selectOption("trace");
  const r0 = await rows();
  const lo = Math.max(2, kb - 10), hi = Math.min(n - 3, kb + 10);
  const target = (i: number) => Math.max(1, r0.off[i][1] - 3);
  const line: Pt[] = [];
  for (let i = lo; i <= hi; i++) {
    const c: Pt = cl[i];
    const nm = normalOf(r0.pts, i);
    line.push([c[0] + nm[0] * target(i), c[1] + nm[1] * target(i)]);
  }
  const drawLine = async (pts: Pt[]) => {
    const first = await toClient(page, "A", pts[0]);
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    for (const p of pts.slice(1)) {
      const c = await toClient(page, "A", p);
      await page.mouse.move(c.x, c.y, { steps: 2 });
    }
    await page.mouse.up();
    await page.waitForTimeout(500);
  };
  await drawLine(line);
  const r1 = await rows();
  let replaced = 0;
  for (let i = lo; i <= hi; i++) if (Math.abs(r1.off[i][1] - r0.off[i][1]) > 0.05) replaced++;
  const errs: number[] = [];
  for (let i = kb - 6; i <= kb + 6; i++) errs.push(Math.abs(r1.off[i][1] - target(i)));
  out.c1 = { replaced, of: hi - lo + 1, maxErrPx: +Math.max(...errs).toFixed(2), medianErrPx: +errs.sort((a, b) => a - b)[Math.floor(errs.length / 2)].toFixed(2), leftMoved: r1.off.some((o, i) => Math.abs(o[0] - r0.off[i][0]) > 0.05) };
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-curve-1-trace.png`) });
  check("[C1] 一番きつい曲がりでなぞると、置き換わり、曲がりの中ほど（±6 行）のオフセットが目標の 1 px 以内（左は動かない）", replaced > 0 && Math.max(...errs) <= 1 && !(out.c1 as { leftMoved: boolean }).leftMoved, out.c1);

  // C2: 点を動かす（曲がりのすぐ外）
  await toolSel.selectOption("drag");
  const kd = Math.min(n - 4, hi + 6);
  const r2 = await rows();
  const want = Math.max(1, r2.off[kd][1] - 3);
  const from: Pt = [r2.pts[kd][2], r2.pts[kd][3]];
  const nm = normalOf(r2.pts, kd);
  const to: Pt = [from[0] + nm[0] * (want - r2.off[kd][1]), from[1] + nm[1] * (want - r2.off[kd][1])];
  const a = await toClient(page, "A", from);
  const b = await toClient(page, "A", to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 3 });
  await page.mouse.move(b.x, b.y, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const r3 = await rows();
  out.c2 = { row: kd, before: +r2.off[kd][1].toFixed(2), want: +want.toFixed(2), after: +r3.off[kd][1].toFixed(2) };
  check("[C2] 曲がりのすぐ外で点を動かすと、目標（3 px 内側）の 1 px 以内に動き、符号（右 > 0）を保つ", Math.abs(r3.off[kd][1] - want) <= 1 && r3.off[kd][1] > 0, out.c2);

  // C3: 折り返し（記録のみ）
  const folds = (await attr("folds")) ?? {};
  out.c3 = folds;
  log("[C3] 折り返し（記録のみ。予想は 0）", JSON.stringify(folds));

  // C4: 負例（遠い線）
  await toolSel.selectOption("trace");
  const r4 = await rows();
  const far: Pt[] = [];
  for (let i = lo; i <= hi; i++) {
    const nm4 = normalOf(r4.pts, i);
    far.push([cl[i][0] + nm4[0] * 40, cl[i][1] + nm4[1] * 40]);
  }
  await drawLine(far);
  const r5 = await rows();
  const changed = r5.off.filter((o, i) => Math.abs(o[1] - r4.off[i][1]) > 0.05 || Math.abs(o[0] - r4.off[i][0]) > 0.05).length;
  out.c4 = { changed };
  check("[C4] ★負例: 血管から 40 px 離れた線をなぞっても、置き換わる行は 0", changed === 0, out.c4);
  return out;
}

/**
 * ［A のアンカーを B に合わせる］［B のアンカーを A に合わせる］の確認（FFR_EDITCHECK=gsnap。仮想血管。連動は切る）。
 *  G0 前提: アンカー 1 番を A の中心線に沿って約 25 点ずらす。ドラッグは取り消しに積まれないので、［元に戻す］は無効
 *  G1 ［A のアンカーを B に合わせる］で、ずらす前の位置（B の 1 番から引いた線の交点）の近くへ戻る（ずらした位置より、元の位置に近づく）
 *  G2 ★取り消しに積まれる: ［元に戻す］が有効になる（積まない版では、G0 のまま無効で落ちる）
 *  G3 ［元に戻す］で、ずらした位置へ戻る（0.5 px 以内）
 *  G4 ★基準にした B のアンカーは、A を合わせる前後で動かない（0.01 px 以内）
 *  G5 逆向き: A を元の位置に戻し、B の 1 番を約 25 点ずらして［B のアンカーを A に合わせる］を押すと、B が元の位置の近くへ戻り、A は動かない
 */
async function gsnapCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  await setStep(page, 5);
  const sync = page.getByTestId("dual-sync");
  if (await sync.count()) await sync.uncheck();
  const cA: Pt[] = JSON.parse((await page.getByTestId("dual-canvas-A").getAttribute("data-clpts")) ?? "[]");
  const a0 = (await anchorsOf(page, "A"))[0];
  let bi = 0;
  cA.forEach((q, i) => { if (Math.hypot(q[0] - a0[0], q[1] - a0[1]) < Math.hypot(cA[bi][0] - a0[0], cA[bi][1] - a0[1])) bi = i; });
  const target = cA[Math.min(cA.length - 2, bi + 25)];
  await dragAnchor(page, "A", 0, target);
  const dragged = (await anchorsOf(page, "A"))[0];
  const undo = page.getByTestId("dual-undo");
  const dist = (p: readonly unknown[], q: readonly unknown[]) => Math.hypot(Number(p[0]) - Number(q[0]), Number(p[1]) - Number(q[1]));
  const bRef0 = (await anchorsOf(page, "B"))[0];
  out.g0 = { moved: +dist(dragged, a0).toFixed(1), undoDisabled: await undo.isDisabled() };
  check("[G0] 前提: アンカーを約 25 点ずらせた。ドラッグは取り消しに積まれない（［元に戻す］は無効）", dist(dragged, a0) > 5 && (await undo.isDisabled()), out.g0);

  await page.getByTestId("dual-snap-A").click();
  await page.waitForTimeout(500);
  const snapped = (await anchorsOf(page, "A"))[0];
  out.g1 = { toOrigBefore: +dist(dragged, a0).toFixed(1), toOrigAfter: +dist(snapped, a0).toFixed(1), movedFromDragged: +dist(snapped, dragged).toFixed(1) };
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-gsnap-1.png`) });
  check("[G1] ［A のアンカーを B に合わせる］で、ずらした位置から動き、元の位置（ガイドの交点）に近づく", dist(snapped, dragged) > 3 && dist(snapped, a0) < dist(dragged, a0), out.g1);
  check("[G2] ★合わせる操作は取り消しに積まれ、［元に戻す］が有効になる", !(await undo.isDisabled()), { undoDisabled: await undo.isDisabled() });
  await undo.click();
  await page.waitForTimeout(600);
  const back = (await anchorsOf(page, "A"))[0];
  out.g3 = { backToDraggedPx: +dist(back, dragged).toFixed(2) };
  check("[G3] ［元に戻す］で、アンカーがずらした位置へ戻る（0.5 px 以内）", dist(back, dragged) <= 0.5, out.g3);
  const bRef1 = (await anchorsOf(page, "B"))[0];
  check("[G4] ★基準にした B の 1 番は、A を合わせる前後と、取り消しのあとで動かない（0.01 px 以内）", dist(bRef1, bRef0) < 0.01, { moved: +dist(bRef1, bRef0).toFixed(4) });

  // 逆向き: A を元の位置へ戻して基準にし、B をずらして合わせる
  await dragAnchor(page, "A", 0, [Number(a0[0]), Number(a0[1])]);
  const aRef0 = (await anchorsOf(page, "A"))[0];
  const cB: Pt[] = JSON.parse((await page.getByTestId("dual-canvas-B").getAttribute("data-clpts")) ?? "[]");
  let bj = 0;
  cB.forEach((q, i) => { if (Math.hypot(q[0] - Number(bRef0[0]), q[1] - Number(bRef0[1])) < Math.hypot(cB[bj][0] - Number(bRef0[0]), cB[bj][1] - Number(bRef0[1]))) bj = i; });
  await dragAnchor(page, "B", 0, cB[Math.min(cB.length - 2, bj + 25)]);
  const bDragged = (await anchorsOf(page, "B"))[0];
  await page.getByTestId("dual-snap-B").click();
  await page.waitForTimeout(500);
  const bSnapped = (await anchorsOf(page, "B"))[0];
  const aRef1 = (await anchorsOf(page, "A"))[0];
  out.g5 = { toOrigBefore: +dist(bDragged, bRef0).toFixed(1), toOrigAfter: +dist(bSnapped, bRef0).toFixed(1), movedFromDragged: +dist(bSnapped, bDragged).toFixed(1), aMoved: +dist(aRef1, aRef0).toFixed(4) };
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-gsnap-2.png`) });
  check("[G5] 逆向き: ［B のアンカーを A に合わせる］で、B がずらした位置から動いて元の位置に近づき、基準の A は動かない", dist(bSnapped, bDragged) > 3 && dist(bSnapped, bRef0) < dist(bDragged, bRef0) && dist(aRef1, aRef0) < 0.01, out.g5);
  return out;
}

/**
 * 折り返し（中心線が行き来する所）の検出・表示・編集の停止の確認（FFR_EDITCHECK=fold。仮想血管の方向 A。連動は切る）。
 *  F0 前提: 素直な中心線では、中ほど（両端の 10% を除く）に折り返しは検出されない（検出器の負例）。
 *      両端は対象外: 始点・終点の押し位置が血管の端から少し外れると、先頭の数行が鉤形になり、実際に折り返す（実機で確認。赤い帯が出る）
 *  F1 経由点を 2 つ足し、前の経由点を血管の外へ 28 px ドラッグして、中心線を横へ迂回させる（鋭い V 字） → 中ほどに折り返しの区間が出る
 *  F2 折り返した行のエッジも動かせて（オフセットが変わる）、状態欄に折り返しの警告が残る（止めない仕様。旧ビルドでは動かず、ここが落ちる）
 *  F3 ★対照: 折り返していない行のエッジは、同じ操作で動く（操作が効いている）
 *  F4 ★負例: 経由点を戻して折り返しが無くなると、F2 と同じ行のエッジが動く（止めていたのは折り返しだけ）
 */
async function foldCheck(page: Page, label: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const cv = page.getByTestId("dual-canvas-A");
  const attr = async (n: string) => JSON.parse((await cv.getAttribute(`data-${n}`)) ?? "null");
  const folds = async (): Promise<{ left?: [number, number][]; right?: [number, number][] }> => (await attr("folds")) ?? {};
  const nFold = (f: { left?: [number, number][]; right?: [number, number][] }) => (f.left?.length ?? 0) + (f.right?.length ?? 0);
  const clA: Pt[] = await attr("clpts");
  const n = clA.length;

  const rowsN = ((await attr("edgepts")) as number[][]).length;
  const inner = (f: { left?: [number, number][]; right?: [number, number][] }) => ({ left: (f.left ?? []).filter(([a, b]) => a >= rowsN * 0.1 && b <= rowsN * 0.9), right: (f.right ?? []).filter(([a, b]) => a >= rowsN * 0.1 && b <= rowsN * 0.9) });
  const f0 = await folds();
  out.baseline = f0;
  check("[F0] 前提: 素直な中心線では、中ほどに折り返しは検出されない", nFold(inner(f0)) === 0, { all: f0, rows: rowsN });

  await setMode(page, "waypoint");
  const sync = page.getByTestId("dual-sync");
  if (await sync.count()) await sync.uncheck();
  for (const f of [0.45, 0.55]) {
    const c = await toClient(page, "A", clA[Math.floor(n * f)]);
    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(500);
  }
  const w0: Pt[] = (await attr("waypoints")) ?? [];
  const from = await toClient(page, "A", w0[0]);
  // 中心線に垂直な向きへ 28 px（画像 px）。
  const k0 = Math.floor(n * 0.45);
  const tg: Pt = [clA[k0 + 3][0] - clA[k0 - 3][0], clA[k0 + 3][1] - clA[k0 - 3][1]];
  const tl = Math.hypot(tg[0], tg[1]) || 1;
  const to = await toClient(page, "A", [w0[0][0] - (tg[1] / tl) * 28, w0[0][1] + (tg[0] / tl) * 28]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
  await page.mouse.up();
  await page.waitForTimeout(800);
  const f1 = inner(await folds());
  out.folds = f1;
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-fold-1-detected.png`) });
  check("[F1] 経由点を行き来させると、折り返しの区間が検出される（data-folds）", w0.length === 2 && nFold(f1) > 0, { waypoints: w0.length, folds: f1 });

  // エッジの編集（点を動かす）。吸着・寄せ直しは切る（オフセットだけを見る）。
  await setMode(page, "edge");
  const snap = page.getByTestId("dual-snap-edge");
  if (await snap.count()) await snap.uncheck();
  const rc = page.getByTestId("dual-auto-recenter");
  if (await rc.count()) await rc.uncheck();
  await page.getByTestId("dual-edge-tool").selectOption("drag");
  const dragEdge = async (row: number, side: "left" | "right"): Promise<{ before: number; after: number }> => {
    const pts: number[][] = await attr("edgepts");
    const off0: number[][] = await attr("edgeoffsets");
    const q = side === "left" ? [pts[row][0], pts[row][1]] : [pts[row][2], pts[row][3]];
    const s: Pt = [q[0], q[1]];
    const cl: Pt = clOf(row, pts);
    const dx = s[0] - cl[0], dy = s[1] - cl[1];
    const l = Math.hypot(dx, dy) || 1;
    const t: Pt = [s[0] + (dx / l) * 3, s[1] + (dy / l) * 3];
    const a = await toClient(page, "A", s);
    const b = await toClient(page, "A", t);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8);
    await page.mouse.up();
    await page.waitForTimeout(500);
    const off1: number[][] = await attr("edgeoffsets");
    return { before: off0[row][side === "left" ? 0 : 1], after: off1[row][side === "left" ? 0 : 1] };
  };
  const clOf = (row: number, pts: number[][]): Pt => [(pts[row][0] + pts[row][2]) / 2, (pts[row][1] + pts[row][3]) / 2];

  const run = f1.right?.[0] ?? f1.left?.[0];
  const side: "left" | "right" = f1.right?.length ? "right" : "left";
  const row = run ? Math.floor((run[0] + run[1]) / 2) : 0;
  const d2 = await dragEdge(row, side);
  const st = (await page.getByTestId("dual-status-A").textContent()) ?? "";
  out.blocked = { row, side, ...d2, status: st.slice(0, 160) };
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-fold-2-blocked.png`) });
  check("[F2] 折り返した行のエッジも動き（オフセットが 1 px 超変わる）、状態欄に折り返しの警告が残る", Math.abs(d2.after - d2.before) > 1 && /折り返/.test(st), out.blocked);

  const clean = Math.floor(n * 0.15);
  const d3 = await dragEdge(clean, "right");
  out.clean = { row: clean, ...d3 };
  check("[F3] ★対照: 折り返していない行のエッジは、同じ操作で動く", Math.abs(d3.after - d3.before) > 1, out.clean);

  // 経由点を消して折り返しを無くす → 同じ行が動く
  await setMode(page, "waypoint");
  for (const w of ((await attr("waypoints")) ?? []) as Pt[]) {
    const c = await toClient(page, "A", w);
    await page.mouse.click(c.x, c.y, { button: "right" });
    await page.waitForTimeout(500);
  }
  await setMode(page, "edge");
  const nf = nFold(inner(await folds()));
  const d4 = await dragEdge(Math.floor(n * 0.5), side);
  out.afterRemove = { folds: nf, ...d4 };
  check("[F4] ★負例: 経由点を戻して折り返しが無くなると、同じ辺りのエッジが動く", nf === 0 && Math.abs(d4.after - d4.before) > 1, out.afterRemove);
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-fold-3-cleared.png`) });
  return out;
}

/** 2 方向窓の［シリーズを選ぶ］で A → B の順に選ぶ。 */
async function pickAB(viewer: Page, imp: Record<"A" | "B", { study: string; series: string }>): Promise<void> {
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
}

/**
 * 解析状態の自動保存と再開の確認（FFR_EDITCHECK=resume。仮想血管。保存領域は起動時に空）。
 *  U0 前提: 保存済みは無く、復元ボタンは無効
 *  U1 経由点を足すと、数秒で「自動保存しました」と出る
 *  U2 同じ 2 シリーズを選び直すと、復元ボタンが「前回の解析状態（日時）を復元」になって有効。押すと、経由点が保存時の数に戻る
 *  U3 ★上書きの安全弁: 選び直して中心線を引き直し（保存済みは未復元）、経由点を足しても、「自動保存していません」と出る。
 *      復元すると、経由点が U1 の保存時の数に戻る（＝保存済みは上書きされていない）
 *  U4 復元したあとの変更は、再び自動保存される（「自動保存しました」）
 */
async function resumeCheck(page: Page, spec: Spec, imp: Record<"A" | "B", { study: string; series: string }>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const cvA = page.getByTestId("dual-canvas-A");
  const attr = async (n: string) => JSON.parse((await cvA.getAttribute(`data-${n}`)) ?? "null");
  const nWp = async (): Promise<number> => (((await attr("waypoints")) as Pt[] | null) ?? []).length;
  const persist = async (): Promise<string> => txt(page, "dual-persist");
  const restore = page.getByTestId("dual-restore-def");
  const addWaypointAt = async (f: number): Promise<void> => {
    await setMode(page, "waypoint");
    const cl: Pt[] = await attr("clpts");
    const c = await toClient(page, "A", cl[Math.floor(cl.length * f)]);
    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(600);
  };
  const redefine = async (): Promise<void> => {
    const autoPropose = page.getByTestId("dual-auto-propose");
    if (await autoPropose.count()) await autoPropose.uncheck();
    for (const k of ["A", "B"] as const) {
      await setFrame(page, k, spec.frames[k]);
      for (const p of [spec.ends[k].start, spec.ends[k].end]) {
        const c = await toClient(page, k, p);
        await page.mouse.click(c.x, c.y);
        await page.waitForTimeout(400);
      }
      await page.waitForTimeout(1_500);
    }
  };
  check("[U0] 前提: 保存済みは無く、復元ボタンは無効", !(await restore.isEnabled()), { enabled: await restore.isEnabled() });

  await addWaypointAt(0.5);
  const wpSaved = await nWp();
  await page.waitForTimeout(3_000);
  const p1 = await persist();
  out.u1 = { wpSaved, persist: p1.slice(0, 120) };
  check("[U1] 経由点を足すと、自動で保存される（「自動保存しました」）", wpSaved === 1 && /自動保存しました/.test(p1), out.u1);

  // 選び直し（定義は消える）→ 保存済みが見つかる
  await setStep(page, 1); // ［シリーズを選ぶ］は手順 ① の画面にある
  await pickAB(page, imp);
  const label2 = await restore.innerText();
  const enabled2 = await restore.isEnabled();
  const wpAfterPick = await nWp();
  await restore.click();
  await page.waitForTimeout(3_000);
  const wpRestored = await nWp();
  out.u2 = { label: label2, enabled: enabled2, wpAfterPick, wpRestored };
  check("[U2] 選び直すと「前回の解析状態（日時）を復元」が有効になり、押すと経由点が保存時の数に戻る", /前回の解析状態/.test(label2) && enabled2 && wpAfterPick === 0 && wpRestored === wpSaved, out.u2);
  await page.screenshot({ path: path.join(OUT_DIR, `${spec.label}-resume-2-restored.png`) });

  // ★上書きの安全弁
  await setStep(page, 1); // ［シリーズを選ぶ］は手順 ① の画面にある
  await pickAB(page, imp);
  const pendingNote = await persist();
  await redefine();
  await addWaypointAt(0.3);
  await addWaypointAt(0.7);
  const wpNew = await nWp();
  await page.waitForTimeout(3_500);
  const p3 = await persist();
  await restore.click(); // 保存済み（U1 の内容）を復元
  await page.waitForTimeout(3_000);
  const wpBack = await nWp();
  out.u3 = { pendingNote: pendingNote.slice(0, 100), wpNew, persistAfterEdit: p3.slice(0, 120), wpBack };
  check("[U3] ★上書きの安全弁: 保存済みが未復元の間に経由点を足しても「自動保存していません」と出て、復元すると保存時の数に戻る", wpNew === 2 && /自動保存していません/.test(p3) && !/自動保存しました/.test(p3) && wpBack === wpSaved, out.u3);

  // 復元後の変更は保存される
  await addWaypointAt(0.8);
  await page.waitForTimeout(3_500);
  const p4 = await persist();
  out.u4 = { persist: p4.slice(0, 120) };
  check("[U4] 復元したあとの変更は、再び自動保存される", /自動保存しました/.test(p4), out.u4);
  await page.screenshot({ path: path.join(OUT_DIR, `${spec.label}-resume-3-after.png`) });
  return out;
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
  // 結果ダイアログ（自動で開く）が 2 方向窓を覆っているので、先に閉じる。
  const resDlg = viewer.getByRole("dialog", { name: /QFR 結果/ });
  if ((await resDlg.count()) > 0) await resDlg.last().getByRole("button", { name: "×" }).click().catch(() => {});
  await viewer.waitForTimeout(300);
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
  // 2 方向窓で QFR を計算していると、その Pa がモデル単位の保存から QFR 窓に戻る（#101）。戻っているなら正例として数え、
  // 負例（Pa が空）は欄を空にして確かめる。
  q.paRestored = await viewer.getByTestId("qfr-pa").inputValue();
  if (process.env.FFR_DUALQFR === "1" && spec.pa !== undefined) {
    check("[Q1r] 2 方向窓で入れた Pa が、QFR 窓に戻っている", q.paRestored === String(spec.pa), { restored: q.paRestored, expected: spec.pa });
  }
  await viewer.getByTestId("qfr-pa").fill("");
  await viewer.waitForTimeout(300);
  q.runEnabledWithoutPa = await run.isEnabled();
  check("[Q1] ★Pa 未入力では「QFR を計算する」が無効（計算しない）", !q.runEnabledWithoutPa, { enabled: q.runEnabledWithoutPa, paRestoredBeforeClearing: q.paRestored });
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
      if (process.env.FFR_QFR3D === "1") q.qfr3d = await qfr3dFromQfrWindow(viewer, spec, outDir);
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

/**
 * 2 方向窓の QFR 欄（FFR_DUALQFR=1。再構成のあと）。
 *  D0 再構成のあと QFR 欄が出る
 *  D1 ★負例: Pa 未入力では［QFR を計算して 3D に色を乗せる］が無効で、理由に Pa が出る
 *  D2 ★負例: 近位端が未確認（FFR_PROXIMAL=none）なら、Pa を入れても無効で、理由に近位端が出る
 *  D3 シネが使えなければ cQFR / aQFR は選べず、理由が出る（単一フレームの仮想血管）。使えれば選べる
 *  D4 ★負例: 計算する前は、3D 画面に凡例も勾配も無い
 *  D5 fQFR: 計算すると数値が出て、「3D に色を乗せました」と出て、3D 画面に凡例と勾配が乗る
 *  D6 cQFR（シネが使えるときだけ。使えなければ未達）: フレームカウントの窓が開き、ROI が両端に置かれている。確定すると cQFR と fQFR が並ぶ
 */
async function dualQfrCheck(viewer: Page, spec: Spec, outDir: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const root = viewer.getByTestId("dual-qfr");
  const visible = await root.isVisible().catch(() => false);
  check("[D0] 再構成のあと、QFR 欄が出る", visible, { visible });
  if (!visible) return out;
  const run = viewer.getByTestId("dual-qfr-run");
  const note = viewer.getByTestId("dual-qfr-note");
  const geoPage = (): Page | undefined => viewer.context().pages().find((p) => p.url().includes("geometry3d"));
  await root.scrollIntoViewIfNeeded().catch(() => {});

  out.runEnabledNoPa = await run.isEnabled();
  out.noteNoPa = ((await note.textContent()) ?? "").slice(0, 120);
  // 理由の優先順は、モデル → 近位端 → Pa。近位端が未確認なら、Pa 未入力でも近位端の理由が先に出る。
  check("[D1] ★負例: Pa 未入力では計算ボタンが無効で、理由が出る（近位端が確認済みなら Pa、未確認なら近位端）", !out.runEnabledNoPa && (spec.proximal === "" ? /近位端/ : /Pa/).test(String(out.noteNoPa)), { enabled: out.runEnabledNoPa, note: out.noteNoPa });

  const contrastOpt = viewer.getByTestId("dual-qfr-velocity").locator('option[value="contrast"]');
  const contrastDisabled = await contrastOpt.isDisabled();
  out.contrastDisabled = contrastDisabled;
  out.cineNote = ((await viewer.getByTestId("dual-qfr-cine-note").textContent()) ?? "").slice(0, 200);
  if (contrastDisabled) check("[D3] シネが使えないので cQFR は選べず、理由が出る", /使えません/.test(String(out.cineNote)), { note: out.cineNote });
  else check("[D3] シネが使えるので cQFR を選べる（フレーム数・fps が出る）", /フレーム/.test(String(out.cineNote)) && /fps/.test(String(out.cineNote)), { note: out.cineNote });

  if (spec.pa === undefined) {
    results.push({ name: "[D4〜D6] Pa が仕様に無いので計算せず", ok: null });
    return out;
  }
  await viewer.getByTestId("dual-qfr-velocity").selectOption("fixed");
  await viewer.getByTestId("dual-qfr-pa").fill(String(spec.pa));
  await viewer.waitForTimeout(300);
  out.runEnabledWithPa = await run.isEnabled();
  out.noteWithPa = ((await note.textContent()) ?? "").slice(0, 160);
  if (spec.proximal === "") {
    check("[D2] ★負例: 近位端が未確認なら、Pa を入れても計算ボタンが無効で、理由に近位端が出る", !out.runEnabledWithPa && /近位端/.test(String(out.noteWithPa)), { enabled: out.runEnabledWithPa, note: out.noteWithPa });
    return out;
  }
  check("[D2] 近位端を選んであれば、Pa を入れると計算ボタンが有効になる", !!out.runEnabledWithPa, { enabled: out.runEnabledWithPa, note: out.noteWithPa });
  if (!out.runEnabledWithPa) return out;

  // 計算の前: 3D 画面は（再構成で）開いている。色も凡例も無いこと。
  const g0 = geoPage();
  if (!g0) {
    results.push({ name: "[D4] 3D 画面が開いていない（再構成の自動表示 H74 が働いていない）", ok: false, detail: viewer.context().pages().map((p) => p.url().slice(-40)) });
  } else {
    await g0.getByTestId("geometry3d-root").waitFor({ state: "visible", timeout: 30_000 });
    await g0.waitForTimeout(2_000);
    const s0 = await geo3dStats(g0);
    const lg0 = await g0.getByTestId("vessel-legend").count();
    out.before3d = { stats: s0, legend: lg0 };
    check("[D4] ★負例: 計算する前は、3D 画面に凡例も勾配も無い", lg0 === 0 && !!s0 && s0.neutral === 0, out.before3d);
  }

  await run.click();
  const val = viewer.getByTestId("dual-qfr-result").getByTestId("qfr-value");
  await val.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  out.value = ((await val.first().innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
  const put = ((await viewer.getByTestId("dual-qfr-put").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  out.put = put.slice(0, 160);
  await viewer.screenshot({ path: path.join(outDir, `${spec.label}-4-dualqfr.png`) });
  const g1 = geoPage();
  if (g1) {
    await g1.waitForTimeout(3_500);
    const s1 = await geo3dStats(g1);
    const lg1 = await g1.getByTestId("vessel-legend").count();
    out.after3d = { stats: s1, legend: lg1 };
    await g1.screenshot({ path: path.join(outDir, `${spec.label}-4-dualqfr-3d.png`) }).catch(() => {});
    check("[D5] fQFR: 数値が出て、「3D に色を乗せました」と出て、3D 画面に凡例と勾配が乗る", /\d\.\d{2,}/.test(String(out.value)) && /3D に色を乗せました/.test(put) && lg1 === 1 && !!s1 && s1.neutral > 0 && s1.cool > 0, { value: out.value, put: out.put, after3d: out.after3d });
  } else {
    check("[D5] fQFR: 3D 画面に色が乗る", false, { value: out.value, put: out.put, note: "3D 画面が見つからない" });
  }

  if (process.env.FFR_QFR3D !== "0") {
    const distal = ((await viewer.getByTestId("dual-qfr-result").getByTestId("qfr-primary").first().innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
    out.qfr3d = await qfr3dCheck(viewer, spec, outDir, distal);
  }

  if (contrastDisabled) {
    results.push({ name: "[D6] cQFR: シネが使えないため未実施（フレームカウントの窓は開けない）", ok: null, detail: out.cineNote });
    return out;
  }
  await viewer.getByTestId("dual-qfr-velocity").selectOption("contrast");
  const reuse = viewer.getByTestId("dual-qfr-reuse");
  if (await reuse.isVisible().catch(() => false)) await reuse.uncheck();
  await run.click();
  const tdc = viewer.getByTestId("tdc-panel");
  await tdc.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  await viewer.waitForTimeout(2_500);
  const tdcText = ((await tdc.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  out.tdcOpened = await tdc.isVisible().catch(() => false);
  out.roiPreset = /近位端 設定済み/.test(tdcText) && /遠位端 設定済み/.test(tdcText);
  await viewer.screenshot({ path: path.join(outDir, `${spec.label}-5-tdc.png`) });
  check("[D6-1] cQFR: フレームカウントの窓が開き、ROI が両端に置かれている", !!out.tdcOpened && !!out.roiPreset, { opened: out.tdcOpened, preset: out.roiPreset, text: tdcText.slice(0, 160) });
  if (!out.tdcOpened) return out;
  await viewer.getByTestId("tdc-build").click();
  await viewer.getByTestId("tdc-confirm").waitFor({ state: "visible", timeout: 180_000 }).catch(() => {});
  const cand = ((await tdc.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  out.candidates = (cand.match(/候補[^。]{0,30}/g) ?? []).slice(0, 4);
  await viewer.screenshot({ path: path.join(outDir, `${spec.label}-5-tdc-curve.png`) });
  // 候補が出なかった（造影の流入が無いデータ）ときは、手入力のフレームで確定する経路を確かめる。候補の検出そのものは未達として分けて数える。
  const frameInputs = tdc.locator('input[type="number"]');
  const vals = await frameInputs.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  out.frameInputsBefore = vals;
  if (vals.length === 2 && vals.some((v) => v === "")) {
    results.push({ name: "[D6-3] 立ち上がりの候補（自動）: この検査データ（造影の流入が無い雑音のシネ）では出ないため未達。実症例で確かめる", ok: null, detail: { frameInputs: vals } });
    await frameInputs.nth(0).fill("6");
    await frameInputs.nth(1).fill("30");
  }
  await viewer.getByTestId("tdc-confirm").click();
  await viewer.getByTestId("dual-qfr-result").getByTestId("qfr-velocity-compare").waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  const cmp = ((await viewer.getByTestId("qfr-velocity-compare").first().innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
  out.compare = cmp.slice(0, 200);
  const put2 = ((await viewer.getByTestId("dual-qfr-put").textContent().catch(() => "")) ?? "").replace(/\s+/g, " ");
  await viewer.screenshot({ path: path.join(outDir, `${spec.label}-5-cqfr.png`) });
  check("[D6-2] cQFR: 確定すると cQFR と fQFR が並び、3D に色を乗せた", /cQFR/.test(cmp) && /fQFR/.test(cmp) && /3D に色を乗せました/.test(put2), { compare: out.compare, put: put2.slice(0, 120) });
  return out;
}

/**
 * QFR 結果ダイアログ（3D・図・造影像）。2 方向窓の fQFR 計算のあと、自動で開く。
 *  D7-1 ダイアログが開き、3D の canvas に色のある画素がある（空でない）
 *  D7-2 プルバック図をクリックすると距離が位置に比例して動き、QFR が単調に下がり、右端では結果欄の QFR と一致する
 *  D7-3 3D の管（色のある画素）をクリックするとカーソルが動き、その画素の色相が表示中の QFR の色と合う
 *  D7-4 造影像 A/B の位置の印が、近位端（arc=0）で青い側・遠位端（arc=L）でもう一方の側に出る（向きの確認。FFR_PROXIMAL=end でも同じ）
 */
const RAMP: readonly (readonly [number, number, number])[] = [
  [0.85, 0.11, 0.09], [0.95, 0.52, 0.09], [0.95, 0.87, 0.15], [0.3, 0.76, 0.33], [0.15, 0.44, 0.86],
];
function rampRgb(q: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, (q - 0.6) / 0.4));
  const pos = t * 4, i = Math.min(3, Math.floor(pos)), f = pos - i;
  return [0, 1, 2].map((k) => (RAMP[i][k] + (RAMP[i + 1][k] - RAMP[i][k]) * f) * 255) as [number, number, number];
}
const cosine = (a: number[], b: number[]): number => {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return d / (Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]) || 1);
};

async function qfr3dCheck(viewer: Page, spec: Spec, outDir: string, distalText: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const dlg = viewer.getByTestId("qfr3d-dialog").last();
  await dlg.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  const opened = await dlg.isVisible().catch(() => false);
  check("[D7-1a] QFR を計算すると、結果ダイアログが開く", opened, { opened });
  if (!opened) return out;
  await viewer.waitForTimeout(3_000); // 造影像の読み込み
  const cv = viewer.getByTestId("qfr3d-canvas").last();
  const canvasStats = async (): Promise<{ w: number; h: number; nonBg: number; sat: number; pick: { x: number; y: number } | null; rgb: number[] | null }> =>
    JSON.parse((await viewer.evaluate(`(() => {
      const cs = document.querySelectorAll('[data-testid="qfr3d-canvas"]');
      const c = cs[cs.length - 1];
      const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
      const x = t.getContext('2d'); x.drawImage(c, 0, 0);
      const d = x.getImageData(0, 0, t.width, t.height).data;
      let nonBg = 0, sat = 0; const xs = []; const ys = [];
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (Math.abs(r - 23) > 6 || Math.abs(g - 26) > 6 || Math.abs(b - 31) > 6) nonBg++;
        if (Math.max(r, g, b) - Math.min(r, g, b) > 60) { sat++; const p = i / 4; xs.push(p % t.width); ys.push(Math.floor(p / t.width)); }
      }
      let pick = null, rgb = null;
      if (xs.length) {
        const order = xs.map((v, i) => i).sort((a, b) => xs[a] - xs[b]);
        const k = order[Math.floor(order.length / 2)];
        pick = { x: xs[k], y: ys[k] };
        const rect = c.getBoundingClientRect();
        pick = { x: rect.left + (xs[k] + 0.5) / c.width * rect.width, y: rect.top + (ys[k] + 0.5) / c.height * rect.height };
        const o = (ys[k] * t.width + xs[k]) * 4; rgb = [d[o], d[o + 1], d[o + 2]];
      }
      return JSON.stringify({ w: t.width, h: t.height, nonBg, sat, pick, rgb });
    })()`)) as string);
  const st = await canvasStats();
  out.canvas = st;
  await viewer.screenshot({ path: path.join(outDir, `${spec.label}-6-qfr3d.png`) });
  check("[D7-1] 3D の canvas に色のある画素がある（空でない）", st.sat >= 200 && st.nonBg > st.sat, st);

  const txt = async (id: string): Promise<string> => ((await viewer.getByTestId(id).last().innerText({ timeout: 3_000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const slider = viewer.getByTestId("qfr3d-slider").last();
  const L = Number(await slider.getAttribute("max"));
  const setArc = async (v: number): Promise<void> => {
    await slider.evaluate((el, val) => { (el as HTMLInputElement).value = String(val); el.dispatchEvent(new Event("input", { bubbles: true })); }, v);
    await viewer.waitForTimeout(150);
  };
  const numOf = (s: string): number => Number(s.replace(/[^0-9.\-]/g, ""));

  // D7-2: プルバック図
  const ov = viewer.getByTestId("qfr3d-chart-qfr").last();
  const bb = (await ov.boundingBox())!;
  const clickAt = async (f: number): Promise<{ arc: number; qfr: string }> => {
    await viewer.mouse.click(bb.x + 44 + f * (bb.width - 44 - 12), bb.y + bb.height / 2);
    await viewer.waitForTimeout(150);
    return { arc: numOf(await txt("qfr3d-v-arc")), qfr: await txt("qfr3d-v-qfr") };
  };
  const c1 = await clickAt(0.25);
  const c2 = await clickAt(0.75);
  const c3 = await clickAt(1.0);
  out.chartClicks = { L, c1, c2, c3 };
  const prop = Math.abs(c1.arc - 0.25 * L) < 0.6 && Math.abs(c2.arc - 0.75 * L) < 0.6 && Math.abs(c3.arc - L) < 0.6;
  // 🔴 単調減少は期待しない: 狭窄の後ろでは圧の回復で QFR が 0.02 ほど戻る（モデルの pullback 自体がそう。単体で確認済み）。
  const mono = Number(c1.qfr) > Number(c3.qfr) && Number(c1.qfr) <= 1 && Number(c3.qfr) > 0.6 && Number(c2.qfr) > 0.6 && Number(c2.qfr) <= 1;
  check("[D7-2a] 図のクリック位置に比例して距離が動く（25%・75%・右端）", prop, out.chartClicks);
  check("[D7-2b] QFR が近位（25%）より遠位（右端）で小さく、すべて 0.6〜1 に収まる", mono, out.chartClicks);
  check("[D7-2c] 右端の QFR が、結果欄の QFR（3 桁）と一致する", c3.qfr === distalText.trim(), { cursor: c3.qfr, result: distalText });

  // D7-3: 3D の管をクリック
  await setArc(0);
  const before = numOf(await txt("qfr3d-v-arc"));
  const st2 = await canvasStats();
  if (!st2.pick) {
    check("[D7-3] 3D の管をクリックするとカーソルが動く", false, { note: "色のある画素が無く、クリック位置を決められない" });
  } else {
    await viewer.mouse.click(st2.pick.x, st2.pick.y);
    await viewer.waitForTimeout(300);
    const after = numOf(await txt("qfr3d-v-arc"));
    const qv = Number(await txt("qfr3d-v-qfr"));
    const cs = cosine(st2.rgb ?? [0, 0, 0], rampRgb(qv));
    out.pick3d = { before, after, qfr: qv, rgb: st2.rgb, cosine: cs };
    check("[D7-3a] 3D の管をクリックすると、カーソルが動く", Math.abs(after - before) > 1, out.pick3d);
    check("[D7-3b] クリックした画素の色相が、表示中の QFR の色と合う（コサイン類似度 > 0.95）", cs > 0.95, out.pick3d);
  }

  // D7-4: 造影像の印の向き
  const angio = async (k: "A" | "B"): Promise<{ white: number[] | null; blue: number[] | null; far: number[] | null } | null> => {
    const raw = await viewer.evaluate(`(() => {
      const cs = document.querySelectorAll('[data-testid="qfr3d-angio-${k}"]'); const c = cs[cs.length - 1];
      if (!c) return null;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const acc = { white: [0, 0, 0], blue: [0, 0, 0], far: [0, 0, 0] };
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], p = i / 4, x = p % c.width, y = Math.floor(p / c.width);
        const k = (r > 230 && b > 200 && g < 90) ? 'white' : (b > r + 50 && b > g) ? 'blue' : (Math.max(r, g, b) - Math.min(r, g, b) > 60) ? 'far' : null;
        if (k) { acc[k][0] += x; acc[k][1] += y; acc[k][2]++; }
      }
      const f = (a) => a[2] ? [a[0] / a[2], a[1] / a[2], a[2]] : null;
      return JSON.stringify({ white: f(acc.white), blue: f(acc.blue), far: f(acc.far) });
    })()`);
    return raw ? JSON.parse(raw as string) : null;
  };
  const dist = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const orient: Record<string, unknown> = {};
  let okAll = true;
  // 🔴 向きの正解は、検査入力の始点・終点（画像座標。プラグインの計算とは独立）から取る。印と色は同じ配列で描かれるので、
  //    配列の向きを取り違えても D7-4 は通る。画像上で「青い側 → もう一方の側」の向きが、始点→終点（近位が始点）またはその逆（近位が終点）に合うかを見る。
  //    切り出しは拡大・平行移動だけで反転しないので、向きは保たれる。
  let okTruth = true;
  const truth: Record<string, unknown> = {};
  for (const k of ["A", "B"] as const) {
    await setArc(0);
    const p = await angio(k);
    if (p?.blue && p.far) {
      const e = spec.ends[k];
      const along = (p.far[0] - p.blue[0]) * (e.end[0] - e.start[0]) + (p.far[1] - p.blue[1]) * (e.end[1] - e.start[1]);
      const want = spec.proximal === "end" ? along < 0 : along > 0;
      truth[k] = { along, proximal: spec.proximal, ok: want };
      if (!want) okTruth = false;
    } else {
      okTruth = false;
      truth[k] = { note: "青い側または他方の色が無い" };
    }
    await setArc(L);
    const d = await angio(k);
    orient[k] = { prox: p, dist: d };
    if (!p?.white || !p.blue || !p.far || !d?.white || !d.blue || !d.far) { okAll = false; continue; }
    if (!(dist(p.white, p.blue) < dist(p.white, p.far) && dist(d.white, d.far) < dist(d.white, d.blue))) okAll = false;
  }
  out.orient = orient;
  await viewer.screenshot({ path: path.join(outDir, `${spec.label}-6-qfr3d-end.png`) });
  check("[D7-4] 造影像 A/B の位置の印が、近位端（arc=0）で青い側・遠位端（arc=L）でもう一方の側に出る", okAll, orient);
  check("[D7-4b] ★向きの正解（検査入力の始点・終点）と照らして、青い側が近位端になっている（A・B とも）", okTruth, truth);

  // 見せたい物が写っているかを目で確かめるため、要素ごとに撮る（ダイアログの下側は画面の外になる）。
  await setArc(0.55 * L);
  for (const [id, name] of [["qfr3d-canvas", "3d"], ["qfr3d-angio-A", "angioA"], ["qfr3d-angio-B", "angioB"], ["qfr3d-section", "section"], ["qfr3d-chart-qfr", "chart"]] as const) {
    await viewer.getByTestId(id).last().screenshot({ path: path.join(outDir, `${spec.label}-6-qfr3d-el-${name}.png`) }).catch(() => {});
  }
  // 後の検査（cQFR など）の邪魔にならないよう閉じる。
  await viewer.getByRole("dialog", { name: /QFR 結果/ }).last().getByRole("button", { name: "×" }).click().catch(() => {});
  await viewer.waitForTimeout(300);
  return out;
}

/** QFR 窓（別窓）から開いたとき: 造影像は出さず、断面は等価径の円。 */
async function qfr3dFromQfrWindow(viewer: Page, spec: Spec, outDir: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const btn = viewer.getByTestId("qfr-open3d");
  const has = await btn.isVisible().catch(() => false);
  check("[D7-5a] QFR 窓の結果に［QFR 結果を 3D で見る］がある", has, { has });
  if (!has) return out;
  await btn.click();
  const dlg = viewer.getByTestId("qfr3d-dialog").last();
  await dlg.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await viewer.waitForTimeout(1_500);
  const text = ((await dlg.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
  out.angioNote = /2 方向窓の QFR 欄から開いたときに出ます/.test(text);
  out.circleNote = /等価径の円/.test(text);
  out.angioCanvases = await viewer.getByTestId("qfr3d-angio-A").count();
  await viewer.screenshot({ path: path.join(outDir, `${spec.label}-7-qfr3d-from-qfr-window.png`) });
  check("[D7-5b] 造影像は出さず理由を書き、断面は等価径の円で示す", !!out.angioNote && !!out.circleNote && out.angioCanvases === 0, out);
  await viewer.getByRole("dialog", { name: /QFR 結果/ }).last().getByRole("button", { name: "×" }).click().catch(() => {});
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
    await resetDb(driver.ports.http, { keepPluginStore: process.env.FFR_RESUME === "1" });
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
    await pickAB(viewer, imp);
    const stA0 = await txt(viewer, "dual-status-A");
    const stB0 = await txt(viewer, "dual-status-B");
    check("[1] 2 方向が読み込まれた", /フレーム/.test(stA0) && /フレーム/.test(stB0), { stA0: stA0.slice(0, 80), stB0: stB0.slice(0, 80) });

    if (process.env.FFR_RESUME === "1") {
      // 解析状態の再開（保存領域を消さずに起動）。自動で始点・終点・アンカーを置かず、利用者が［保存した解析状態を復元］する。
      const note = await txt(viewer, "dual-persist");
      const restoreText = await viewer.getByTestId("dual-restore-def").innerText().catch(() => "");
      report.resume = { persist: note.slice(0, 200), restoreButton: restoreText, restoreEnabled: await viewer.getByTestId("dual-restore-def").isEnabled().catch(() => false) };
      log("【再開】保存済みの通知:", note.slice(0, 200), "／ 復元ボタン:", restoreText);
      await viewer.screenshot({ path: path.join(OUT_DIR, `${spec.label}-resume-1-opened.png`) });
      const marker = path.join(OUT_DIR, "manual-done");
      fs.rmSync(marker, { force: true });
      const limitS = Number(process.env.FFR_MANUAL_TIMEOUT_S ?? "2700");
      log(`【再開】窓で［保存した解析状態を復元］して続けてください。終わったら ${marker} を作ってください（最大 ${limitS} 秒待ちます）。`);
      const deadline = Date.now() + limitS * 1000;
      while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2_000));
      fs.writeFileSync(path.join(OUT_DIR, `${spec.label}.json`), JSON.stringify({ ...report, checks: results }, null, 1));
      return;
    }
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
        : process.env.FFR_EDITCHECK === "imgtools" ? await imgToolsCheck(viewer, spec.label)
        : process.env.FFR_EDITCHECK === "fold" ? await foldCheck(viewer, spec.label)
        : process.env.FFR_EDITCHECK === "gsnap" ? await gsnapCheck(viewer, spec.label)
        : process.env.FFR_EDITCHECK === "curve" ? await curveCheck(viewer, spec.label)
        : process.env.FFR_EDITCHECK === "resume" ? await resumeCheck(viewer, spec, imp)
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
        await viewer.getByTestId("dual-snap-A").click();
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

    if (process.env.FFR_DUALQFR === "1") report.dualQfr = await dualQfrCheck(viewer, spec, OUT_DIR);

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

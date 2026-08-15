/*
 * 3D QCA（A6a）の実機検証 — `fw/angio-design.md` §10.1 / §10.2 / §16.3。
 *
 * 準備:  cd bench && python3 make_phantom_xa.py --out ./phantom
 *        cd backend && mvn -q -Dfrontend.skip=true -DskipTests package
 * 実行:  cd automator && npx tsx src/spike/xa3dQcaCheck.ts
 *
 * <h3>これで何が新しく言えるか</h3>
 * vitest は**真値の中心線を投影したもの**を入力にしているので、「対応付けと三角測量が正しい」
 * までしか言えない。ここでは **DICOM を読み込み、画像から中心線を抽出し**、その中心線で
 * 3D 再構成する。つまり
 * - 装置タグ（角度・SID/SOD・ImagerPixelSpacing）を**実際に読めているか**
 * - **画像から抽出した中心線**でも 3D の長さが真値に合うか
 * が初めて分かる。
 *
 * <h3>⚠️ ここでも検証できないもの</h3>
 * DICOM の角度定義そのもの。ファントムは `xaGeometry.ts` と同じ規約で作ってあるので、
 * 規約が間違っていても一致する（truth.json の `caveat`）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs, findBlockingOverlay } from "../common/dismissDialogs.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";

const REPO_ROOT = path.resolve(AUTOMATOR_ROOT, "..");
const PHANTOM_DIR = path.join(REPO_ROOT, "bench", "phantom", "GNBP-XA");
const TRUTH_PATH = path.join(PHANTOM_DIR, "truth.json");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-3dqca");
const HOST = "viewer2d-canvas-host";

/** 設計 §16.3 の目標。未達は隠さず `unmet` として別枠で数える（xaPhantomCheck と同じ方針）。 */
const TARGET_LENGTH_ERROR_PCT = 3.0;
const TARGET_ANCHOR_REPROJ_PX = 2.0;
/** 抽出された 2D 中心線が真値からどれだけ離れてよいか [px]。 */
const TOL_CENTERLINE_PX = 3.0;
/**
 * 🚨 **既知の系統誤差**: 半値法を円柱投影に当てると直径は約 13% 過小に出る（§16.4）。
 * 断面積はその 2 乗で効く。**目標未達を「合格」に書き換えないための基準値**でもある。
 */
const KNOWN_DIAMETER_FACTOR = 0.870;

/**
 * 解析する区間（主枝の真値点列のインデックス）。
 *
 * <h3>🚨 なぜ血管全体を解析しないのか — 2 つの別々の理由</h3>
 * **① 探索窓**: QCA の自動中心線（`tracePath`）は、始点と終点の外接矩形を
 * ±{@link TRACER_MARGIN_PX} 広げた窓の中しか探索しない。GNBP-XA-3 の螺旋は弦から最大 189px
 * 離れるので窓の外へ出てしまう（実測: 全体を指定すると 3D 長さが 36% 短く出た）。
 *
 * **② 短縮（フォアショートニング）**: こちらのほうが厄介で、最初に見落とした。
 * 弦からの外れ（横方向のふくらみ）だけを基準に区間を選んだところ、方向 B で
 * **真値の弧長 184px に対して抽出された中心線が 105px**（＝ほぼ弦の長さ）になった。
 * 中心線は真値から RMS 0.61px しか離れておらず、**血管の上には乗っている**。
 * つまり視線方向に潰れた区間では**投影が自分自身の上を往復する**ので、
 * 直進する近道が最初から最後まで血管画素の上を通ってしまう。
 * これは実装の不備ではなく**投影の原理的な曖昧さ**で、人が見ても辿れない。
 *
 * <p>したがって区間は「弦からの外れが窓に収まる」だけでなく
 * 「**どちらの方向でも弧長/弦長が 1 に近い**」ことで選ぶ。5〜25 は
 * 弧長/弦長が 1.086（A）/ 1.113（B）、弦からの外れが 26.9px / 9.7px で、3D 長さは 63.1mm。
 *
 * <p>💡 これは臨床の「ワーキングアングルを選ぶ」——**対象が短縮しない 2 方向を選ぶ**——
 * そのものである。3D QCA の前提条件として UI にも出すべき（残件）。
 */
const SEG_FROM = 5;
const SEG_TO = 25;
/** `qca.ts` の `tracePath` / `traceCenterline` の既定値。ここが変わったら区間を選び直す。 */
const TRACER_MARGIN_PX = 40;
/** 許容する短縮の度合い（弧長 / 弦長）。1 に近いほど視線に対して寝ている。 */
const MAX_TORTUOSITY = 1.15;

interface Truth {
  recon3d: {
    views: {
      view: number;
      truePrimaryAngleDeg: number;
      trueSecondaryAngleDeg: number;
      exact: { file: string; studyInstanceUid: string; seriesInstanceUid: string };
      branchesPx: { id: string; pointsPx: [number, number][] }[];
    }[];
    branches: { id: string; lengthMm: number; pointsLps: number[][] }[];
    targets: { centerlineRmsMm: number; segmentLengthErrorPercent: number };
  };
}

interface Xa3dState {
  viewCount: number;
  anglesA: { primary: number; secondary: number } | null;
  anglesB: { primary: number; secondary: number } | null;
  separationDeg: number | null;
  pointsA: number;
  pointsB: number;
  anchorCount: number;
  result: {
    acceptable: boolean;
    lengthMm: number;
    anchorReprojectionPx: number;
    matchReprojectionPx: number;
    separationDeg: number;
    points: number;
    warnings: { code: string; value: number; threshold: number; blocking: boolean }[];
    firstPoint: [number, number, number];
    lastPoint: [number, number, number];
    visibleFractionA: number | null;
    visibleFractionB: number | null;
  } | null;
  section: {
    unavailable: string | null;
    minAreaMm2: number | null;
    minEquivalentDiameterMm: number | null;
    medianMeasurementAngleDeg: number | null;
  } | null;
  workingAngles: { primary: number; secondary: number; visibleFraction: number }[];
  refinement: { beforePx: number; afterPx: number; primary: number; secondary: number } | null;
  steps: Record<string, string>;
}

let pass = 0;
let fail = 0;
let unmet = 0;
const lines: string[] = [];

function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) pass++;
  else fail++;
  const d = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  lines.push(`  [${cond ? "ok  " : "FAIL"}] ${label}${d}`);
  console.log(lines[lines.length - 1]);
}

/** 設計目標。未達でも失敗にはしないが、**合格にも数えない**。 */
function target(cond: boolean, label: string, detail?: unknown): void {
  if (cond) pass++;
  else unmet++;
  const d = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  lines.push(`  [${cond ? "ok  " : "UNMET"}] ${label}${d}`);
  console.log(lines[lines.length - 1]);
}

async function xa3dState(page: Page): Promise<Xa3dState | null> {
  const raw = (await page.evaluate(`(() => {
    const g = window.__graphyDebug;
    const s = g && g.getXa3dState ? g.getXa3dState() : null;
    return s ? JSON.stringify(s) : null;
  })()`)) as string | null;
  return raw ? (JSON.parse(raw) as Xa3dState) : null;
}

async function openStudy(page: Page, studyUid: string): Promise<void> {
  await dismissStartupDialogs(page);
  const blocker = await findBlockingOverlay(page, "search-submit-button");
  if (blocker) throw new Error(`検索ボタンが別の要素に塞がれています: ${blocker}`);
  page.once("dialog", (d) => void d.accept());
  // 既定の日付範囲だとファントムの撮影日が外れる。両端を空にして全件出す。
  const dateInputs = page.locator('input[type="date"]');
  await dateInputs.nth(0).fill("");
  await dateInputs.nth(1).fill("");
  await page.getByTestId("search-submit-button").click();
  const row = page.locator(`[data-testid="study-row-${studyUid}"]`);
  await row.waitFor({ state: "visible", timeout: 20_000 }).catch(async () => {
    const present = await page.evaluate(
      `Array.from(document.querySelectorAll('[data-testid^="study-row-"]')).map(e => e.getAttribute("data-testid")).join(",")`,
    );
    throw new Error(`スタディが一覧に出ません。want=${studyUid} present=[${present}]`);
  });
  for (let i = 0; i < 3; i++) {
    await row.click();
    await page.waitForTimeout(800);
    if ((await page.locator('[data-testid^="series-row-"]').count()) > 0) return;
  }
  throw new Error(`スタディを開いてもシリーズ行が出ません: ${studyUid}`);
}

async function selectLengthTool(viewer: Page): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-roi").click();
  await viewer.waitForTimeout(250);
  await viewer.getByText("長さ", { exact: true }).first().click();
  await viewer.waitForTimeout(300);
}

/**
 * **真値の画素座標**の 2 点を結ぶ計測を引く。
 *
 * <p>画面中央からの決め打ちではなく、`branchesPx` が与える血管の始点・終点を指す。
 * 螺旋なので、始点と終点を直線で結んでも中心線にはならない —— そこは QCA の経路探索が
 * 画像に沿って辿る。**辿れているかどうかが、まさにここで測りたいこと**。
 */
async function drawBetweenImagePixels(
  viewer: Page,
  p0: [number, number],
  p1: [number, number],
): Promise<void> {
  const raw = (await viewer.evaluate(`(() => {
    const g = window.__graphyDebug;
    const f = g && g.imagePixelsToCanvasFraction
      ? g.imagePixelsToCanvasFraction(${JSON.stringify([p0, p1])})
      : null;
    const host = document.querySelector('[data-testid="${HOST}"]');
    const canvas = host && host.querySelector("canvas");
    if (!f || !canvas) return null;
    const r = canvas.getBoundingClientRect();
    return JSON.stringify({ f: f, w: r.width, h: r.height });
  })()`)) as string | null;
  if (!raw) throw new Error("画素→キャンバスの変換ができませんでした");
  const { f, w, h } = JSON.parse(raw) as { f: { fx: number; fy: number }[]; w: number; h: number };
  const dx = Math.round((f[1].fx - f[0].fx) * w);
  const dy = Math.round((f[1].fy - f[0].fy) * h);
  if (Math.hypot(dx, dy) < 20) throw new Error(`表示が小さすぎて引けません（${Math.hypot(dx, dy).toFixed(1)}px）`);
  await dragOnCanvasHost(viewer, HOST, dx, dy, 0, 14, { fracX: f[0].fx, fracY: f[0].fy });
  await viewer.waitForTimeout(800);
}

/**
 * 1 方向ぶんの 2D QCA を実行して、3D QCA の登録簿に載せる。
 *
 * <p>⚠️ 2D ビューアは**同じウィンドウを使い回す**（`window.open` の named target）。
 * シリーズを変えて開き直すには、いったん閉じる必要がある。呼び出し側で閉じること。
 */
async function runQcaForView(
  driver: DesktopDriver,
  mainPage: Page,
  seriesUid: string,
  ends: [[number, number], [number, number]],
): Promise<Page> {
  const row = mainPage.locator(`[data-testid="series-row-${seriesUid}"]`);
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.click();
  await mainPage.waitForTimeout(400);

  const viewer = await driver.waitForNewPage(
    () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
  await viewer.waitForTimeout(3_000);

  await selectLengthTool(viewer);
  await drawBetweenImagePixels(viewer, ends[0], ends[1]);
  await viewer.getByTestId("xa-analysis-open").click();
  await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await viewer.getByTestId("xa-qca-run").click();
  await viewer.waitForTimeout(3_500);
  await viewer.getByTestId("xa-dialog-close").click();
  await viewer.waitForTimeout(400);
  return viewer;
}

/** 3D 折れ線の長さ。 */
function polylineLength(points: readonly number[][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
      points[i][2] - points[i - 1][2],
    );
  }
  return total;
}

async function main(): Promise<void> {
  if (!fs.existsSync(TRUTH_PATH)) {
    throw new Error(
      `ファントムがありません: ${PHANTOM_DIR}\n` +
        `先に "cd bench && python3 make_phantom_xa.py --out ./phantom" を実行してください。`,
    );
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const truth = (JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8")) as Truth).recon3d;
  const v1 = truth.views[0];
  const v2 = truth.views[1];
  if (!v1.branchesPx) {
    throw new Error("truth.json に branchesPx がありません。ファントムを作り直してください（--force）。");
  }
  const main1 = v1.branchesPx.find((b) => b.id === "main")!;
  const main2 = v2.branchesPx.find((b) => b.id === "main")!;
  const mainTruth = truth.branches.find((b) => b.id === "main")!;
  const seg1 = main1.pointsPx.slice(SEG_FROM, SEG_TO + 1);
  const seg2 = main2.pointsPx.slice(SEG_FROM, SEG_TO + 1);
  // 再構成が復元できるのは**与えた折れ線**まで（間引きぶんは背負わせない。§10.3 の注記）。
  const feedableLengthMm = polylineLength(mainTruth.pointsLps.slice(SEG_FROM, SEG_TO + 1));

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    await resetDb(driver.ports.http);
    const files = [path.join(PHANTOM_DIR, v1.exact.file), path.join(PHANTOM_DIR, v2.exact.file)];
    const imp = await importPaths(driver.ports.http, files);
    check(imp.imported === files.length, "[準備] 2 方向を取り込めた", imp);

    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    await openStudy(mainPage, v1.exact.studyInstanceUid);

    // ── 各方向で 2D QCA ────────────────────────────────────────
    // ── 前提の確認: 自動追跡の探索窓に何が収まるか ───────────────
    // 「なぜ区間を切ったか」を毎回数値で確かめる。窓を広げたらここが落ちて気付ける。
    for (const [name, pts] of [["A", main1.pointsPx], ["B", main2.pointsPx]] as const) {
      const seg = pts.slice(SEG_FROM, SEG_TO + 1);
      check(
        maxChordDeviationPx(pts) > TRACER_MARGIN_PX,
        `[限界] 方向 ${name} — 血管全体は自動追跡の探索窓（±${TRACER_MARGIN_PX}px）に収まらない`,
        { maxDeviationPx: Number(maxChordDeviationPx(pts).toFixed(1)) },
      );
      check(
        maxChordDeviationPx(seg) < TRACER_MARGIN_PX,
        `[限界] 方向 ${name} — 解析する区間は探索窓に収まる`,
        { maxDeviationPx: Number(maxChordDeviationPx(seg).toFixed(1)) },
      );
      // ★ 短縮した区間は「近道も血管の上を通る」ので原理的に辿れない。区間選びの前提。
      const tort = polylineLengthPx(seg) / Math.hypot(seg[seg.length - 1][0] - seg[0][0], seg[seg.length - 1][1] - seg[0][1]);
      check(
        tort < MAX_TORTUOSITY,
        `[限界] 方向 ${name} — 解析する区間が短縮していない（弧長/弦長 < ${MAX_TORTUOSITY}）`,
        { tortuosity: Number(tort.toFixed(3)) },
      );
    }

    const viewerA = await runQcaForView(driver, mainPage, v1.exact.seriesInstanceUid, [
      seg1[0],
      seg1[seg1.length - 1],
    ]);
    await checkExtractedCenterline(viewerA, "A", seg1);
    await viewerA.screenshot({ path: path.join(OUT_DIR, "1-view1-qca.png") }).catch(() => {});
    await viewerA.close().catch(() => {});
    await mainPage.waitForTimeout(600);

    const viewerB = await runQcaForView(driver, mainPage, v2.exact.seriesInstanceUid, [
      seg2[0],
      seg2[seg2.length - 1],
    ]);
    await checkExtractedCenterline(viewerB, "B", seg2);
    await viewerB.screenshot({ path: path.join(OUT_DIR, "2-view2-qca.png") }).catch(() => {});

    // ── 3D QCA ────────────────────────────────────────────────
    // 方向 A のビューアは既に閉じている。登録簿はメインウィンドウが中継して覚えているので、
    // ここで 2 件見えていれば **BroadcastChannel の中継が効いている**ことの証明になる。
    const open3d = viewerB.getByTestId("xa3d-open");
    await open3d.waitFor({ state: "visible", timeout: 10_000 });
    const disabled = await open3d.isDisabled();
    check(!disabled, "[UI] 2 方向が揃うと 3D QCA を開ける", { disabled });
    if (disabled) {
      // ここで止まると以降が全部落ちるので、理由を残して終える。
      const st = await xa3dState(viewerB);
      check(false, "[UI] 登録簿に 2 方向が載っている（ウィンドウ跨ぎの制約の可能性）", st);
      return;
    }
    await open3d.click();
    await viewerB.getByTestId("xa3d-dialog").waitFor({ state: "visible", timeout: 10_000 });

    const options = await viewerB.locator('[data-testid="xa3d-view-a"] option').allTextContents();
    check(options.length >= 3, "[UI] 方向の一覧に 2 件（＋空欄）出る", options);

    // 方向を選ぶ。value は imageId なので、ラベルではなく index で選ぶ。
    const values = await viewerB.evaluate(`(() => {
      const sel = document.querySelector('[data-testid="xa3d-view-a"]');
      return JSON.stringify(Array.from(sel.options).map((o) => o.value).filter(Boolean));
    })()`);
    const ids = JSON.parse(values as string) as string[];
    check(ids.length === 2, "[UI] 登録された方向がちょうど 2 件", ids.length);
    await viewerB.selectOption('[data-testid="xa3d-view-a"]', ids[0]);
    await viewerB.waitForTimeout(300);
    await viewerB.selectOption('[data-testid="xa3d-view-b"]', ids[1]);
    await viewerB.waitForTimeout(500);

    const sel = await xa3dState(viewerB);
    check(sel?.viewCount === 2, "[幾何] 2 方向を選べている", sel?.viewCount);

    // ── タグから読んだ角度が真値と一致するか ─────────────────
    const angles = [sel?.anglesA, sel?.anglesB];
    const trueAngles = [v1, v2].map((v) => ({ primary: v.truePrimaryAngleDeg, secondary: v.trueSecondaryAngleDeg }));
    // 選択順は登録順（＝解析した順）。どちらがどちらでもよいように集合で突き合わせる。
    for (const want of trueAngles) {
      const hit = angles.some(
        (a) => a && Math.abs(a.primary - want.primary) < 0.01 && Math.abs(a.secondary - want.secondary) < 0.01,
      );
      check(hit, `[幾何] タグから ${want.primary}/${want.secondary} を読めている`, angles);
    }

    const expectedSeparation = 90; // view1(-30,0) と view2(60,20) は厳密に直交する
    check(
      sel?.separationDeg != null && Math.abs(sel.separationDeg - expectedSeparation) < 0.5,
      "[幾何] 視線の角度差が真値どおり（90°）",
      sel?.separationDeg,
    );

    check((sel?.pointsA ?? 0) > 20, "[2D] 方向 A の中心線を画像から抽出できている", sel?.pointsA);
    check((sel?.pointsB ?? 0) > 20, "[2D] 方向 B の中心線を画像から抽出できている", sel?.pointsB);

    // ── アンカー: まず端点 2 つだけ（＝補正が掛からない状態）──
    check(sel?.anchorCount === 2, "[アンカー] 端点 2 点が既定で入っている", sel?.anchorCount);
    check(
      sel?.steps.anchors === "skipped",
      "[アンカー] ★端点 2 点だけは done ではなく skipped（角度補正が掛からないため）",
      sel?.steps,
    );

    await viewerB.getByTestId("xa3d-run").click();
    await viewerB.waitForTimeout(1_500);
    const noAnchor = await xa3dState(viewerB);
    check(noAnchor?.result != null, "[再構成] 端点だけでも結果は出る", noAnchor?.result != null);
    check(noAnchor?.refinement == null, "[再構成] ★アンカー 2 点では角度補正が掛からない", noAnchor?.refinement);

    // ── アンカーを 3 点目に足して補正を効かせる ────────────────
    // 分岐部（主枝の 45%）を両方向で指す。ここは 2 方向で同定できる点の代表例。
    const bifIdx = Math.round(0.45 * (seg1.length - 1));
    await clickOnCurve(viewerB, "xa3d-curve-a", seg1, bifIdx);
    await clickOnCurve(viewerB, "xa3d-curve-b", seg2, bifIdx);
    await viewerB.waitForTimeout(400);
    const withAnchor = await xa3dState(viewerB);
    check(withAnchor?.anchorCount === 3, "[アンカー] 3 点目を追加できた", withAnchor?.anchorCount);
    check(withAnchor?.steps.anchors === "done", "[アンカー] 3 点あれば done になる", withAnchor?.steps);
    check(withAnchor?.result == null, "[アンカー] アンカーを変えたら前の結果を捨てる", withAnchor?.result);

    await viewerB.getByTestId("xa3d-run").click();
    await viewerB.waitForTimeout(2_000);
    const st = await xa3dState(viewerB);
    await viewerB.screenshot({ path: path.join(OUT_DIR, "3-3dqca.png") }).catch(() => {});

    if (!st?.result) {
      check(false, "[再構成] 3D 中心線を作れた", st);
      return;
    }
    check(st.refinement != null, "[再構成] アンカー 3 点で角度補正が掛かる", st.refinement);
    check(st.result.acceptable, "[再構成] 品質基準を満たす", {
      warnings: st.result.warnings,
      anchorPx: st.result.anchorReprojectionPx,
    });
    check(st.steps.recon === "done", "[UI] レールの再構成の段が done", st.steps);

    const lengthErrPct = (Math.abs(st.result.lengthMm - feedableLengthMm) / feedableLengthMm) * 100;
    target(
      lengthErrPct < TARGET_LENGTH_ERROR_PCT,
      `[精度] 【目標】3D 長さの誤差 < ${TARGET_LENGTH_ERROR_PCT}%`,
      { truthMm: Number(feedableLengthMm.toFixed(2)), measuredMm: Number(st.result.lengthMm.toFixed(2)), errorPct: Number(lengthErrPct.toFixed(2)) },
    );
    target(
      st.result.anchorReprojectionPx < TARGET_ANCHOR_REPROJ_PX,
      `[精度] 【目標】アンカー再投影誤差 < ${TARGET_ANCHOR_REPROJ_PX}px`,
      Number(st.result.anchorReprojectionPx.toFixed(3)),
    );

    // 🚨 「対応付けの再投影誤差は幾何の検査にならない」を実機でも固定する（§10.2.2）。
    check(
      st.result.matchReprojectionPx < st.result.anchorReprojectionPx + 1e-9 ||
        st.result.matchReprojectionPx < 2.0,
      "[原理] 対応付けの再投影誤差は小さいまま出る（品質判定に使えない証拠）",
      {
        match: Number(st.result.matchReprojectionPx.toFixed(3)),
        anchor: Number(st.result.anchorReprojectionPx.toFixed(3)),
      },
    );

    // ── 短縮の指標（§10.3.1 の主因を数値で出せているか）────────
    const visA = st.result.visibleFractionA;
    const visB = st.result.visibleFractionB;
    check(
      visA != null && visB != null && visA > 0 && visA <= 1 && visB > 0 && visB <= 1,
      "[短縮] 各方向の「見えている長さの割合」を出せている",
      { a: visA, b: visB },
    );
    // 🚨 方向 B のほうが短縮している、という**向き**まで確かめる。実測で 2D 中心線の
    //    弧長を取りこぼしたのは B（§10.3.1）。値が出るだけでは意味の検査にならない。
    check(
      visA != null && visB != null && visB < visA,
      "[短縮] ★弧長を取りこぼした方向 B のほうが、短縮が強いと出る",
      { a: Number((visA ?? 0).toFixed(3)), b: Number((visB ?? 0).toFixed(3)) },
    );
    check(
      st.workingAngles.length >= 1 && st.workingAngles[0].visibleFraction >= (visA ?? 0),
      "[短縮] 短縮の少ない撮影角度を提案できる（現在の方向 A 以上）",
      st.workingAngles,
    );

    // ── 3D 断面（§10.2.5）──────────────────────────────────
    check(st.section != null, "[断面] 断面の合成まで到達している", st.section);
    if (st.section) {
      check(
        st.section.unavailable === null,
        "[断面] 装置校正済みなので断面積が出る",
        st.section.unavailable,
      );
      // 🔴 **既知の系統誤差と突き合わせる**（「妥当な範囲」で済ませない）。
      //    主枝の径は 3.5mm → 2.0mm の線形テーパー。狭窄は t=0.66 で、この区間の外。
      //    したがって区間内の最小径は遠位端 t=SEG_TO/59 の値。
      //    径は半値法で約 13% 過小に出る（§16.4 の係数 0.870）ので、期待値はその積。
      const tDistal = SEG_TO / (main1.pointsPx.length - 1);
      const truthMinDiameterMm = 3.5 - 1.5 * tDistal;
      const expectedMm = truthMinDiameterMm * KNOWN_DIAMETER_FACTOR;
      const eq = st.section.minEquivalentDiameterMm;
      check(
        eq != null && Math.abs(eq - expectedMm) < 0.25,
        `[断面] 最小等価直径が既知の系統誤差どおり（真値 × ${KNOWN_DIAMETER_FACTOR}）`,
        {
          truthMm: Number(truthMinDiameterMm.toFixed(3)),
          expectedMm: Number(expectedMm.toFixed(3)),
          measuredMm: eq == null ? null : Number(eq.toFixed(3)),
        },
      );
      const ang = st.section.medianMeasurementAngleDeg;
      check(ang != null && ang > 0 && ang <= 90, "[断面] 測定方向のなす角を出せている", ang == null ? null : Number(ang.toFixed(1)));
    }

    // ── 2D 投影長より 3D のほうが真値に近いこと（3D にする実利）──
    const proj2dMm = polylineLengthPx(seg1) * 0.225;
    const err2d = (Math.abs(proj2dMm - feedableLengthMm) / feedableLengthMm) * 100;
    check(lengthErrPct < err2d, "[実利] ★3D 長さのほうが 2D 投影長より真値に近い", {
      projected2dMm: Number(proj2dMm.toFixed(2)),
      error2dPct: Number(err2d.toFixed(2)),
      error3dPct: Number(lengthErrPct.toFixed(2)),
    });

    fs.writeFileSync(
      path.join(OUT_DIR, "result.json"),
      JSON.stringify({ truthLengthMm: feedableLengthMm, state: st, lengthErrPct, err2d }, null, 2),
    );
  } finally {
    await driver.stop().catch(() => {});
    const summary = `\n===== 3D QCA（GNBP-XA-3）実機検証 =====\n合格 ${pass} / 失敗 ${fail} / 目標未達 ${unmet}`;
    console.log(summary);
    fs.writeFileSync(path.join(OUT_DIR, "log.txt"), lines.join("\n") + summary + "\n");
  }
  if (fail > 0) process.exitCode = 1;
}

/** 中心線プレビュー（SVG）の上で、指定の中心線インデックスに最も近い場所をクリックする。 */
async function clickOnCurve(
  page: Page,
  testId: string,
  truthPx: [number, number][],
  truthIndex: number,
): Promise<void> {
  // プレビューは画素座標を等方に収めて描いている。真値の画素そのままではなく、
  // **画面上の位置**を計算してクリックする必要がある。SVG の描画と同じ式で求める。
  const target = truthPx[truthIndex];
  const box = truthPx.reduce(
    (acc, p) => ({
      x0: Math.min(acc.x0, p[0]),
      y0: Math.min(acc.y0, p[1]),
      x1: Math.max(acc.x1, p[0]),
      y1: Math.max(acc.y1, p[1]),
    }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
  );
  const pad = 8;
  const size = 210;
  const scale = Math.min((size - 2 * pad) / (box.x1 - box.x0), (size - 2 * pad) / (box.y1 - box.y0));
  const sx = pad + (target[0] - box.x0) * scale;
  const sy = pad + (target[1] - box.y0) * scale;
  const el = page.getByTestId(testId);
  await el.click({ position: { x: sx, y: sy } });
  await page.waitForTimeout(250);
}

/** 折れ線が「両端を結ぶ弦」から最も離れる距離 [px]。自動追跡の探索窓に収まるかの指標。 */
function maxChordDeviationPx(points: readonly [number, number][]): number {
  const a = points[0];
  const b = points[points.length - 1];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(len > 0)) return Number.POSITIVE_INFINITY;
  let m = 0;
  for (const p of points) {
    m = Math.max(m, Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / len);
  }
  return m;
}

/** 点から折れ線への最短距離 [px]。 */
function distanceToPolylinePx(p: readonly [number, number], poly: readonly [number, number][]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t)));
  }
  return best;
}

/**
 * アプリが**画像から抽出した**中心線を、真値の 2D 中心線と突き合わせる。
 *
 * <p>これが無いと、3D がずれたときに「2D の抽出が悪い」のか「3D の再構成が悪い」のかが
 * 切り分けられない。実際、最初はここが原因だった（探索窓の外へ出て近道していた）。
 */
async function checkExtractedCenterline(
  viewer: Page,
  name: string,
  truthPx: readonly [number, number][],
): Promise<void> {
  const raw = (await viewer.evaluate(`(() => {
    const g = window.__graphyDebug;
    const s = g && g.getQcaState ? g.getQcaState() : null;
    return s && s.centerline ? JSON.stringify(s.centerline) : null;
  })()`)) as string | null;
  if (!raw) {
    check(false, `[2D] 方向 ${name} — 中心線を抽出できた`);
    return;
  }
  const pts = JSON.parse(raw) as [number, number][];
  let sum = 0;
  let max = 0;
  for (const p of pts) {
    const d = distanceToPolylinePx(p, truthPx);
    sum += d * d;
    max = Math.max(max, d);
  }
  const rms = Math.sqrt(sum / pts.length);
  // 端が指定どおりか（＝計測を狙った画素に引けているか）。ここがずれていると、
  // 「追跡が近道した」のか「そもそも短い区間を指定した」のか区別できない。
  const d0 = Math.hypot(pts[0][0] - truthPx[0][0], pts[0][1] - truthPx[0][1]);
  const dN = Math.hypot(
    pts[pts.length - 1][0] - truthPx[truthPx.length - 1][0],
    pts[pts.length - 1][1] - truthPx[truthPx.length - 1][1],
  );
  check(Math.max(d0, dN) < 6, `[2D] 方向 ${name} — 計測を狙った画素に引けている`, {
    startOffPx: Number(d0.toFixed(1)),
    endOffPx: Number(dN.toFixed(1)),
    got: [pts[0], pts[pts.length - 1]],
    want: [truthPx[0], truthPx[truthPx.length - 1]],
  });
  const truthLen = polylineLengthPx(truthPx);
  const gotLen = polylineLengthPx(pts);
  check(rms < TOL_CENTERLINE_PX, `[2D] 方向 ${name} — 抽出した中心線が真値に乗る（RMS < ${TOL_CENTERLINE_PX}px）`, {
    rmsPx: Number(rms.toFixed(2)),
    maxPx: Number(max.toFixed(2)),
    points: pts.length,
  });
  // 🔴 **現状の限界**（3D 側の退行ではないので `target` 扱い）。
  //    短縮した投影では、直進する近道も血管画素の上を通るため、自動追跡は弧長を取りこぼす。
  //    実測: 方向 B で 150.3px の真値に対し 136.0px（9.5% 短い）。これが 3D 長さ誤差 3.3% の主因。
  target(
    Math.abs(gotLen - truthLen) / truthLen < 0.05,
    `[2D] 方向 ${name} — 【目標】中心線の長さが真値の 5% 以内（近道していない）`,
    {
      truthPx: Number(truthLen.toFixed(1)),
      gotPx: Number(gotLen.toFixed(1)),
      shortPct: Number((((truthLen - gotLen) / truthLen) * 100).toFixed(1)),
    },
  );
}

function polylineLengthPx(points: readonly [number, number][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

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
/**
 * 解析する区間（主枝の真値点列のインデックス）と、そこで確かめること。
 *
 * <p>**2 つ回す。片方だけでは検証が痩せる**:
 * - `proximal`（5〜25）… 方向 B が強く短縮する区間。**自動追跡が弧長を取りこぼす現象**
 *   （§10.3.1 の主因）を毎回踏む。病変を含まないので %DS は測れない。
 * - `lesion`（34〜51）… 狭窄（t=0.66・50%）を挟む区間。**%DS を真値と比べられる**。
 *   短縮が軽いので長さの目標も満たす。
 *
 * <p>🚨 **区間を 1 つに絞ると、その区間で起きない現象が検証から抜ける**。実際、病変込みの
 * 区間だけにした時点で「短縮した方向で弧長を取りこぼす」証拠が回らなくなった。
 */
const SEGMENTS = [
  { key: "proximal", from: 5, to: 25, hasLesion: false },
  { key: "lesion", from: 34, to: 51, hasLesion: true },
] as const;
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
    lesion: { branch: string; fractionOfMain: number; percentDiameterStenosis: number; lengthFraction: number };
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
  stenosis: {
    percentDiameterStenosis: number;
    percentAreaStenosis: number;
    mldMm: number;
    rvdMm: number;
    lesionLengthMm: number;
    /** 径プロファイルの雑音尺度 σ̂ [mm]。3D は 2D より荒れる（§10.2.8）。 */
    profileNoiseMm: number;
  } | null;
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
  // 🚨 **計測は保管庫へ永続化され、開き直すと復元される**。前の区間で引いた計測が残るので、
  //    既定（先頭）のまま走らせると**前の区間を解析してしまう**（実際に踏んだ。2 区間目が
  //    1 区間目と同じ端点・同じ点数で出た）。**今引いた計測を長さで選び直す**。
  const wantPx = Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]);
  const chosen = await viewer.evaluate(`(() => {
    const sel = document.querySelector('[data-testid="xa-analysis-pick"]');
    return sel ? JSON.stringify(Array.from(sel.options).map((o) => o.textContent)) : null;
  })()`);
  const labels = chosen ? (JSON.parse(chosen as string) as string[]) : [];
  if (labels.length > 1) {
    let best = 0;
    let bestErr = Number.POSITIVE_INFINITY;
    labels.forEach((label, i) => {
      const m = /([\d.]+)\s*px/.exec(label ?? "");
      if (!m) return;
      const err = Math.abs(parseFloat(m[1]) - wantPx);
      if (err < bestErr) {
        bestErr = err;
        best = i;
      }
    });
    await viewer.selectOption('[data-testid="xa-analysis-pick"]', String(best));
    await viewer.waitForTimeout(400);
  }
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

/** 1 区間ぶんの通し検証（2 方向で 2D QCA → 3D 再構成 → 断面 → 狭窄率 → 保存）。 */
async function analyseSegment(
  driver: DesktopDriver,
  mainPage: Page,
  ctx: {
    v1: Truth["recon3d"]["views"][number];
    v2: Truth["recon3d"]["views"][number];
    main1: { pointsPx: [number, number][] };
    main2: { pointsPx: [number, number][] };
    mainTruth: { lengthMm: number; pointsLps: number[][] };
    lesion: Truth["recon3d"]["lesion"];
  },
  seg: (typeof SEGMENTS)[number],
): Promise<void> {
  const { v1, v2, main1, main2, mainTruth, lesion } = ctx;
  const SEG_FROM = seg.from;
  const SEG_TO = seg.to;
  const tag = `${seg.key}`;
  const seg1 = main1.pointsPx.slice(SEG_FROM, SEG_TO + 1);
  const seg2 = main2.pointsPx.slice(SEG_FROM, SEG_TO + 1);
  const feedableLengthMm = polylineLength(mainTruth.pointsLps.slice(SEG_FROM, SEG_TO + 1));
  const truth = { lesion };
    // ── 前提の確認: 自動追跡の探索窓に何が収まるか ───────────────
    // 「なぜ区間を切ったか」を毎回数値で確かめる。窓を広げたらここが落ちて気付ける。
    for (const [name, pts] of [["A", main1.pointsPx], ["B", main2.pointsPx]] as const) {
      const seg = pts.slice(SEG_FROM, SEG_TO + 1);
      check(
        maxChordDeviationPx(pts) > TRACER_MARGIN_PX,
        `[限界/${tag}] 方向 ${name} — 血管全体は自動追跡の探索窓（±${TRACER_MARGIN_PX}px）に収まらない`,
        { maxDeviationPx: Number(maxChordDeviationPx(pts).toFixed(1)) },
      );
      check(
        maxChordDeviationPx(seg) < TRACER_MARGIN_PX,
        `[限界/${tag}] 方向 ${name} — 解析する区間は探索窓に収まる`,
        { maxDeviationPx: Number(maxChordDeviationPx(seg).toFixed(1)) },
      );
      // ★ 短縮した区間は「近道も血管の上を通る」ので原理的に辿れない。区間選びの前提。
      const tort = polylineLengthPx(seg) / Math.hypot(seg[seg.length - 1][0] - seg[0][0], seg[seg.length - 1][1] - seg[0][1]);
      check(
        tort < MAX_TORTUOSITY,
        `[限界/${tag}] 方向 ${name} — 解析する区間が短縮していない（弧長/弦長 < ${MAX_TORTUOSITY}）`,
        { tortuosity: Number(tort.toFixed(3)) },
      );
    }

    const viewerA = await runQcaForView(driver, mainPage, v1.exact.seriesInstanceUid, [
      seg1[0],
      seg1[seg1.length - 1],
    ]);
    const shortfallA = await checkExtractedCenterline(viewerA, "A", seg1, tag);
    await viewerA.screenshot({ path: path.join(OUT_DIR, `1-${tag}-view1-qca.png`) }).catch(() => {});
    await viewerA.close().catch(() => {});
    await mainPage.waitForTimeout(600);

    const viewerB = await runQcaForView(driver, mainPage, v2.exact.seriesInstanceUid, [
      seg2[0],
      seg2[seg2.length - 1],
    ]);
    const shortfallB = await checkExtractedCenterline(viewerB, "B", seg2, tag);
    await viewerB.screenshot({ path: path.join(OUT_DIR, `2-${tag}-view2-qca.png`) }).catch(() => {});

    // ── 3D QCA ────────────────────────────────────────────────
    // 方向 A のビューアは既に閉じている。登録簿はメインウィンドウが中継して覚えているので、
    // ここで 2 件見えていれば **BroadcastChannel の中継が効いている**ことの証明になる。
    const open3d = viewerB.getByTestId("xa3d-open");
    await open3d.waitFor({ state: "visible", timeout: 10_000 });
    const disabled = await open3d.isDisabled();
    check(!disabled, `[UI/${tag}] 2 方向が揃うと 3D QCA を開ける`, { disabled });
    if (disabled) {
      // ここで止まると以降が全部落ちるので、理由を残して終える。
      const st = await xa3dState(viewerB);
      check(false, `[UI/${tag}] 登録簿に 2 方向が載っている（ウィンドウ跨ぎの制約の可能性）`, st);
      return;
    }
    await open3d.click();
    await viewerB.getByTestId("xa3d-dialog").waitFor({ state: "visible", timeout: 10_000 });

    const options = await viewerB.locator('[data-testid="xa3d-view-a"] option').allTextContents();
    check(options.length >= 3, `[UI/${tag}] 方向の一覧に 2 件（＋空欄）出る`, options);

    // 方向を選ぶ。value は imageId なので、ラベルではなく index で選ぶ。
    const values = await viewerB.evaluate(`(() => {
      const sel = document.querySelector('[data-testid="xa3d-view-a"]');
      return JSON.stringify(Array.from(sel.options).map((o) => o.value).filter(Boolean));
    })()`);
    const ids = JSON.parse(values as string) as string[];
    // 🔴 **登録簿は区間ごとに 1 件持つ**（2026-08-16 に imageId 鍵から変えた。分岐部 A6b は
    //    同じフレームから 3 区間を取るため）。よって 2 区間目では 4 件並ぶ。
    //    **いま解析した区間＝末尾の 2 件**を選ぶ。ここを index 0/1 のままにすると
    //    「1 区間目の結果を 2 区間目として検証する」という静かな嘘になる。
    check(ids.length >= 2, `[UI/${tag}] 登録された方向が 2 件以上ある`, ids.length);
    const use = ids.slice(-2);
    await viewerB.selectOption('[data-testid="xa3d-view-a"]', use[0]);
    await viewerB.waitForTimeout(300);
    await viewerB.selectOption('[data-testid="xa3d-view-b"]', use[1]);
    await viewerB.waitForTimeout(500);

    const sel = await xa3dState(viewerB);
    check(sel?.viewCount === 2, `[幾何/${tag}] 2 方向を選べている`, sel?.viewCount);

    // ── タグから読んだ角度が真値と一致するか ─────────────────
    const angles = [sel?.anglesA, sel?.anglesB];
    const trueAngles = [v1, v2].map((v) => ({ primary: v.truePrimaryAngleDeg, secondary: v.trueSecondaryAngleDeg }));
    // 選択順は登録順（＝解析した順）。どちらがどちらでもよいように集合で突き合わせる。
    for (const want of trueAngles) {
      const hit = angles.some(
        (a) => a && Math.abs(a.primary - want.primary) < 0.01 && Math.abs(a.secondary - want.secondary) < 0.01,
      );
      check(hit, `[幾何/${tag}] タグから ${want.primary}/${want.secondary} を読めている`, angles);
    }

    const expectedSeparation = 90; // view1(-30,0) と view2(60,20) は厳密に直交する
    check(
      sel?.separationDeg != null && Math.abs(sel.separationDeg - expectedSeparation) < 0.5,
      `[幾何/${tag}] 視線の角度差が真値どおり（90°）`,
      sel?.separationDeg,
    );

    check((sel?.pointsA ?? 0) > 20, `[2D/${tag}] 方向 A の中心線を画像から抽出できている`, sel?.pointsA);
    check((sel?.pointsB ?? 0) > 20, `[2D/${tag}] 方向 B の中心線を画像から抽出できている`, sel?.pointsB);

    // ── アンカー: まず端点 2 つだけ（＝補正が掛からない状態）──
    check(sel?.anchorCount === 2, `[アンカー/${tag}] 端点 2 点が既定で入っている`, sel?.anchorCount);
    check(
      sel?.steps.anchors === "skipped",
      `[アンカー/${tag}] ★端点 2 点だけは done ではなく skipped（角度補正が掛からないため）`,
      sel?.steps,
    );

    await viewerB.getByTestId("xa3d-run").click();
    await viewerB.waitForTimeout(1_500);
    const noAnchor = await xa3dState(viewerB);
    check(noAnchor?.result != null, `[再構成/${tag}] 端点だけでも結果は出る`, noAnchor?.result != null);
    check(noAnchor?.refinement == null, `[再構成/${tag}] ★アンカー 2 点では角度補正が掛からない`, noAnchor?.refinement);

    // ── アンカーを 3 点目に足して補正を効かせる ────────────────
    // 分岐部（主枝の 45%）を両方向で指す。ここは 2 方向で同定できる点の代表例。
    const bifIdx = Math.round(0.45 * (seg1.length - 1));
    await clickOnCurve(viewerB, "xa3d-curve-a", seg1, bifIdx);
    await clickOnCurve(viewerB, "xa3d-curve-b", seg2, bifIdx);
    await viewerB.waitForTimeout(400);
    const withAnchor = await xa3dState(viewerB);
    check(withAnchor?.anchorCount === 3, `[アンカー/${tag}] 3 点目を追加できた`, withAnchor?.anchorCount);
    check(withAnchor?.steps.anchors === "done", `[アンカー/${tag}] 3 点あれば done になる`, withAnchor?.steps);
    check(withAnchor?.result == null, `[アンカー/${tag}] アンカーを変えたら前の結果を捨てる`, withAnchor?.result);

    await viewerB.getByTestId("xa3d-run").click();
    await viewerB.waitForTimeout(2_000);
    const st = await xa3dState(viewerB);
    await viewerB.screenshot({ path: path.join(OUT_DIR, `3-${tag}-3dqca.png`) }).catch(() => {});

    if (!st?.result) {
      check(false, `[再構成/${tag}] 3D 中心線を作れた`, st);
      return;
    }
    check(st.refinement != null, `[再構成/${tag}] アンカー 3 点で角度補正が掛かる`, st.refinement);
    check(st.result.acceptable, `[再構成/${tag}] 品質基準を満たす`, {
      warnings: st.result.warnings,
      anchorPx: st.result.anchorReprojectionPx,
    });
    check(st.steps.recon === "done", `[UI/${tag}] レールの再構成の段が done`, st.steps);

    const lengthErrPct = (Math.abs(st.result.lengthMm - feedableLengthMm) / feedableLengthMm) * 100;
    target(
      lengthErrPct < TARGET_LENGTH_ERROR_PCT,
      `[精度/${tag}] 【目標】3D 長さの誤差 < ${TARGET_LENGTH_ERROR_PCT}%`,
      { truthMm: Number(feedableLengthMm.toFixed(2)), measuredMm: Number(st.result.lengthMm.toFixed(2)), errorPct: Number(lengthErrPct.toFixed(2)) },
    );
    target(
      st.result.anchorReprojectionPx < TARGET_ANCHOR_REPROJ_PX,
      `[精度/${tag}] 【目標】アンカー再投影誤差 < ${TARGET_ANCHOR_REPROJ_PX}px`,
      Number(st.result.anchorReprojectionPx.toFixed(3)),
    );

    // 🚨 「対応付けの再投影誤差は幾何の検査にならない」を実機でも固定する（§10.2.2）。
    check(
      st.result.matchReprojectionPx < st.result.anchorReprojectionPx + 1e-9 ||
        st.result.matchReprojectionPx < 2.0,
      `[原理/${tag}] 対応付けの再投影誤差は小さいまま出る（品質判定に使えない証拠）`,
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
      `[短縮/${tag}] 各方向の「見えている長さの割合」を出せている`,
      { a: visA, b: visB },
    );
    // 🚨 **値が出るだけでは意味の検査にならない**ので、指標と実際の取りこぼしの
    //    **向きが一致する**ことを見る。
    //    ⚠️ ここを「B のほうが短縮が強い」と決め打ちしてはいけない。どちらが潰れるかは
    //       解析する区間で入れ替わる（実際、区間を病変込みに変えたら A と B が逆転して
    //       決め打ちの検査が落ちた）。**区間に依存しない主張だけを検査する**。
    //    ⚠️ 取りこぼしがどちらも無い区間では「向きの一致」に情報が無い（比べても
    //       雑音の符号を見るだけ）。**空振りの合格を作らない**ため、取りこぼしが
    //       意味のある大きさのときだけ向きを見る。
    const detail = {
      shortfallA: Number(shortfallA.toFixed(3)),
      shortfallB: Number(shortfallB.toFixed(3)),
      visibleA: Number((visA ?? 0).toFixed(3)),
      visibleB: Number((visB ?? 0).toFixed(3)),
    };
    if (Math.max(shortfallA, shortfallB) < 0.03) {
      check(true, `[短縮/${tag}] この区間はどちらの方向も弧長を取りこぼしていない（向きの比較は情報が無い）`, detail);
    } else {
      const worseShortfall = shortfallA >= shortfallB ? "A" : "B";
      const worseVisible = (visA ?? 1) <= (visB ?? 1) ? "A" : "B";
      check(worseShortfall === worseVisible, `[短縮/${tag}] ★弧長を多く取りこぼした方向が、短縮も強いと出る`, detail);
    }
    check(
      st.workingAngles.length >= 1 && st.workingAngles[0].visibleFraction >= (visA ?? 0),
      `[短縮/${tag}] 短縮の少ない撮影角度を提案できる（現在の方向 A 以上）`,
      st.workingAngles,
    );

    // ── 3D 断面（§10.2.5）──────────────────────────────────
    check(st.section != null, `[断面/${tag}] 断面の合成まで到達している`, st.section);
    if (st.section) {
      check(
        st.section.unavailable === null,
        `[断面/${tag}] 装置校正済みなので断面積が出る`,
        st.section.unavailable,
      );
      // 🔴 **既知の系統誤差と突き合わせる**（「妥当な範囲」で済ませない）。
      //    主枝の径は 3.5mm → 2.0mm の線形テーパー。さらに径は半値法で約 13% 過小に出る
      //    （§16.4 の係数 0.870）。
      //    ⚠️ 期待値は**区間によって違う**。病変を含む区間なら最小径は狭窄部の値
      //       （テーパー径 × (1 − %DS)）、含まない区間なら遠位端のテーパー径。
      //       ここを片方に決め打ちすると、もう一方の区間で必ず落ちる（実際に落とした）。
      const tLesion = truth.lesion.fractionOfMain;
      const tDistal = SEG_TO / (main1.pointsPx.length - 1);
      const truthMinDiameterMm = seg.hasLesion
        ? (3.5 - 1.5 * tLesion) * (1 - truth.lesion.percentDiameterStenosis / 100)
        : 3.5 - 1.5 * tDistal;
      const expectedMm = truthMinDiameterMm * KNOWN_DIAMETER_FACTOR;
      const eq = st.section.minEquivalentDiameterMm;
      check(
        eq != null && Math.abs(eq - expectedMm) < 0.35,
        `[断面/${tag}] 最小等価直径が既知の系統誤差どおり（真値 × ${KNOWN_DIAMETER_FACTOR}）`,
        {
          truthMm: Number(truthMinDiameterMm.toFixed(3)),
          expectedMm: Number(expectedMm.toFixed(3)),
          measuredMm: eq == null ? null : Number(eq.toFixed(3)),
        },
      );
      const ang = st.section.medianMeasurementAngleDeg;
      check(ang != null && ang > 0 && ang <= 90, `[断面/${tag}] 測定方向のなす角を出せている`, ang == null ? null : Number(ang.toFixed(1)));
    }

    // ── 保存（3D QCA SR）────────────────────────────────────
    check(st.steps.save === "active", `[保存/${tag}] 品質基準を満たしたので保存できる状態になる`, st.steps);
    await viewerB.getByTestId("xa3d-save").click();
    await viewerB.getByTestId("xa3d-saved").waitFor({ state: "visible", timeout: 15_000 });
    const savedText = await viewerB.getByTestId("xa3d-saved").textContent();
    check(!!savedText && savedText.length > 0, `[保存/${tag}] 保存に成功した`, savedText);
    const afterSave = await xa3dState(viewerB);
    check(afterSave?.steps.save === "done", `[保存/${tag}] レールの保存の段が done になる`, afterSave?.steps);
    // 🚨 数値だけでなく「どう作った結果か」が SR に入っていること（§10 の SR 方針）。
    const srSeries = await listSrSeries(driver.ports.http, v1.exact.studyInstanceUid);
    check(srSeries.some((x) => x.seriesDescription === "QCA 3D"), `[保存/${tag}] SR シリーズが保管庫に入る`, srSeries);

    // ── 3D の狭窄率（真値 50%）──────────────────────────────
    // 🚨 病変を含まない区間では「真値 50%」と比べられない。**区間に無い事実を検査しない**。
    if (!seg.hasLesion) {
      check(
        st.stenosis == null || st.stenosis.percentDiameterStenosis < 25,
        `[狭窄/${tag}] 病変の無い区間では狭窄率が小さく出る`,
        st.stenosis?.percentDiameterStenosis,
      );
    } else {
    check(st.stenosis != null, `[狭窄/${tag}] 3D の狭窄率まで到達している`, st.stenosis);
    if (st.stenosis) {
      const truthDs = truth.lesion.percentDiameterStenosis;
      // 🔑 狭窄率は**比**なので、半値法の 13% 過小はほぼ打ち消される（§10.2.8）。
      //    したがって MLD/RVD の絶対値と違い、**真値そのもの**と比べてよい。
      target(
        Math.abs(st.stenosis.percentDiameterStenosis - truthDs) < 10,
        `[狭窄/${tag}] 【目標】直径狭窄率が真値 ±10%`,
        {
          truth: truthDs,
          measured: Number(st.stenosis.percentDiameterStenosis.toFixed(1)),
          error: Number((st.stenosis.percentDiameterStenosis - truthDs).toFixed(1)),
        },
      );
      // 面積狭窄率は直径狭窄率から一意に決まる（1 −(1−r)²）。恒等式なので必ず合う。
      const r = 1 - st.stenosis.percentDiameterStenosis / 100;
      check(
        Math.abs(st.stenosis.percentAreaStenosis - (1 - r * r) * 100) < 1e-6,
        `[狭窄/${tag}] 面積狭窄率は直径狭窄率と整合する`,
        {
          as: Number(st.stenosis.percentAreaStenosis.toFixed(3)),
          expected: Number(((1 - r * r) * 100).toFixed(3)),
        },
      );
      check(
        st.stenosis.mldMm < st.stenosis.rvdMm,
        `[狭窄/${tag}] MLD が参照径を下回る`,
        { mld: Number(st.stenosis.mldMm.toFixed(3)), rvd: Number(st.stenosis.rvdMm.toFixed(3)) },
      );
      // 病変長 = 「径が参照径を下回る連続区間」（2D と同じ関数）。
      // 🔴 かつて **33.7mm / 真値 15.8mm** と出ていた。原因は判定でも 3D 特有の荒れでもなく、
      //    **参照径の当てはめが解析区間の端の数点に乗り上げていた**こと（2D も同じ壊れ方をしていた）。
      //    2026-08-16 に当てはめを外れ値に強いものへ作り直した（§10.2.8）。実測 16.75mm。
      //    σ̂ を一緒に記録する——「3D は荒れているから仕方ない」という説明が**成り立たない**
      //    ことの証拠（実測 σ̂ = 0.006mm ＝ 2D のノイズ無しフレームと同程度）。
      const truthLesionMm = mainTruth.lengthMm * truth.lesion.lengthFraction;
      target(
        Math.abs(st.stenosis.lesionLengthMm - truthLesionMm) < truthLesionMm * 0.2,
        `[狭窄/${tag}] 【目標】病変長が真値の ±20% に入る`,
        {
          truthMm: Number(truthLesionMm.toFixed(2)),
          measuredMm: Number(st.stenosis.lesionLengthMm.toFixed(2)),
          segmentMm: Number(st.result.lengthMm.toFixed(2)),
          profileNoiseMm: Number(st.stenosis.profileNoiseMm.toFixed(3)),
        },
      );
    }
    }

    // ── 3D ウィンドウへの受け渡し（幾何だけのビュー）────────────
    if (seg.hasLesion) {
      const geo = await driver.waitForNewPage(
        () => viewerB.getByTestId("xa3d-open-3d").click(),
        (url) => url.includes("geometry3d"),
      );
      await geo.getByTestId("geometry3d-root").waitFor({ state: "visible", timeout: 30_000 });
      await geo.waitForTimeout(2_500);
      const err = await geo.getByTestId("geometry3d-error").count();
      check(err === 0, `[3D表示/${tag}] エラーを出さずに開ける`, err);
      // 🚨 「開けた」だけでは描けていない。**シーンに物体が載り、canvas が黒一色でない**ことを見る。
      const scene = await geo.evaluate(`(() => {
        const host = document.querySelector('[data-testid="geometry3d-canvas-host"]');
        const canvas = host && host.querySelector("canvas");
        if (!canvas) return JSON.stringify({ canvas: false });
        const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
        return JSON.stringify({ canvas: true, gl: !!gl, w: canvas.width, h: canvas.height });
      })()`);
      const sc = JSON.parse(scene as string) as { canvas: boolean; gl?: boolean; w?: number; h?: number };
      check(sc.canvas && !!sc.gl && (sc.w ?? 0) > 100, `[3D表示/${tag}] WebGL の canvas が用意されている`, sc);
      // 🚨 **ここが本題。** canvas・WebGL・シーンの物体数・表示中の数値がすべて合格したまま
      //    **3D が真っ黒**だったことがある（カメラの視線と view-up が平行で退化していた。
      //    スクリーンショットを見て初めて分かった）。**描かれた画素を数える**。
      const statsRaw = (await geo.evaluate(`(() => {
        const g = window.__graphyDebug;
        const s = g && g.getGeometry3dStats ? g.getGeometry3dStats() : null;
        return s ? JSON.stringify(s) : null;
      })()`)) as string | null;
      const stats = statsRaw ? (JSON.parse(statsRaw) as { fraction: number; nonBackground: number }) : null;
      check(
        stats != null && stats.fraction > 0.001,
        `[3D表示/${tag}] ★実際に描かれている（背景でない画素がある）`,
        stats,
      );
      const title = await geo.getByTestId("geometry3d-title").textContent();
      check(!!title && title.includes("3D QCA"), `[3D表示/${tag}] 何を出しているかが画面に出る`, title);
      const lengthText = await geo.getByTestId("geometry3d-length").textContent();
      check(
        !!lengthText && lengthText.includes(st.result.lengthMm.toFixed(1)),
        `[3D表示/${tag}] ダイアログと同じ長さを出す（再計算しない）`,
        { shown: lengthText, want: st.result.lengthMm.toFixed(1) },
      );
      // シーン（既存の `scene3dStore`）に中心線が載っていること。
      const objects = await geo.getByTestId("geometry3d-objects").getAttribute("data-count");
      check(Number(objects) === 1, `[3D表示/${tag}] シーンに中心線が 1 本だけ載る（重ならない）`, objects);
      await geo.screenshot({ path: path.join(OUT_DIR, `4-${tag}-geometry3d.png`) }).catch(() => {});
      await geo.close().catch(() => {});
      await viewerB.waitForTimeout(500);
    }

    // ── 2D 投影長より 3D のほうが真値に近いこと（3D にする実利）──
    const proj2dMm = polylineLengthPx(seg1) * 0.225;
    const err2d = (Math.abs(proj2dMm - feedableLengthMm) / feedableLengthMm) * 100;
    check(lengthErrPct < err2d, `[実利/${tag}] ★3D 長さのほうが 2D 投影長より真値に近い`, {
      projected2dMm: Number(proj2dMm.toFixed(2)),
      error2dPct: Number(err2d.toFixed(2)),
      error3dPct: Number(lengthErrPct.toFixed(2)),
    });

    fs.writeFileSync(
      path.join(OUT_DIR, `result-${tag}.json`),
      JSON.stringify({ truthLengthMm: feedableLengthMm, state: st, lengthErrPct, err2d }, null, 2),
    );

    // 🚨 **区間の最後にビューアを閉じる。** 2D ビューアは 1 ウィンドウを使い回すので、
    //    開いたまま次の区間へ進むと、ダイアログが被って「長さ」ツールを選べずタイムアウトする
    //    （最初にこれを踏んだ。2 区間目の 2D QCA が始まる前で止まった）。
    await viewerB.close().catch(() => {});
    await mainPage.waitForTimeout(800);
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
  const ctx = {
    v1,
    v2,
    main1: v1.branchesPx.find((b) => b.id === "main")!,
    main2: v2.branchesPx.find((b) => b.id === "main")!,
    mainTruth: truth.branches.find((b) => b.id === "main")!,
    lesion: truth.lesion,
  };

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

    // 🚨 **2 区間を回す**。片方だけでは、その区間で起きない現象が検証から抜ける。
    for (const seg of SEGMENTS) {
      await analyseSegment(driver, mainPage, ctx, seg);
    }
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

/** スタディ内の SR シリーズ一覧（保存が保管庫まで届いたかの確認）。 */
async function listSrSeries(
  httpPort: number,
  studyUid: string,
): Promise<{ seriesInstanceUid: string; modality: string | null; seriesDescription: string | null }[]> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/studies/${encodeURIComponent(studyUid)}/series`);
  const all = (await res.json()) as {
    seriesInstanceUid: string;
    modality: string | null;
    seriesDescription: string | null;
  }[];
  return all.filter((s) => s.modality === "SR");
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
  tag = "",
): Promise<number> {
  const raw = (await viewer.evaluate(`(() => {
    const g = window.__graphyDebug;
    const s = g && g.getQcaState ? g.getQcaState() : null;
    return s && s.centerline ? JSON.stringify(s.centerline) : null;
  })()`)) as string | null;
  if (!raw) {
    check(false, `[2D/${tag}] 方向 ${name} — 中心線を抽出できた`);
    return 0;
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
  check(Math.max(d0, dN) < 6, `[2D/${tag}] 方向 ${name} — 計測を狙った画素に引けている`, {
    startOffPx: Number(d0.toFixed(1)),
    endOffPx: Number(dN.toFixed(1)),
    got: [pts[0], pts[pts.length - 1]],
    want: [truthPx[0], truthPx[truthPx.length - 1]],
  });
  const truthLen = polylineLengthPx(truthPx);
  const gotLen = polylineLengthPx(pts);
  check(rms < TOL_CENTERLINE_PX, `[2D/${tag}] 方向 ${name} — 抽出した中心線が真値に乗る（RMS < ${TOL_CENTERLINE_PX}px）`, {
    rmsPx: Number(rms.toFixed(2)),
    maxPx: Number(max.toFixed(2)),
    points: pts.length,
  });
  // 🔴 **現状の限界**（3D 側の退行ではないので `target` 扱い）。
  //    短縮した投影では、直進する近道も血管画素の上を通るため、自動追跡は弧長を取りこぼす。
  //    実測: 方向 B で 150.3px の真値に対し 136.0px（9.5% 短い）。これが 3D 長さ誤差 3.3% の主因。
  target(
    Math.abs(gotLen - truthLen) / truthLen < 0.05,
    `[2D/${tag}] 方向 ${name} — 【目標】中心線の長さが真値の 5% 以内（近道していない）`,
    {
      truthPx: Number(truthLen.toFixed(1)),
      gotPx: Number(gotLen.toFixed(1)),
      shortPct: Number((((truthLen - gotLen) / truthLen) * 100).toFixed(1)),
    },
  );
  return (truthLen - gotLen) / truthLen;
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

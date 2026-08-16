/*
 * 3D QCA 分岐部（A6b）の実機検証 — `fw/angio-design.md` §21.4。
 *
 * 準備:  cd bench && python3 make_phantom_xa.py --out ./phantom
 *        cd backend && mvn -q -Dfrontend.skip=true -DskipTests package
 * 実行:  cd automator && npx tsx src/spike/xaBifurcationCheck.ts
 *
 * <h3>ここで確かめたいこと</h3>
 * 1. **3 本（近位母血管 / 遠位母血管 / 側枝）を別々に 3D 再構成して測れる**こと。
 * 2. **分岐角が真値に合う**こと。GNBP-XA-3 の娘枝は生成器の作りから**厳密に 45°**で分岐し、
 *    5mm の窓で測ると 48.0° になる（`truth.recon3d.bifurcation`）。
 *    **2D では投影で潰れる量**なので、3D にする利得がそのまま出る。
 * 3. 🔑 **Finet / Murray との差が真値どおり**であること。このファントムは式を満たさない
 *    （Finet −15.4% / Murray −10.8%）。**差を出すだけで径を式に寄せていない**ことの検査になる。
 *    しかも**差の % は径の系統誤差（13% 過小）に依らない**（3 本とも同じ係数で縮むため）。
 * 4. **カリーナ周辺を測っていない**ことが数値（除外半径・除外長）で出ること。
 * 5. **Medina 分類を出していない**こと。
 *
 * <h3>⚠️ 短い枝を選んでいる理由</h3>
 * 分岐点をまたぐ区間は、**弦からの外れが探索窓（±40px）に収まる**かつ
 * **どちらの方向でも短縮していない**（弧長/弦長 < 1.15）ものしか使えない（§10.3.1）。
 * 真値の画素列で測った結果、view2+view4 の 近位 16〜27・遠位 27〜36・側枝 0〜28 が条件を満たす（最短の弦で 71px）。
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
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-bifurcation");
const HOST = "viewer2d-canvas-host";

/**
 * 使う 2 方向。
 *
 * <p>🔴 **単一血管（§10.3.1）で使った view1+view2（90°）は分岐部では使えない。**
 * 分岐点をまたぐ近位側の区間が view1 では強く短縮しており（弧長/弦長 1.22〜1.28）、
 * §10.3.1 と同じ理由で**自動追跡が弧長を取りこぼす**。真値の画素列で全ペアを当たった結果、
 * 3 本とも「短縮していない（< 1.15）・探索窓に収まる（< 38px）・画面で引ける長さがある」を
 * 同時に満たすのは **view2 + view4 だけ**だった。ただし視線の離角は **29°**（下限 25°）で、
 * 90° の単一血管より**深さ方向の精度は落ちる**。分岐角の目標を ±8° と緩めてあるのはこのため。
 */
const VIEW_A = 2;
const VIEW_B = 4;

/** 真値点列（60 点に間引いた主枝）の中での分岐位置。full index 404 / stride 15。 */
const BIF = 27;
/** 枝ごとの区間（上記の理由で短い）。 */
const BRANCH_SEGMENTS = {
  proximal: { branch: "main", from: 16, to: BIF },
  distal: { branch: "main", from: BIF, to: 36 },
  side: { branch: "daughter", from: 0, to: 28 },
} as const;

/** 【目標】角度の絶対誤差 [deg]。 */
const TARGET_ANGLE_DEG = 8;
/** 【目標】Finet / Murray の差の絶対誤差 [%pt]。 */
const TARGET_DEVIATION_PT = 8;

interface Truth {
  recon3d: {
    views: {
      view: number;
      exact: { file: string; studyInstanceUid: string; seriesInstanceUid: string };
      branchesPx: { id: string; pointsPx: [number, number][] }[];
    }[];
    bifurcation: {
      exactTakeOffDeg: number;
      angleWindowMm: number;
      distalToSideDeg: number;
      proximalToSideDeg: number;
      proximalToDistalDeg: number;
      diameterProximalMm: number;
      diameterSideMm: number;
      finetDeviationPercent: number;
      murrayDeviationPercent: number;
    };
  };
}

interface BifState {
  carina: [number, number, number];
  endpointSpreadMm: number;
  confluenceRadiusMm: number;
  branches: {
    id: string;
    measuredPoints: number;
    excludedLengthMm: number;
    mldMm: number | null;
    rvdMm: number | null;
    percentDiameterStenosis: number | null;
    lesionLengthMm: number | null;
    referenceAtCarinaMm: number | null;
  }[];
  angles: {
    proximalToDistalDeg: number | null;
    proximalToSideDeg: number | null;
    distalToSideDeg: number | null;
  };
  consistency: {
    finet: { expectedMm: number; measuredMm: number; deviationPercent: number } | null;
    murray: { expectedMm: number; measuredMm: number; deviationPercent: number } | null;
  };
  warnings: { code: string; branch: string | null; value: number; threshold: number }[];
  unrefinedBranches: string[];
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

function target(cond: boolean, label: string, detail?: unknown): void {
  if (cond) pass++;
  else unmet++;
  const d = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  lines.push(`  [${cond ? "ok  " : "UNMET"}] ${label}${d}`);
  console.log(lines[lines.length - 1]);
}

async function openStudy(page: Page, studyUid: string): Promise<void> {
  await dismissStartupDialogs(page);
  const blocker = await findBlockingOverlay(page, "search-submit-button");
  if (blocker) throw new Error(`検索ボタンが塞がれています: ${blocker}`);
  const dates = page.locator('input[type="date"]');
  await dates.nth(0).fill("");
  await dates.nth(1).fill("");
  await page.getByTestId("search-submit-button").click();
  const row = page.locator(`[data-testid="study-row-${studyUid}"]`);
  await row.waitFor({ state: "visible", timeout: 20_000 });
  for (let i = 0; i < 3; i++) {
    await row.click();
    await page.waitForTimeout(800);
    if ((await page.locator('[data-testid^="series-row-"]').count()) > 0) return;
  }
  throw new Error("シリーズ行が出ません");
}

async function selectLengthTool(viewer: Page): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-roi").click();
  await viewer.waitForTimeout(250);
  await viewer.getByText("長さ", { exact: true }).first().click();
  await viewer.waitForTimeout(300);
}

/** **真値の画素座標**の 2 点を結ぶ計測を引く。 */
async function drawBetweenImagePixels(viewer: Page, p0: [number, number], p1: [number, number]): Promise<void> {
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
 * 1 方向のビューアで、指定した 3 区間ぶんの 2D QCA を順に実行する。
 *
 * <p>⚠️ **計測は保管庫へ永続化され、開き直すと復元される**。区間ごとに
 * 「いま引いた長さに最も近い計測」を選び直さないと、**前の区間を解析してしまう**（§10.3.1）。
 */
async function runQcaForSegments(
  viewer: Page,
  ends: { key: string; p0: [number, number]; p1: [number, number] }[],
): Promise<void> {
  await selectLengthTool(viewer);
  for (const e of ends) {
    await drawBetweenImagePixels(viewer, e.p0, e.p1);
    await viewer.getByTestId("xa-analysis-open").click();
    await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });
    const wantPx = Math.hypot(e.p1[0] - e.p0[0], e.p1[1] - e.p0[1]);
    // 🚨 **いま引いた計測は一覧の末尾**（描いた順に並ぶ）。長さが近いものを探す方式では、
    //    区間の長さが似ていると**別の区間を解析して同じ結果を上書きする**
    //    （実機で「6 本のはずが 4 本」として出た）。末尾を選び、**長さで裏を取る**。
    const chosen = await viewer.evaluate(`(() => {
      const sel = document.querySelector('[data-testid="xa-analysis-pick"]');
      return sel ? JSON.stringify(Array.from(sel.options).map((o) => o.textContent)) : null;
    })()`);
    const labels = chosen ? (JSON.parse(chosen as string) as string[]) : [];
    if (labels.length === 0) throw new Error(`${e.key}: 計測が 1 本も無い（引けていない）`);
    const lastIndex = labels.length - 1;
    await viewer.selectOption('[data-testid="xa-analysis-pick"]', String(lastIndex));
    await viewer.waitForTimeout(400);
    const gotPx = parseFloat(/([\d.]+)\s*px/.exec(labels[lastIndex] ?? "")?.[1] ?? "NaN");
    check(
      Math.abs(gotPx - wantPx) < Math.max(6, wantPx * 0.12),
      `[QCA] ${e.key}: 引いた区間を解析対象に選べている`,
      { wantPx: Number(wantPx.toFixed(1)), gotPx },
    );
    await viewer.getByTestId("xa-qca-run").click();
    await viewer.waitForTimeout(3_500);
    // 解析できたか（失敗すると登録簿に載らず、あとで「本数が足りない」としか分からない）。
    const ok = await viewer.evaluate(`(() => {
      const g = window.__graphyDebug;
      const s = g && g.getQcaState ? g.getQcaState() : null;
      return s ? JSON.stringify({ points: s.points, unit: s.unit }) : null;
    })()`);
    check(!!ok, `[QCA] ${e.key}: 2D QCA が結果を出した`, ok);
    await viewer.getByTestId("xa-dialog-close").click();
    await viewer.waitForTimeout(400);
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(TRUTH_PATH)) throw new Error(`ファントムがありません: ${PHANTOM_DIR}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const truth = JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8")) as Truth;
  const bifTruth = truth.recon3d.bifurcation;
  if (!bifTruth) throw new Error("truth.json に recon3d.bifurcation がありません（ファントムを作り直す）");

  const viewOf = (n: number) => truth.recon3d.views.find((v) => v.view === n)!;
  const vA = viewOf(VIEW_A);
  const vB = viewOf(VIEW_B);
  const endsFor = (v: typeof vA) =>
    (Object.keys(BRANCH_SEGMENTS) as (keyof typeof BRANCH_SEGMENTS)[]).map((key) => {
      const seg = BRANCH_SEGMENTS[key];
      const pts = v.branchesPx.find((b) => b.id === seg.branch)!.pointsPx;
      return { key, p0: pts[seg.from], p1: pts[seg.to] };
    });

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [
      path.join(PHANTOM_DIR, vA.exact.file),
      path.join(PHANTOM_DIR, vB.exact.file),
    ]);
    check(imp.imported === 2, "[準備] 2 方向を取り込めた", imp);

    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    await openStudy(mainPage, vA.exact.studyInstanceUid);

    // ── 方向ごとに 3 区間の 2D QCA を回す（3D の登録簿に 6 本たまる）──────
    let viewer: Page | null = null;
    for (const v of [vA, vB]) {
      const row = mainPage.locator(`[data-testid="series-row-${v.exact.seriesInstanceUid}"]`);
      await row.waitFor({ state: "visible", timeout: 30_000 });
      await row.click();
      await mainPage.waitForTimeout(400);
      viewer = await driver.waitForNewPage(
        () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
        (url) => url.includes("2dviewer"),
      );
      await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
      await viewer.waitForTimeout(3_000);
      await runQcaForSegments(viewer, endsFor(v));
      // ⚠️ 2D ビューアは同じウィンドウを使い回すので、シリーズを変えるには一度閉じる。
      if (v !== vB) {
        await viewer.close();
        await mainPage.waitForTimeout(600);
      }
    }
    if (!viewer) throw new Error("ビューアを開けませんでした");

    // ── 分岐部ダイアログ ────────────────────────────────────────────
    await viewer.getByTestId("xa3dbif-open").click();
    await viewer.getByTestId("xa3dbif-dialog").waitFor({ state: "visible", timeout: 10_000 });

    const options = (await viewer.evaluate(`(() => {
      const sel = document.querySelector('[data-testid="xa3dbif-proximal-a"]');
      return sel ? JSON.stringify(Array.from(sel.options).map((o) => [o.value, o.textContent])) : null;
    })()`)) as string | null;
    const opts = options ? (JSON.parse(options) as [string, string][]).filter(([v]) => v) : [];
    check(opts.length === 6, "[登録] 3 本 × 2 方向 ＝ 6 本の 2D QCA が登録簿に載っている", opts.length);
    if (opts.length !== 6) {
      throw new Error(`2D QCA の登録数が想定と違います: ${JSON.stringify(opts.map((o) => o[1]))}`);
    }
    // 登録順は実行順（近位→遠位→側枝 を方向 A・B の順）。
    const order: [keyof typeof BRANCH_SEGMENTS, number, number][] = [
      ["proximal", 0, 3],
      ["distal", 1, 4],
      ["side", 2, 5],
    ];
    for (const [role, ia, ib] of order) {
      await viewer.selectOption(`[data-testid="xa3dbif-${role}-a"]`, opts[ia][0]);
      await viewer.selectOption(`[data-testid="xa3dbif-${role}-b"]`, opts[ib][0]);
      await viewer.waitForTimeout(150);
    }
    await viewer.getByTestId("xa3dbif-run").click();
    await viewer.waitForTimeout(3_000);

    const st = (await viewer.evaluate(`(() => {
      const g = window.__graphyDebug;
      const s = g && g.getXaBifurcationState ? g.getXaBifurcationState() : null;
      return s ? JSON.stringify(s) : null;
    })()`)) as string | null;
    if (!st) {
      const err = await viewer.getByTestId("xa3dbif-error").textContent().catch(() => null);
      check(false, "[解析] 分岐部を解析できた", err);
      await viewer.screenshot({ path: path.join(OUT_DIR, "1-failed.png") }).catch(() => {});
      return;
    }
    const s = JSON.parse(st) as BifState;
    fs.writeFileSync(path.join(OUT_DIR, "bifurcation.json"), JSON.stringify({ truth: bifTruth, measured: s }, null, 2));
    check(true, "[解析] 分岐部を解析できた");

    const byId = Object.fromEntries(s.branches.map((b) => [b.id, b]));
    for (const role of ["proximal", "distal", "side"]) {
      check(
        (byId[role]?.measuredPoints ?? 0) >= 3 && byId[role]?.rvdMm != null,
        `[枝] ${role} を測れている`,
        byId[role],
      );
    }
    // ── ★ カリーナ周辺を測っていないことが数値で出る ──────────────────
    check(s.confluenceRadiusMm > 0.5, "[除外] ★カリーナ周辺の除外半径が出ている（母血管 1 径ぶん）", {
      radiusMm: Number(s.confluenceRadiusMm.toFixed(2)),
    });
    check(
      s.branches.every((b) => b.excludedLengthMm > 0),
      "[除外] ★3 本とも除外した長さが出ている（測っていない範囲を黙らせない）",
      s.branches.map((b) => ({ id: b.id, mm: Number(b.excludedLengthMm.toFixed(2)) })),
    );
    const shownConfluence = await viewer.getByTestId("xa3dbif-confluence").textContent();
    check(
      (shownConfluence ?? "").includes(s.confluenceRadiusMm.toFixed(2)),
      "[除外] 画面にも除外半径が数値で出ている",
      (shownConfluence ?? "").slice(0, 60),
    );

    // ── ★ 分岐角（3D にする利得そのもの）────────────────────────────
    target(
      s.angles.distalToSideDeg != null &&
        Math.abs(s.angles.distalToSideDeg - bifTruth.distalToSideDeg) < TARGET_ANGLE_DEG,
      `[角度] ★【目標】分岐角（遠位↔側枝）が真値 ±${TARGET_ANGLE_DEG}°`,
      { truth: bifTruth.distalToSideDeg, measured: Number((s.angles.distalToSideDeg ?? NaN).toFixed(2)) },
    );
    target(
      s.angles.proximalToSideDeg != null &&
        Math.abs(s.angles.proximalToSideDeg - bifTruth.proximalToSideDeg) < TARGET_ANGLE_DEG,
      `[角度] 【目標】近位↔側枝が真値 ±${TARGET_ANGLE_DEG}°`,
      { truth: bifTruth.proximalToSideDeg, measured: Number((s.angles.proximalToSideDeg ?? NaN).toFixed(2)) },
    );
    target(
      s.angles.proximalToDistalDeg != null &&
        Math.abs(s.angles.proximalToDistalDeg - bifTruth.proximalToDistalDeg) < TARGET_ANGLE_DEG,
      `[角度] 【目標】近位↔遠位が真値 ±${TARGET_ANGLE_DEG}°`,
      { truth: bifTruth.proximalToDistalDeg, measured: Number((s.angles.proximalToDistalDeg ?? NaN).toFixed(2)) },
    );

    // ── 🔑 Finet / Murray の差（**径の系統誤差に依らない量**）──────────
    target(
      s.consistency.finet != null &&
        Math.abs(s.consistency.finet.deviationPercent - bifTruth.finetDeviationPercent) < TARGET_DEVIATION_PT,
      `[妥当性] ★【目標】Finet との差が真値どおり（このファントムは式を満たさない）`,
      {
        truth: bifTruth.finetDeviationPercent,
        measured: Number((s.consistency.finet?.deviationPercent ?? NaN).toFixed(2)),
      },
    );
    target(
      s.consistency.murray != null &&
        Math.abs(s.consistency.murray.deviationPercent - bifTruth.murrayDeviationPercent) < TARGET_DEVIATION_PT,
      `[妥当性] 【目標】Murray との差が真値どおり`,
      {
        truth: bifTruth.murrayDeviationPercent,
        measured: Number((s.consistency.murray?.deviationPercent ?? NaN).toFixed(2)),
      },
    );
    // ★ 式で径を書き換えていない（実測の参照径は式の期待値と違う）。
    check(
      s.consistency.finet != null &&
        Math.abs(s.consistency.finet.measuredMm - s.consistency.finet.expectedMm) > 0.1,
      "[妥当性] ★参照径が式に寄せられていない（差を出すだけ）",
      s.consistency.finet,
    );

    // ── 出さないものを出していない ────────────────────────────────
    check(!/medina/i.test(st), "[方針] ★Medina 分類を出していない");
    check(
      (await viewer.getByTestId("xa3dbif-no-medina").count()) === 1,
      "[方針] 「分類は自動で出さない」と画面に書いてある",
    );
    // アンカーを取らない画面なので、角度補正が掛かっていないことは**必ず**出す。
    if (s.unrefinedBranches.length > 0) {
      check(
        (await viewer.getByTestId("xa3dbif-unrefined").count()) === 1,
        "[出自] ★角度補正が掛かっていない枝があることを画面に出している",
        s.unrefinedBranches,
      );
    }
    check(
      s.warnings.every((w) => w.code !== "endpointsApart"),
      "[整合] 3 本の端点がそろっている（同じ分岐を指している）",
      { spreadMm: Number(s.endpointSpreadMm.toFixed(2)) },
    );

    await viewer.screenshot({ path: path.join(OUT_DIR, "1-bifurcation.png") }).catch(() => {});
    console.table(
      s.branches.map((b) => ({
        branch: b.id,
        rvd: b.rvdMm == null ? null : Number(b.rvdMm.toFixed(3)),
        mld: b.mldMm == null ? null : Number(b.mldMm.toFixed(3)),
        ds: b.percentDiameterStenosis == null ? null : Number(b.percentDiameterStenosis.toFixed(1)),
        points: b.measuredPoints,
        excludedMm: Number(b.excludedLengthMm.toFixed(2)),
      })),
    );
  } finally {
    await driver.stop().catch(() => {});
    const summary = `\n===== 分岐部 QCA（A6b・GNBP-XA-3）実機検証 =====\n合格 ${pass} / 失敗 ${fail} / 設計目標に未達 ${unmet}`;
    console.log(summary);
    fs.writeFileSync(path.join(OUT_DIR, "log.txt"), lines.join("\n") + summary + "\n");
  }
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

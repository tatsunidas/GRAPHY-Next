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
 * 6. 🔴 **同じ点から次の区間を引ける**こと。分岐部は 3 本がカリーナで出会うので、
 *    既存注釈のハンドル（半径 6px）を掴んで**前の計測が伸びる**（実機で 89.5px → 207px）。
 *    解析済みの計測をロックして避けている。本数が 1 本ずつ増えるかで検査する。
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

interface VariantFiles {
  file: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
}

/**
 * どの版で回すか。`GNBP_XA3_VARIANT=exact | c-noise-low | d-noise-mid | e-noise-high`。
 *
 * 🔴 **合否の基準線は `exact` のまま**（46/0/3・2026-08-16）。ノイズ版で見るのは合否ではなく
 * **劣化の仕方**——急に壊れるなら、無ノイズでの合格は紙一重で成立していたことになる。
 */
const VARIANT = process.env.GNBP_XA3_VARIANT ?? "exact";

interface Truth {
  geometry: { mmPerPxAtIsocenter: number };
  recon3d: {
    views: {
      view: number;
      exact: VariantFiles;
      /**
       * 既知の角度誤差を焼き込んだ版（段 3 の検査に使う）。タグの角度が真値からずれている。
       */
      angleError?: VariantFiles & { primaryErrorDeg: number; secondaryErrorDeg: number };
      /** ノイズ層（段 2b）。**形状と真値は `exact` と同一で、量子ノイズだけが違う。** */
      noise?: Record<string, VariantFiles & { photons: number; backgroundRelativeSigma: number }>;
      branchesPx: { id: string; pointsPx: [number, number][] }[];
    }[];
    branches: {
      id: string;
      pointStrideOfFull: number;
      fullPointCount: number;
      diameterProximalMm: number;
      diameterDistalMm: number;
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
  viewPairShared: boolean;
  refinement: {
    applied: boolean;
    beforePx: number;
    afterPx: number;
    primaryDeg: number;
    secondaryDeg: number;
    anchorCount: number;
  } | null;
  /** 再構成した 3D 中心線（切り分け用。合否には使わない）。 */
  branchPoints?: { id: string; points: [number, number, number][] }[];
}

let pass = 0;
let fail = 0;
let unmet = 0;
const lines: string[] = [];
/** 各区間の **2D** QCA の径（3D と切り分けるために控える）。 */
const twoD: { key: string; mld: number; rvd: number; referenceFirst: number; referenceLast: number }[] = [];

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
  /** 画像 px → mm（校正済みなら一覧のラベルが mm で出るため、期待値の換算に要る）。 */
  mmPerPx: number,
): Promise<void> {
  await selectLengthTool(viewer);
  let drawn = 0;
  for (const e of ends) {
    await drawBetweenImagePixels(viewer, e.p0, e.p1);
    drawn++;
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
    // 🔑 **本数が 1 本ずつ増えているか**を先に見る。分岐部は次の区間を**前の区間の終点
    //    （＝カリーナ）から**引くので、Cornerstone が既存注釈のハンドルを掴むと
    //    **新しい計測が生まれず、前の計測が伸びる**。長さだけを見ていると
    //    「似た長さの別区間を解析した」と区別が付かない（実機で踏んだ）。
    check(labels.length === drawn, `[描画] ${e.key}: 新しい計測が 1 本増えた（既存を掴んでいない）`, {
      drawn,
      picks: labels.length,
    });
    const lastIndex = labels.length - 1;
    await viewer.selectOption('[data-testid="xa-analysis-pick"]', String(lastIndex));
    await viewer.waitForTimeout(400);
    // 🚨 **一覧のラベルは校正済みなら mm で書かれる**（`pickLabel()`）。
    //    px 前提で読んでいたため、校正が付くようになった時点で**この検査は必ず失敗**していた
    //    （2026-09-02 に発覚。6 件の「失敗」はすべてこれで、製品の不具合ではなかった）。
    //    2026-08-16 に 46/0 で通っていたのは、当時この経路が px だったから。
    //    → **単位ごと読み、期待値を同じ単位へ換算して比べる。**
    const m = /([\d.]+)\s*(mm|px)/.exec(labels[lastIndex] ?? "");
    const got = m ? parseFloat(m[1]) : Number.NaN;
    const unit = m?.[2] ?? "?";
    const want = unit === "mm" ? wantPx * mmPerPx : wantPx;
    check(
      Number.isFinite(got) && Math.abs(got - want) < Math.max(unit === "mm" ? 6 * mmPerPx : 6, want * 0.12),
      `[QCA] ${e.key}: 引いた区間を解析対象に選べている`,
      { want: Number(want.toFixed(2)), got, unit, label: labels[lastIndex] },
    );
    await viewer.getByTestId("xa-qca-run").click();
    await viewer.waitForTimeout(3_500);
    // 解析できたか（失敗すると登録簿に載らず、あとで「本数が足りない」としか分からない）。
    const ok = await viewer.evaluate(`(() => {
      const g = window.__graphyDebug;
      const s = g && g.getQcaState ? g.getQcaState() : null;
      return s ? JSON.stringify({
        points: s.points, unit: s.unit, mld: s.mld, rvd: s.rvd,
        referenceFirst: s.referenceFirst, referenceLast: s.referenceLast,
      }) : null;
    })()`);
    check(!!ok, `[QCA] ${e.key}: 2D QCA が結果を出した`, ok);
    // 🔑 **2D の径をここで控える**。3D の径がおかしいとき、2D から太いのか
    //    合成で太るのかは、後から結果だけ見ても分からない（実機で側枝の参照径が
    //    真値の 1.5 倍になったとき、どちらの段かを切り分けられなかった）。
    if (ok) {
      const q = JSON.parse(ok as string) as {
        mld: number;
        rvd: number;
        referenceFirst: number;
        referenceLast: number;
      };
      twoD.push({ key: e.key, mld: q.mld, rvd: q.rvd, referenceFirst: q.referenceFirst, referenceLast: q.referenceLast });
    }
    // 解析した計測はロックされる（次の区間を同じ点から引けるようにするため。§21.4.2 の 2）。
    check(
      (await viewer.getByTestId("xa-pick-locked").count()) === 1,
      `[ロック] ${e.key}: 解析に使った計測がロックされた`,
    );
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
  const filesOf = (v: {
    exact: VariantFiles;
    angleError?: VariantFiles;
    noise?: Record<string, VariantFiles>;
  }): VariantFiles => {
    if (VARIANT === "exact") return v.exact;
    const found = VARIANT === "b-angle-error" ? v.angleError : v.noise?.[VARIANT];
    if (!found) throw new Error(`truth.json に版 "${VARIANT}" がありません（ファントムを作り直す）`);
    return found;
  };
  const vA = viewOf(VIEW_A);
  const vB = viewOf(VIEW_B);
  const fA = filesOf(vA);
  const fB = filesOf(vB);
  console.log(`[版] ${VARIANT}`);
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
      path.join(PHANTOM_DIR, fA.file),
      path.join(PHANTOM_DIR, fB.file),
    ]);
    check(imp.imported === 2, "[準備] 2 方向を取り込めた", imp);

    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    await openStudy(mainPage, fA.studyInstanceUid);

    // ── 方向ごとに 3 区間の 2D QCA を回す（3D の登録簿に 6 本たまる）──────
    let viewer: Page | null = null;
    for (const v of [vA, vB]) {
      const row = mainPage.locator(`[data-testid="series-row-${filesOf(v).seriesInstanceUid}"]`);
      await row.waitFor({ state: "visible", timeout: 30_000 });
      await row.click();
      await mainPage.waitForTimeout(400);
      viewer = await driver.waitForNewPage(
        () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
        (url) => url.includes("2dviewer"),
      );
      await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
      await viewer.waitForTimeout(3_000);
      await runQcaForSegments(viewer, endsFor(v), truth.geometry.mmPerPxAtIsocenter);
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
    // 3D 中心線は別ファイルへ（数値が合わないときに、追跡か再構成かを後から切り分けるため）。
    if (s.branchPoints) {
      fs.writeFileSync(path.join(OUT_DIR, "branch-points.json"), JSON.stringify(s.branchPoints));
    }
    check(true, "[解析] 分岐部を解析できた");

    // ── 2D の径と真値（ファントムのテーパは既知）─────────────────────────
    // 半値法の系統誤差で **13% 前後過小**に出るのが正常。真値より**大きい**なら、
    // それは系統誤差では説明できない＝別の血管を測っている（分岐部では母血管との重なり）。
    const truthDiameterAt = (branch: string, index: number): number => {
      const b = truth.recon3d.branches.find((x) => x.id === branch)!;
      const full = index * b.pointStrideOfFull;
      const f = full / (b.fullPointCount - 1);
      return b.diameterProximalMm + (b.diameterDistalMm - b.diameterProximalMm) * f;
    };
    console.table(
      twoD.map((d) => {
        const seg = BRANCH_SEGMENTS[d.key as keyof typeof BRANCH_SEGMENTS];
        const nearCarina = seg.branch === "main" && seg.to === BIF ? seg.to : seg.from;
        const truthMm = truthDiameterAt(seg.branch, nearCarina);
        const atCarina = seg.branch === "main" && seg.to === BIF ? d.referenceLast : d.referenceFirst;
        return {
          seg: d.key,
          真値mm: Number(truthMm.toFixed(3)),
          "2D参照径(カリーナ側)": Number(atCarina.toFixed(3)),
          比: Number((atCarina / truthMm).toFixed(3)),
          "2D rvd": Number(d.rvd.toFixed(3)),
        };
      }),
    );
    for (const d of twoD) {
      const seg = BRANCH_SEGMENTS[d.key as keyof typeof BRANCH_SEGMENTS];
      const nearCarina = seg.branch === "main" && seg.to === BIF ? seg.to : seg.from;
      const truthMm = truthDiameterAt(seg.branch, nearCarina);
      const atCarina = seg.branch === "main" && seg.to === BIF ? d.referenceLast : d.referenceFirst;
      // 【目標】であって退行検査ではない。**投影で重なった血管を追跡してしまうのは
      // 2D 追跡の原理的な限界**で、実装の不備ではない（§21.4.3）。壊れたことを
      // 黙らせないほうは別に検査する（daughterWiderThanMother の警告）。
      target(
        atCarina < truthMm * 1.05,
        `[2D] 【目標】${d.key}: カリーナ側の参照径が真値を超えない（超えたら母血管と重なって測っている）`,
        { truthMm: Number(truthMm.toFixed(3)), measuredMm: Number(atCarina.toFixed(3)) },
      );
    }

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
    // ── 角度補正（§21.4 の段 3）────────────────────────────────────
    //
    // 🔴 **この検査は 2026-09-02 に反転した。** それまでは「角度補正が掛かっていない枝がある
    //    ことを画面に出している」を合格条件にしていた。枝の両端 2 点しか渡しておらず、
    //    未知数 2 に対して拘束が 2 では意味のある解が出ないため実装が拒否していたのが実態で、
    //    **3 枝すべてで補正が一度も掛かっていなかった**。3 枝ぶん束ねて 6 対応にしたので、
    //    いまは**掛かることが正常**である。
    check(s.viewPairShared, "[出自] 3 枝が同じ視点ペアから取られている（束ねる前提）", {
      shared: s.viewPairShared,
    });
    check(
      s.refinement != null && s.unrefinedBranches.length === 0,
      "[出自] ★角度補正を 3 枝まとめて評価している",
      { refinement: s.refinement, unrefined: s.unrefinedBranches },
    );
    if (s.refinement) {
      check(
        s.refinement.anchorCount === 6,
        "[出自] 3 枝 × 両端 = 6 対応を束ねている（3 未満では退化する）",
        { anchorCount: s.refinement.anchorCount },
      );
      check(
        s.refinement.afterPx <= s.refinement.beforePx + 1e-6,
        "[出自] 当てはめで再投影誤差が悪化していない",
        { beforePx: s.refinement.beforePx, afterPx: s.refinement.afterPx },
      );
      // 🔴 **これが段 3 の本体の検査**（2026-09-02）。
      //    補正は「装置の角度誤差」と「端点の対応ずれ」を区別できず、どちらも角度に吸わせる。
      //    したがって **掛けられること自体は正しさの証拠にならない**。見るのは
      //    「直すべき誤差があるときだけ掛けているか」——**版によって期待が逆になる**。
      const off = Math.max(Math.abs(s.refinement.primaryDeg), Math.abs(s.refinement.secondaryDeg));
      if (VARIANT === "b-angle-error") {
        check(s.refinement.applied, "[出自] ★焼き込んだ角度誤差に対しては補正を掛けている", {
          beforePx: s.refinement.beforePx,
          afterPx: s.refinement.afterPx,
        });
        // ⚠️ 視点 A を固定するので「注入した誤差の符号違い」にはならない
        //（B は歪んだ A と辻褄が合う位置へ動く）。**大きさが 0 でないこと**を見る。
        check(off > 0.5, "[出自] 回収した角度オフセットが 0 でない", {
          offsetDeg: [s.refinement.primaryDeg, s.refinement.secondaryDeg],
        });
        check(
          (await viewer.getByTestId("xa3dbif-refined").count()) === 1,
          "[出自] 補正を掛けたことと回収量を画面に出している",
        );
      } else {
        // 🔴 **厳密な幾何では「掛けない」のが正解。** 直すべき誤差が無いのに掛けると、
        //    端点のずれを角度に付け替えた**作り話**になる（実測: 0.67° の偽の回転で
        //    分岐角が 3 つ中 2 つ悪化した）。
        check(!s.refinement.applied, "[出自] ★厳密な幾何では角度補正を掛けていない", {
          beforePx: s.refinement.beforePx,
          candidateOffsetDeg: [s.refinement.primaryDeg, s.refinement.secondaryDeg],
        });
        check(
          (await viewer.getByTestId("xa3dbif-refine-skipped").count()) === 1,
          "[出自] 掛けなかったことを画面に出している（黙って諦めない）",
        );
        void off;
      }
    }
    check(
      s.warnings.every((w) => w.code !== "endpointsApart"),
      "[整合] 3 本の端点がそろっている（同じ分岐を指している）",
      { spreadMm: Number(s.endpointSpreadMm.toFixed(2)) },
    );
    // ★ 側枝が母血管に乗って測られていることを、**数値が狂ったまま黙らせない**。
    //    この検査は「正しく測れた」ではなく「壊れているときに壊れていると言う」ことの検査。
    const wider = s.warnings.find((w) => w.code === "daughterWiderThanMother");
    const sideRefMm = byId.side?.referenceAtCarinaMm ?? null;
    const proxRefMm = byId.proximal?.referenceAtCarinaMm ?? null;
    if (sideRefMm != null && proxRefMm != null && sideRefMm > proxRefMm) {
      check(!!wider, "[出自] ★娘枝が母血管より太いことを警告している（重なりを黙らせない）", {
        sideMm: Number(sideRefMm.toFixed(2)),
        proximalMm: Number(proxRefMm.toFixed(2)),
      });
      check(
        (await viewer.getByTestId("xa3dbif-warn-daughterWiderThanMother").count()) === 1,
        "[出自] ★その警告が画面にも出ている",
      );
    }

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

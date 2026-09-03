/*
 * FFR 骨組みプラグインの実機検証 — `fw/angio-design.md` §11.5 / A7 の第 1 段。
 *
 * 実行:  cd automator && npx tsx src/spike/ffrPluginCheck.ts
 *
 * <h3>なぜ要るのか</h3>
 * A7（FFR インターフェース）は本体側の口（H11 / H12・色マップ）まで実装済みだが、
 * 🔴 **プラグイン → host の本番経路は一度も通っていない**。
 *
 * - vitest 52 件が守っているのは `pluginVesselApi` の**純関数**
 * - 既存の実機検証（`xa3dQcaCheck.ts` の `[FFR/...]`）は
 *   **`__graphyDebug.seedVesselAnalysis()` 経由**＝プラグインを通らない
 * - `Viewer2DMenuBar.tsx`（producer を注入する場所）に**テストが無い**
 *
 * つまり「動くはず」の状態で、実際にプラグインから呼んだことが無い。
 * 型は手書きの写しなので TypeScript は写し間違いを教えてくれない
 * （`openWindow().root` / `.container`、`ViewerRoi.toolName` / `.tool` で 2 回踏んでいる）。
 *
 * <h3>🔴 これは FFR の検証ではない</h3>
 * プラグイン側の計算は**径の比から作った当てずっぽう**で、流体解析も学習モデルもしていない。
 * ここで確かめるのは**経路**（モデルが渡り、値が戻り、色が乗るか）だけ。
 *
 * 🚨 走らせる前に `.results/ffr-plugin` を消す（失敗した実行が前回の成果物を持ち帰る）。
 * 🚨 編集直後の 1 回目は測定値として使わない。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";

const REPO_ROOT = path.resolve(AUTOMATOR_ROOT, "..");
const PHANTOM_DIR = path.join(REPO_ROOT, "bench", "phantom", "GNBP-XA");
const TRUTH_PATH = path.join(PHANTOM_DIR, "truth.json");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "ffr-plugin");
const HOST = "viewer2d-canvas-host";
const PLUGIN_ID = "ffr-skeleton";
/** 解析する区間（`xa3dQcaCheck` と同じ「本幹の狭窄をまたぐ範囲」）。 */
const SEG_FROM = 10;
const SEG_TO = 46;

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  const d = detail === undefined ? "" : ` — ${JSON.stringify(detail)}`;
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${d}`);
  } else {
    console.log(`  [FAIL] ${label}${d}`);
    failures.push(label);
  }
}

interface Truth {
  recon3d: {
    views: {
      exact: { file: string; studyInstanceUid: string; seriesInstanceUid: string };
      branchesPx: { id: string; pointsPx: [number, number][] }[];
    }[];
  };
}

/** プラグインが書いた結果（`window.__ffrSkeleton`）。 */
interface FfrPayload {
  surface: string | null;
  hasListVesselModels: boolean;
  hasGetVesselModel: boolean;
  hasPutVesselAnalysis: boolean;
  hostKeys: string[];
  summaries: { runId: string; kind: string; segmentCount: number; pointCount: number }[] | null;
  model: {
    runId: string;
    kind: string;
    segmentIds: string[];
    segmentPointCounts: number[];
    diameterNullCounts: number[];
    diameterCalibrated: boolean;
    diameterMethod: string | null;
    angleCorrected: boolean | null;
    firstPoint: number[] | null;
    lastPoint: number[] | null;
  } | null;
  perPointCount?: number;
  put: { ok: boolean; error: string | null } | null;
  error: string | null;
}

/** 検証用プラグインを backend の plugins フォルダへ置く（第三者の手置きと同じ形）。 */
function installPlugin(): void {
  const src = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, name), path.join(dst, name));
  }
  console.log(`検証用プラグインを配置: ${dst}`);
}

async function openStudy(page: Page, studyUid: string): Promise<void> {
  await dismissStartupDialogs(page);
  const dates = page.locator('input[type="date"]');
  await dates.nth(0).fill("");
  await dates.nth(1).fill("");
  await page.getByTestId("search-submit-button").click();
  const row = page.locator(`[data-testid="study-row-${studyUid}"]`);
  await row.waitFor({ state: "visible", timeout: 20_000 });
  await row.click();
  await page.waitForTimeout(600);
}

async function selectLengthTool(viewer: Page): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-roi").click();
  await viewer.waitForTimeout(250);
  await viewer.getByText("長さ", { exact: true }).first().click();
  await viewer.waitForTimeout(300);
}

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
  await dragOnCanvasHost(viewer, HOST, dx, dy, 0, 14, { fracX: f[0].fx, fracY: f[0].fy });
  await viewer.waitForTimeout(800);
}

/** 1 方向ぶんの 2D QCA を走らせ、3D の登録簿に載せる。 */
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

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(TRUTH_PATH)) {
    throw new Error(
      `ファントムがありません: ${PHANTOM_DIR}\n` +
        `先に "cd bench && python3 make_phantom_xa.py --out ./phantom" を実行してください。`,
    );
  }
  const truth = (JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8")) as Truth).recon3d;
  const v1 = truth.views[0];
  const v2 = truth.views[1];
  const ends = (v: typeof v1): [[number, number], [number, number]] => {
    const pts = v.branchesPx.find((b) => b.id === "main")!.pointsPx;
    return [pts[SEG_FROM], pts[SEG_TO]];
  };

  installPlugin();

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [
      path.join(PHANTOM_DIR, v1.exact.file),
      path.join(PHANTOM_DIR, v2.exact.file),
    ]);
    check(imp.imported === 2, "[準備] 2 方向を取り込めた", imp);

    await waitForMainScreenReady(mainPage, 60_000);
    await openStudy(mainPage, v1.exact.studyInstanceUid);

    // ── 1. 2 方向の 2D QCA（3D の材料）────────────────────────────
    let viewer = await runQcaForView(driver, mainPage, v1.exact.seriesInstanceUid, ends(v1));
    await viewer.close();
    await mainPage.waitForTimeout(600);
    viewer = await runQcaForView(driver, mainPage, v2.exact.seriesInstanceUid, ends(v2));

    // ── 2. 3D QCA を走らせて血管モデルを登録させる ────────────────
    await viewer.getByTestId("xa3d-open").click();
    await viewer.getByTestId("xa3d-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await viewer.waitForTimeout(500);
    const opts = (await viewer.evaluate(`(() => {
      const a = document.querySelector('[data-testid="xa3d-view-a"]');
      return a ? JSON.stringify(Array.from(a.options).map((o) => o.value)) : null;
    })()`)) as string | null;
    const values = opts ? (JSON.parse(opts) as string[]).filter(Boolean) : [];
    check(values.length >= 2, "[準備] 2D QCA が 2 本そろっている", { n: values.length });
    if (values.length >= 2) {
      await viewer.selectOption('[data-testid="xa3d-view-a"]', values[0]);
      await viewer.selectOption('[data-testid="xa3d-view-b"]', values[1]);
      await viewer.waitForTimeout(300);
      await viewer.getByTestId("xa3d-run").click();
      await viewer.waitForTimeout(4_000);
    }
    const models = (await viewer.evaluate(`(() => {
      const g = window.__graphyDebug;
      const m = g && g.getVesselModels ? g.getVesselModels() : null;
      return m ? JSON.stringify(m) : null;
    })()`)) as string | null;
    const modelList = models ? (JSON.parse(models) as unknown[]) : [];
    check(modelList.length >= 1, "[準備] ★血管モデルが登録された（H11 の材料）", {
      n: modelList.length,
    });
    // 🚨 **3D QCA のダイアログを閉じる。** モーダルなので開いたままだとプラグインメニューを
    //    押せない。血管モデルは登録簿（`xaVesselModelStore`）に残るので、閉じても H11 から見える。
    await viewer.getByTestId("xa3d-close").click();
    await viewer.waitForTimeout(600);
    if (await viewer.getByTestId("xa3d-dialog").isVisible().catch(() => false)) {
      // 閉じるボタンで閉じなければ backdrop（画面全体を覆う）を押す。
      await viewer.mouse.click(5, 5);
      await viewer.waitForTimeout(600);
    }
    // 🚨 **「閉じるを押した」と「閉じた」は別物。** 検査していなかったため、次の操作が
    //    「ダイアログに塞がれた」という分かりにくい形で落ちていた（2026-09-03）。
    check(
      !(await viewer.getByTestId("xa3d-dialog").isVisible().catch(() => false)),
      "[準備] 3D QCA のダイアログを閉じられた（次の操作を塞がない）",
    );

    // ── 3. 🔴 ここからが本題: プラグインから H11 / H12 を呼ぶ ──────
    await viewer.evaluate(() => {
      delete (window as unknown as { __ffrSkeleton?: unknown }).__ffrSkeleton;
    });
    const menu = viewer.getByTestId("viewer2d-menu-plugins");
    check(await menu.isVisible().catch(() => false), "[3] プラグインメニューが出る");
    await menu.click();
    await viewer.waitForTimeout(300);
    const item = viewer.getByTestId(`plugin-item-${PLUGIN_ID}`);
    check(
      await item.isVisible().catch(() => false),
      "[3] ★骨組みプラグインが一覧に出る（手置きで導入できる）",
    );
    await item.click();
    await viewer.waitForTimeout(2_500);

    const payload = (await viewer.evaluate(
      () => (window as unknown as { __ffrSkeleton?: FfrPayload }).__ffrSkeleton ?? null,
    )) as FfrPayload | null;
    fs.writeFileSync(path.join(OUT_DIR, "payload.json"), JSON.stringify(payload, null, 2));
    check(!!payload, "[3] プラグインが動いた（結果を書いた）");
    if (payload) {
      // 🔴 契約の写し間違いはここに出る。「生えているか」を名前で確かめる。
      check(payload.hasListVesselModels, "[3] ★host に listVesselModels が生えている（H11）", {
        hostKeys: payload.hostKeys,
      });
      check(payload.hasGetVesselModel, "[3] ★host に getVesselModel が生えている（H11）");
      check(payload.hasPutVesselAnalysis, "[3] ★host に putVesselAnalysis が生えている（H12）");
      check(payload.error == null, "[3] ★プラグインがエラー無く走り切った", {
        error: payload.error,
      });
      check(
        (payload.summaries?.length ?? 0) >= 1,
        "[3] ★プラグインからモデルの一覧が見える",
        payload.summaries,
      );
      check(!!payload.model, "[3] ★プラグインからモデル本体が取れる", {
        segmentIds: payload.model?.segmentIds,
        pointCounts: payload.model?.segmentPointCounts,
      });
      if (payload.model) {
        check(
          (payload.model.segmentPointCounts[0] ?? 0) > 10,
          "[3] 中心線の点が入っている",
          payload.model.segmentPointCounts,
        );
        check(
          payload.model.diameterCalibrated,
          "[3] 径が mm で入っている（FFR の入力になる）",
          { diameterMethod: payload.model.diameterMethod },
        );
      }
      check(
        payload.put?.ok === true,
        "[3] ★★解析結果を書き戻せた（H12 の本番経路）",
        payload.put,
      );
      check(
        (payload.perPointCount ?? 0) > 10,
        "[3] 点ごとの値を渡している",
        { perPointCount: payload.perPointCount },
      );
    }

    // ── 4. 本体が受け取っているか（プラグインの自己申告と突き合わせる）──
    const stored = (await viewer.evaluate(`(() => {
      const g = window.__graphyDebug;
      const m = g && g.getVesselModels ? g.getVesselModels() : [];
      if (!m || !m.length) return null;
      const s = g.getVesselModel ? g.getVesselModel(m[0].runId) : null;
      return JSON.stringify({ runId: m[0].runId, hasModel: !!s });
    })()`)) as string | null;
    check(!!stored, "[4] 本体側にもモデルが残っている", stored);

    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer.png") }).catch(() => {});
  } finally {
    await driver.stop().catch(() => {});
  }

  console.log(`\n===== FFR 骨組みプラグイン（A7 第 1 段）実機検証 =====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

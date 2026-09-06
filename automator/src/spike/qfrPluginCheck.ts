/*
 * QFR プラグインの実機検証 — `graphy-next-plugin-angio-quant` の段 1〜4。
 *
 * 実行:  cd automator && npx tsx src/spike/qfrPluginCheck.ts
 *
 * <h3>なぜ要るのか</h3>
 * プラグイン側の純ロジックは vitest 354 件が守っているが、**継ぎ目は 1 度も通っていない**。
 * ユニットテストでは原理的に届かないものが 4 つある:
 *
 * 1. `getPixelData(tileId, { sliceIndex: f })` が **XA マルチフレームでフレーム添字として効くか**
 *    （本体 §5.7 は「データは nZ に載せ `stackAxis="t"`」としており `XaFrameExpander` の
 *     展開に依存する。効かなければ時間輝度曲線は**全フレーム同じ値**になり、
 *     「造影が到達しない」という分かりにくい形で落ちる）
 * 2. **H40 `getXaCine` が DSA 表示中も返るか**（合成 imageId は元 URL を持たないので
 *    `dsaNativeImageId()` の委譲が要る。造影のフレームカウントは背景の消えた差分のほうが素直）
 * 3. **H12 で実際に色が乗るか** — 🚨 本体 §11.4 で「色が一度も乗っていなかった」事故がある
 *    （`vtkTubeFilter` が色をアクティブなスカラーにしない）。**目視では同じ事故を再現する**ので
 *    画素統計で見る
 * 4. 全フレーム走査の所要時間が実用範囲か
 *
 * <h3>🔴 これは QFR の精度の検証ではない</h3>
 * 確かめるのは**経路**（モデルが渡り、値が出て、色が乗り、レポートに載るか）と、
 * **出さないことの検査**（Pa 未入力・向き未確認では計算しない）だけ。
 * QFR が実測 FFR と一致するかは対照データでしか分からず、それは手元に無い。
 *
 * 🚨 走らせる前に `.results/qfr-plugin` を消す（失敗した実行が前回の成果物を持ち帰る）。
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
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "qfr-plugin");
const HOST = "viewer2d-canvas-host";
const PROBE_ID = "qfr-probe";
const QUANT_ID = "angio-quant";
const QUANT_REPO = path.resolve(REPO_ROOT, "..", "graphy-next-plugin-angio-quant");
/**
 * 解析する区間。
 *
 * 🚨 **`ffrPluginCheck` の 10〜46 を流用してはいけない**（2026-09-06 に踏んだ）。
 * あちらは「モデルが渡り値が戻る」経路だけを見るので窓は何でもよいが、こちらは**値**を見る。
 * 10〜46 で再構成すると **MLD 2.20mm / RVD 2.26mm ＝ %DS 2.7%** ——
 * 真値の 50% 狭窄を含まない窓なので、QFR は 0.996 と「正しく 1 に近い」値になり、
 * **色マップも一様（青一色）になって勾配の検査ができない**。
 * `xa3dQcaCheck` が %DS を真値と比べるのに使っている **34〜51（狭窄 t=0.66 を挟む）** を使う。
 */
const SEG_FROM = 34;
const SEG_TO = 51;

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
  qca: { file: string; studyInstanceUid: string; seriesInstanceUid: string };
  dsa: { file: string; studyInstanceUid: string; seriesInstanceUid: string; contrastArrivalFrame: number };
  recon3d: {
    views: {
      exact: { file: string; studyInstanceUid: string; seriesInstanceUid: string };
      branchesPx: { id: string; pointsPx: [number, number][] }[];
    }[];
  };
}

/** プローブが書く「host API の事実」。 */
interface Probe {
  hostKeys: string[];
  hasGetXaCine: boolean;
  hasGetXaState: boolean;
  target: { modality: string | null; sliceCount: number; seriesLabel: string | null } | null;
  xaState: { isSubtracted: boolean; frameIndex: number; frameCount: number } | null;
  cine: {
    numberOfFrames: number;
    frameTimeMs: number | null;
    cineRate: number | null;
    fps: number;
    fpsSource: string;
    uniform: boolean;
    startTimesLength: number | null;
    firstTimes: number[] | null;
    lastTime: number | null;
  } | null;
  scan: {
    frames: number;
    elapsedMs: number;
    msPerFrame: number | null;
    meanSpread: number | null;
    indexMatches: boolean;
    reportedIndices: (number | null)[];
  } | null;
  error: string | null;
}

interface Geo3dStats {
  total: number;
  nonBackground: number;
  fraction: number;
  warm: number;
  cool: number;
  neutral: number;
}

/** 検証用プラグインを backend の plugins フォルダへ置く（第三者の手置きと同じ形）。 */
function installProbe(): void {
  const src = path.join(AUTOMATOR_ROOT, "plugins", PROBE_ID);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PROBE_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) fs.copyFileSync(path.join(src, name), path.join(dst, name));
  console.log(`プローブを配置: ${dst}`);
}

/** 本番のプラグイン（ビルド済み `ui.js`）を置く。 */
function installAngioQuant(): void {
  const ui = path.join(QUANT_REPO, "ui.js");
  if (!fs.existsSync(ui)) {
    throw new Error(`ui.js がありません。先に \`cd ${QUANT_REPO} && npm run build\` を実行してください`);
  }
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", QUANT_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const name of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(QUANT_REPO, name), path.join(dst, name));
  const version = JSON.parse(fs.readFileSync(path.join(QUANT_REPO, "plugin.json"), "utf8")).version as string;
  console.log(`angio-quant を配置: ${dst}（版 ${version}・ui.js ${(fs.statSync(ui).size / 1024).toFixed(1)} KB）`);
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

async function openViewerForSeries(driver: DesktopDriver, mainPage: Page, seriesUid: string): Promise<Page> {
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
  return viewer;
}

/** プラグインメニューから 1 件起動する。 */
async function runPlugin(viewer: Page, id: string): Promise<boolean> {
  const menu = viewer.getByTestId("viewer2d-menu-plugins");
  if (!(await menu.isVisible().catch(() => false))) return false;
  await menu.click();
  await viewer.waitForTimeout(300);
  const item = viewer.getByTestId(`plugin-item-${id}`);
  if (!(await item.isVisible().catch(() => false))) {
    await viewer.keyboard.press("Escape").catch(() => undefined);
    return false;
  }
  await item.click();
  await viewer.waitForTimeout(1_200);
  return true;
}

async function readProbe(viewer: Page): Promise<Probe | null> {
  return (await viewer.evaluate(
    () => (window as unknown as { __qfrProbe?: Probe }).__qfrProbe ?? null,
  )) as Probe | null;
}

async function geo3dStats(page: Page): Promise<Geo3dStats | null> {
  const raw = (await page.evaluate(`(() => {
    const g = window.__graphyDebug;
    const s = g && g.getGeometry3dStats ? g.getGeometry3dStats() : null;
    return s ? JSON.stringify(s) : null;
  })()`)) as string | null;
  return raw ? (JSON.parse(raw) as Geo3dStats) : null;
}

async function selectLengthTool(viewer: Page): Promise<void> {
  await viewer.keyboard.press("Escape").catch(() => undefined);
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

/** 1 方向ぶんの 2D QCA を走らせ、3D の材料にする。 */
async function runQcaForView(
  driver: DesktopDriver,
  mainPage: Page,
  seriesUid: string,
  ends: [[number, number], [number, number]],
): Promise<Page> {
  const viewer = await openViewerForSeries(driver, mainPage, seriesUid);
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
  const truth = JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8")) as Truth;
  const v1 = truth.recon3d.views[0];
  const v2 = truth.recon3d.views[1];
  const ends = (v: typeof v1): [[number, number], [number, number]] => {
    const pts = v.branchesPx.find((b) => b.id === "main")!.pointsPx;
    return [pts[SEG_FROM], pts[SEG_TO]];
  };

  installProbe();
  installAngioQuant();

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [
      path.join(PHANTOM_DIR, truth.qca.file),
      path.join(PHANTOM_DIR, truth.dsa.file),
      path.join(PHANTOM_DIR, v1.exact.file),
      path.join(PHANTOM_DIR, v2.exact.file),
    ]);
    check(imp.imported === 4, "[準備] ファントムを 4 本取り込めた", imp);
    await waitForMainScreenReady(mainPage, 60_000);

    /* ══════════════════════════════════════════════════════════
     * 1. 非 DSA のマルチフレームで host API の事実を測る（① ③）
     * ══════════════════════════════════════════════════════════ */
    console.log("\n── 1. マルチフレーム XA（11 フレーム・FrameTime 33ms）──");
    await openStudy(mainPage, truth.qca.studyInstanceUid);
    let viewer = await openViewerForSeries(driver, mainPage, truth.qca.seriesInstanceUid);
    check(await runPlugin(viewer, PROBE_ID), "[1] プローブを起動できる");
    await viewer.waitForTimeout(2_000);
    const p1 = await readProbe(viewer);
    fs.writeFileSync(path.join(OUT_DIR, "probe-xa1.json"), JSON.stringify(p1, null, 2));
    check(!!p1 && p1.error == null, "[1] プローブがエラー無く走り切った", { error: p1?.error });

    if (p1) {
      // ── H40 が生えているか（契約の写し間違いはここに出る）
      check(p1.hasGetXaCine, "[1] ★host に getXaCine が生えている（H40）", { hostKeys: p1.hostKeys.length });
      check(!!p1.cine, "[1] ★getXaCine が値を返す", p1.cine);
      if (p1.cine) {
        check(p1.cine.numberOfFrames === 11, "[1] フレーム数が DICOM どおり（11）", p1.cine.numberOfFrames);
        check(p1.cine.frameTimeMs === 33, "[1] FrameTime (0018,1063) を読めている（33ms）", p1.cine.frameTimeMs);
        // 🔴 ここが cQFR の生死を分ける。"default" なら「タグから決まらなかった」＝換算しない。
        check(
          p1.cine.fpsSource === "frameTime",
          "[1] ★★fps の出自が frameTime（既定値に落ちていない＝cQFR を出せる）",
          p1.cine.fpsSource,
        );
        check(Math.abs(p1.cine.fps - 1000 / 33) < 0.01, "[1] fps が 1000/33 = 30.303", p1.cine.fps);
        check(p1.cine.uniform === true, "[1] 一様レートと判定される", p1.cine.uniform);
        check(p1.cine.startTimesLength === 11, "[1] 各フレームの開始時刻が全部ある", p1.cine.startTimesLength);
        check(
          p1.cine.lastTime != null && Math.abs(p1.cine.lastTime - 10 * 33) < 0.01,
          "[1] 最終フレームの時刻が 10 × 33 = 330ms",
          p1.cine.lastTime,
        );
      }

      // ── ① sliceIndex がフレーム添字として効くか
      check(!!p1.scan, "[1] 全フレームを走査できた", { frames: p1.scan?.frames });
      if (p1.scan) {
        check(
          p1.scan.indexMatches,
          "[1] ★host が「要求どおりのスライスを読んだ」と申告する",
          p1.scan.reportedIndices.slice(0, 5),
        );
        // 🚨 **これが決め手。** sliceIndex がフレーム添字として効いていなければ、
        //    全フレームで同じ画素が返り、平均のばらつきが 0 になる。
        //    そのとき時間輝度曲線は平坦になり、「造影が到達しない」という
        //    分かりにくい形でだけ壊れる（例外も警告も出ない）。
        check(
          (p1.scan.meanSpread ?? 0) > 1e-6,
          "[1] ★★sliceIndex がフレーム添字として効いている（フレームごとに画素が変わる）",
          { meanSpread: p1.scan.meanSpread },
        );
        // ── ③ 所要時間
        console.log(
          `  [計測] 11 フレーム走査: ${p1.scan.elapsedMs}ms（${(p1.scan.msPerFrame ?? 0).toFixed(1)} ms/フレーム）`,
        );
        check(
          (p1.scan.msPerFrame ?? 1e9) < 500,
          "[1] 1 フレームあたり 500ms 未満（96 フレームでも 1 分未満）",
          { msPerFrame: p1.scan.msPerFrame },
        );
      }
    }
    await viewer.close();
    await mainPage.waitForTimeout(600);

    /* ══════════════════════════════════════════════════════════
     * 2. DSA 表示中に H40 が返るか（②）
     * ══════════════════════════════════════════════════════════ */
    console.log("\n── 2. DSA 表示中（25 フレーム・FrameTime 66ms）──");
    await openStudy(mainPage, truth.dsa.studyInstanceUid);
    viewer = await openViewerForSeries(driver, mainPage, truth.dsa.seriesInstanceUid);
    await viewer.getByTestId("dsa-check").click();
    await viewer.getByTestId("dsa-mask").waitFor({ state: "visible", timeout: 120_000 });
    await viewer.waitForTimeout(1_500);
    await viewer.evaluate(() => {
      delete (window as unknown as { __qfrProbe?: unknown }).__qfrProbe;
    });
    check(await runPlugin(viewer, PROBE_ID), "[2] DSA 表示中にプローブを起動できる");
    await viewer.waitForTimeout(3_000);
    const p2 = await readProbe(viewer);
    fs.writeFileSync(path.join(OUT_DIR, "probe-dsa.json"), JSON.stringify(p2, null, 2));
    if (p2) {
      check(p2.xaState?.isSubtracted === true, "[2] 本体が「差分表示中」と申告している", p2.xaState);
      // 🚨 **今回の実装の肝。** 合成 imageId（`graphy-dsa:`）は元の URL を持たないので、
      //    `dsaNativeImageId()` でネイティブフレームへ委譲しないとタグが 1 つも読めない。
      //    ここが null だと「差分表示にした瞬間に cQFR だけ静かに落ちる」。
      check(!!p2.cine, "[2] ★★DSA 表示中でも getXaCine が返る（ネイティブへの委譲が効いている）", p2.cine);
      if (p2.cine) {
        check(p2.cine.numberOfFrames === 25, "[2] フレーム数が DICOM どおり（25）", p2.cine.numberOfFrames);
        check(p2.cine.frameTimeMs === 66, "[2] FrameTime を読めている（66ms）", p2.cine.frameTimeMs);
        check(p2.cine.fpsSource === "frameTime", "[2] fps の出自が frameTime", p2.cine.fpsSource);
      }
      check(
        (p2.scan?.meanSpread ?? 0) > 1e-6,
        "[2] ★差分画像でもフレームごとに画素が変わる（造影の立ち上がりが見える）",
        { meanSpread: p2.scan?.meanSpread },
      );
    }
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-dsa.png") }).catch(() => {});
    await viewer.close();
    await mainPage.waitForTimeout(600);

    /* ══════════════════════════════════════════════════════════
     * 3. QFR の本番経路（3D ファントム）
     * ══════════════════════════════════════════════════════════ */
    console.log("\n── 3. QFR の本番経路 ──");
    await openStudy(mainPage, v1.exact.studyInstanceUid);
    viewer = await runQcaForView(driver, mainPage, v1.exact.seriesInstanceUid, ends(v1));
    await viewer.close();
    await mainPage.waitForTimeout(600);
    viewer = await runQcaForView(driver, mainPage, v2.exact.seriesInstanceUid, ends(v2));

    await viewer.getByTestId("xa3d-open").click();
    await viewer.getByTestId("xa3d-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await viewer.waitForTimeout(500);
    const opts = (await viewer.evaluate(`(() => {
      const a = document.querySelector('[data-testid="xa3d-view-a"]');
      return a ? JSON.stringify(Array.from(a.options).map((o) => o.value)) : null;
    })()`)) as string | null;
    const values = opts ? (JSON.parse(opts) as string[]).filter(Boolean) : [];
    check(values.length >= 2, "[3] 2D QCA が 2 本そろっている", { n: values.length });
    if (values.length >= 2) {
      await viewer.selectOption('[data-testid="xa3d-view-a"]', values[0]);
      await viewer.selectOption('[data-testid="xa3d-view-b"]', values[1]);
      await viewer.waitForTimeout(300);
      await viewer.getByTestId("xa3d-run").click();
      await viewer.waitForTimeout(4_000);
    }

    // 🔑 **3D ウィンドウを先に開く。** ダイアログはモーダルなので、閉じてしまうと
    //    ここからは開けない。色は `putVesselAnalysis` で乗るので、開いたまま待たせる。
    const geo = await driver.waitForNewPage(
      () => viewer.getByTestId("xa3d-open-3d").click(),
      (url) => url.includes("geometry3d"),
    );
    await geo.getByTestId("geometry3d-root").waitFor({ state: "visible", timeout: 30_000 });
    await geo.waitForTimeout(2_500);
    const before = await geo3dStats(geo);
    // 🚨 「色が付いていない」を「彩度が無い」で測らない。既定の中心線は単色シアン＝
    //    乗せる前から全部「寒色」に数えられる。見るべきは**赤が無いこと**。
    check(!!before && before.warm === 0, "[3] 値を乗せる前は単色（赤寄りの画素が 1 つも無い）", before);

    await viewer.getByTestId("xa3d-close").click();
    await viewer.waitForTimeout(600);
    if (await viewer.getByTestId("xa3d-dialog").isVisible().catch(() => false)) {
      await viewer.mouse.click(5, 5);
      await viewer.waitForTimeout(600);
    }
    check(
      !(await viewer.getByTestId("xa3d-dialog").isVisible().catch(() => false)),
      "[3] 3D QCA のダイアログを閉じられた（次の操作を塞がない）",
    );

    // ── angio-quant を開く ────────────────────────────────────
    check(await runPlugin(viewer, QUANT_ID), "[3] ★angio-quant が一覧に出て起動できる");
    await viewer.getByTestId("angio-quant-panel").waitFor({ state: "visible", timeout: 20_000 });
    const qfrBtn = viewer.getByTestId("angio-quant-qfr");
    check(await qfrBtn.isVisible().catch(() => false), "[3] QFR の導線が出る");
    check(!(await qfrBtn.isDisabled()), "[3] ★3D モデルがあるので QFR を開ける（H11 が見えている）");
    await qfrBtn.click();
    await viewer.getByTestId("qfr-panel").waitFor({ state: "visible", timeout: 20_000 });
    check(true, "[3] ★QFR パネルが開く");

    const panelText0 = (await viewer.getByTestId("qfr-panel").textContent()) ?? "";
    check(
      !panelText0.includes("3D 血管モデルの口（H11）がありません"),
      "[3] H11 が無いという表示が出ていない",
    );
    check(
      panelText0.includes("この実装のものではありません"),
      "[3] ★文献の精度ではない旨が最初から出ている（§19）",
    );

    // ── 🚨 単一フレームのランで cQFR を選ばせない ────────────
    //    3D 再構成に使う静止画は `NumberOfFrames = 1` なのに `FrameTime` / `CineRate` を
    //    持っているので、`getXaCine()` は**もっともらしい値を返す**（fps 25・出自 frameTime）。
    //    フレーム数を見ずに「H40 があるから cQFR が使える」と判断すると、
    //    フレームカウントの窓が開いて**そこで止まる**（実機で踏んだ・2026-09-06）。
    const velOptions = (await viewer.evaluate(`(() => {
      const sel = document.querySelector('[data-testid="qfr-velocity"]');
      if (!sel) return null;
      return JSON.stringify(Array.from(sel.options).map((o) => ({ v: o.value, disabled: o.disabled })));
    })()`)) as string | null;
    const vel = velOptions ? (JSON.parse(velOptions) as { v: string; disabled: boolean }[]) : [];
    check(vel.length === 3, "[3] 流速モデルが 3 つ出る（fQFR / cQFR / aQFR）", vel);
    check(
      vel.find((o) => o.v === "contrast")?.disabled === true,
      "[3] ★★単一フレームのランでは cQFR を選べない（フレーム数を見ている）",
      vel,
    );
    check(
      vel.find((o) => o.v === "fixed")?.disabled === false,
      "[3] fQFR は選べる（何も出せない状態にはしない）",
    );
    const velValue = (await viewer.evaluate(`(() => {
      const s = document.querySelector('[data-testid="qfr-velocity"]');
      return s ? s.value : null;
    })()`)) as string | null;
    check(velValue === "fixed", "[3] ★既定が fQFR に落ちている（選べないモデルを既定にしない）", velValue);
    check(
      panelText0.includes("フレームしかありません"),
      "[3] ★なぜ cQFR が使えないかが画面に書いてある",
    );

    // ── 🔴 出さないことの検査 ─────────────────────────────────
    const runQfr = viewer.getByTestId("qfr-run");
    check(await runQfr.isDisabled(), "[3] ★★Pa 未入力・向き未確認では計算ボタンが押せない");
    await viewer.getByTestId("qfr-pa").fill("100");
    await viewer.waitForTimeout(200);
    check(
      await runQfr.isDisabled(),
      "[3] ★Pa を入れただけでは押せない（中心線の向きの確認が要る＝G9 への当座の防御）",
    );
    await viewer.getByTestId("qfr-direction").check();
    await viewer.waitForTimeout(200);
    check(!(await runQfr.isDisabled()), "[3] 両方そろえば押せる");

    // ── 計算 ──────────────────────────────────────────────────
    // 🔴 押す前にモデルの校正を記録する。QFR は未校正・mixed 径法・窓が短すぎるときに
    //    **意図的に計算を断る**ので、断られたのか壊れたのかをここで切り分けられるようにする。
    const modelFacts = (await viewer.evaluate(`(() => {
      const g = window.__graphyDebug;
      const m = g && g.getVesselModel ? g.getVesselModel() : null;
      if (!m) return null;
      const seg = (m.segments || [])[0] || null;
      const d = seg ? seg.diameterMm : [];
      return JSON.stringify({
        runId: m.runId, kind: m.kind,
        segmentIds: (m.segments || []).map((x) => x.id),
        pointCount: seg ? seg.points.length : 0,
        diameterNulls: d.filter((v) => v == null).length,
        diameterMin: Math.min.apply(null, d.filter((v) => v != null)),
        diameterMax: Math.max.apply(null, d.filter((v) => v != null)),
        calibration: m.calibration,
        separationDeg: m.provenance ? m.provenance.separationDeg : null,
        angleCorrected: m.provenance ? m.provenance.angleCorrected : null,
        firstPoint: seg ? seg.points[0] : null,
        lastPoint: seg ? seg.points[seg.points.length - 1] : null,
      });
    })()`)) as string | null;
    fs.writeFileSync(path.join(OUT_DIR, "vessel-model.json"), modelFacts ?? "null");
    console.log(`  [情報] 血管モデル: ${modelFacts}`);

    await runQfr.click();
    await viewer.waitForTimeout(5_000);
    // 🚨 **押した直後の画面をそのまま残す。** 値が出ないときに「何が書いてあったか」が
    //    分からないと、断られたのか壊れたのかを切り分けられない。
    const afterRun = (await viewer.getByTestId("qfr-panel").textContent()) ?? "";
    fs.writeFileSync(path.join(OUT_DIR, "after-run.txt"), afterRun);
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-after-run.png") }).catch(() => {});
    const hasValue = (await viewer.getByTestId("qfr-value").count()) > 0;
    check(hasValue, "[3] ★★計算が結果を出した（断られていない）", {
      tail: afterRun.slice(-260).replace(/\s+/g, " ").trim(),
    });
    if (!hasValue) {
      console.log("\n  [情報] 画面の文言:\n" + afterRun.slice(-600));
      throw new Error("QFR の値が出なかった（above の文言を見ること）");
    }
    // 🚨 **大きく出ている値は `toFixed(2)` の丸め**なので、範囲の検査には使わない
    //    （0.996 が "1.00" と出て「1 未満でない」と落ちた・2026-09-06）。3 桁の値で見る。
    const primary = Number(((await viewer.getByTestId("qfr-primary").textContent()) ?? "").replace(/[^0-9.]/g, ""));
    check(Number.isFinite(primary) && primary > 0 && primary < 1, "[3] ★★QFR が出る（0 < q < 1）", {
      primary,
      displayed: ((await viewer.getByTestId("qfr-value").textContent()) ?? "").trim(),
    });
    // 🔑 **物理が幾何に反応していることを見る。** 真値 50% 狭窄を含む窓なので、
    //    QFR が 1 に張り付いていたら「狭窄を見ていない」ということ。
    check(primary < 0.95, "[3] ★★QFR が狭窄に反応している（真値 %DS 50 の区間）", { primary });
    const cross = Number(((await viewer.getByTestId("qfr-cross").textContent()) ?? "").replace(/[^0-9.]/g, ""));
    const diff = Number(((await viewer.getByTestId("qfr-diff").textContent()) ?? "").replace(/[^0-9.]/g, ""));
    check(
      Number.isFinite(primary) && Number.isFinite(cross),
      "[3] ★1D 積分と Kirkeeide 集約の**両方**が出る（片方だけ保存しない）",
      { primary, cross, diff },
    );
    check(
      Number.isFinite(diff) && Math.abs(diff - Math.abs(primary - cross)) < 0.002,
      "[3] 2 モデルの差が表示と一致する",
      { diff, computed: Math.abs(primary - cross) },
    );

    const caveats = await viewer.getByTestId("qfr-caveats").locator("li").allTextContents();
    fs.writeFileSync(path.join(OUT_DIR, "caveats.txt"), caveats.join("\n"));
    check(caveats.length >= 4, "[3] ★注記が 4 本以上出る", { n: caveats.length });
    for (const [needle, label] of [
      ["独自の再実装", "独自の再実装である旨"],
      ["CFD）は行っていません", "3D CFD をしていない旨"],
      ["側枝は再構成していません", "側枝を再構成していない旨"],
      ["正常/異常の判定を行いません", "判定しない旨"],
    ] as const) {
      check(caveats.some((c) => c.includes(needle)), `[3] 注記に「${label}」が入る`);
    }

    await viewer.screenshot({ path: path.join(OUT_DIR, "3-qfr-panel.png") }).catch(() => {});

    // ── 🚨 H12: 実際に色が乗るか（画素で見る）──────────────────
    await viewer.getByTestId("qfr-put").click();
    await viewer.waitForTimeout(3_000);
    const after = await geo3dStats(geo);
    // 🚨 **「赤が出ること」を条件にしてはいけない。** 画素の分類は
    //    `warm: r−b>30` / `cool: b−r>30` / それ以外 `neutral` で、色ランプ 赤→橙→黄→緑→青 の
    //    **緑〜黄は neutral に落ちる**。範囲 [0.60,1.00] に対し QFR 0.85 は t=0.625 ＝ 緑寄りなので、
    //    中等度の狭窄では赤は出ない（**それが正しい描画**）。
    //    乗せる前が「cool だけ・neutral 0」の単色シアンなので、
    //    **neutral か warm が立つこと**が「勾配が乗った」の判定になる。
    const gradient = after ? after.warm + after.neutral : 0;
    check(
      !!after && gradient > 0 && after.cool > 0,
      "[3] ★★★H12 で 3D 血管に勾配が乗る（単色シアンから変わった。画素で確認）",
      { before, after, gradient },
    );
    const legend = geo.getByTestId("vessel-legend");
    check((await legend.count()) === 1, "[3] 凡例が出る");
    const label = await legend.getAttribute("data-label").catch(() => null);
    check((label ?? "").includes("QFR"), "[3] 凡例に量の名前が出る（本体は名前を決めない）", label);
    const disc = (await geo.getByTestId("vessel-legend-disclaimer").textContent().catch(() => "")) ?? "";
    check(disc.includes("研究用"), "[3] ★モジュールの免責文がそのまま出る", disc.trim().slice(0, 50));
    check(
      disc.includes("本体は閾値を持ちません"),
      "[3] ★本体が閾値を持たない旨が画面に出る（0.80 は色で示すだけ）",
    );
    await geo.screenshot({ path: path.join(OUT_DIR, "3-geometry3d.png") }).catch(() => {});

    // ── H39: レポートへ差し込む ───────────────────────────────
    await viewer.getByTestId("qfr-publish").click();
    await viewer.waitForTimeout(1_500);
    const panelText = (await viewer.getByTestId("qfr-panel").textContent()) ?? "";
    check(
      panelText.includes("レポートへ差し込めるようになりました"),
      "[3] ★H39 でレポートへ差し込める",
      panelText.slice(-120).trim(),
    );

    fs.writeFileSync(
      path.join(OUT_DIR, "qfr-panel.txt"),
      (await viewer.getByTestId("qfr-panel").textContent()) ?? "",
    );
  } finally {
    await driver.stop().catch(() => {});
  }

  console.log(`\n===== QFR プラグイン 実機検証 =====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log(`成果物: ${OUT_DIR}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

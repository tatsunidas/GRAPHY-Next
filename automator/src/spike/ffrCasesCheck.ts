/*
 * FFR 2 症例での QFR 動作確認 — `graphy-next-plugin-angio-quant` の docs/ffr-cases-protocol.md を実行する。
 *
 * 実行:  cd automator && npx tsx src/spike/ffrCasesCheck.ts
 * 環境:  FFR_CASES_DIR（既定 ~/graphy_sample_images/ffr-cases）に
 *        FFR/（DICOM）・ffr-cases-segments.json・ffr-cases-uids.json があること。
 *        GRAPHY_AUTOMATOR_HTTP_PORT / _SCP_PORT / _VITE_PORT で専用ポートを指定する。
 *
 * 🔴 **これは QFR の精度の検証ではない。** n=2 の動作確認で、合否は事前登録の基準（QFR(Case1) < 0.80 かつ
 *    QFR(Case2) > 0.80）だけで決める。区間と Pa は事前登録のとおり固定で、結果を見て動かさない。
 * 🚨 走らせる前に `.results/ffr-cases` を消す（失敗した実行が前回の成果物を持ち帰る）。
 * 🚨 患者識別子は出力しない（読むのは UID だけ）。静止画（実データ）はリポジトリに入れない。
 *
 * 結果は 合格 / 失敗 / 未達 に分けて数える。区間ごとの実行がエラーで止まったら「未達」で、合格にしない。
 */
import fs from "node:fs";
import os from "node:os";
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
const CASES_DIR = process.env.FFR_CASES_DIR ?? path.join(os.homedir(), "graphy_sample_images", "ffr-cases");
// 試行 B（アンカー 3 点以上・端点選び直し）は FFR_TRIAL=B。区間は ffr-cases-segments-B.json、出力は別ディレクトリ。
const TRIAL = process.env.FFR_TRIAL === "B" ? "B" : "A";
// 実行ごとに別プロセスで走らせる（FFR_ONLY）ので、main() 冒頭の削除が他の実行の結果を消さないよう出力先を分ける。
const OUT_DIR = path.join(
  AUTOMATOR_ROOT,
  ".results",
  `${TRIAL === "B" ? "ffr-cases-B" : "ffr-cases"}${process.env.FFR_ONLY ? `-${process.env.FFR_ONLY}` : ""}`,
);
const HOST = "viewer2d-canvas-host";
const QUANT_ID = "angio-quant";
const QUANT_REPO = path.resolve(REPO_ROOT, "..", "graphy-next-plugin-angio-quant");

/** 事前登録の値（docs/ffr-cases-protocol.md）。結果を見て動かさない。 */
const CASES = {
  Case1: { dir: "Case1 FFR 0.69", ffr: 0.69, paMmHg: 68, statics: ["00000003", "00000004"], viewKeys: ["Case1_A", "Case1_B"] },
  Case2: { dir: "Case2 FFR0.90", ffr: 0.9, paMmHg: 94, statics: ["00000003", "00000004"], viewKeys: ["Case2_A", "Case2_B"] },
} as const;
type CaseId = keyof typeof CASES;
const CUTOFF = 0.8;

interface ViewSeg {
  file: string;
  /** 0 始まり。ビューアの表示は 1 始まり（N/総数）。 */
  frame: number;
  ostium: [number, number];
  lad_origin: [number, number];
  distal: [number, number];
}
interface AnchorSpec {
  name: string;
  /** 方向 A・B それぞれの画像画素（512px・x,y）。両方向で同じ解剖点を指す。 */
  A: [number, number];
  B: [number, number];
}
interface Segments {
  revision: number;
  views: Record<string, ViewSeg>;
  /** 試行 B のみ。端点以外のアンカー（症例 → 解析種別 → 点）。 */
  anchors?: Record<string, Partial<Record<"primary" | "secondary", AnchorSpec[]>>>;
}
interface UidEntry {
  studyUid: string;
  seriesUid: string;
}

type RunKind = "primary" | "secondary";
interface RunResult {
  caseId: CaseId;
  kind: RunKind;
  status: "ok" | "unreached";
  reason?: string;
  qfr1d?: number;
  qfrKirkeeide?: number;
  diff?: number;
  displayed?: string;
  caveats?: string[];
  modelFacts?: unknown;
}

let passed = 0;
const failures: string[] = [];
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

function installAngioQuant(): void {
  const ui = path.join(QUANT_REPO, "ui.js");
  if (!fs.existsSync(ui)) {
    throw new Error(`ui.js がありません。先に \`cd ${QUANT_REPO} && npm run build\` を実行してください`);
  }
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", QUANT_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const name of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(QUANT_REPO, name), path.join(dst, name));
  const version = JSON.parse(fs.readFileSync(path.join(QUANT_REPO, "plugin.json"), "utf8")).version as string;
  console.log(`angio-quant を配置: ${dst}（版 ${version}・ui.js ${(fs.statSync(ui).size / 1024).toFixed(1)} KB・更新 ${fs.statSync(ui).mtime.toISOString()}）`);
}

async function openStudy(page: Page, studyUid: string): Promise<void> {
  await dismissStartupDialogs(page);
  // 日付欄を空にするだけでは一覧が空のままになる（シネで確認）。「All」で全期間にする。
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByTestId("search-submit-button").click();
  const row = page.locator(`[data-testid="study-row-${studyUid}"]`);
  await row.waitFor({ state: "visible", timeout: 20_000 });
  await row.click();
  await page.waitForTimeout(600);
}

async function openViewerForSeries(driver: DesktopDriver, mainPage: Page, seriesUid: string): Promise<Page> {
  const row = mainPage.locator(`[data-testid="series-row-${seriesUid}"]`);
  await row.waitFor({ state: "visible", timeout: 30_000 }).catch(async (e) => {
    await mainPage.screenshot({ path: path.join(OUT_DIR, "series-row-missing.png") }).catch(() => {});
    throw e;
  });
  await row.click();
  await mainPage.waitForTimeout(400);
  const viewer = await driver.waitForNewPage(
    () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 }).catch(async (e) => {
    await viewer.screenshot({ path: path.join(OUT_DIR, `viewer-not-ready-${seriesUid.slice(-6)}.png`) }).catch(() => {});
    throw e;
  });
  await viewer.waitForTimeout(3_000);
  return viewer;
}

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

async function selectLengthTool(viewer: Page): Promise<void> {
  await viewer.keyboard.press("Escape").catch(() => undefined);
  await viewer.getByTestId("viewer2d-menu-measure").click();
  await viewer.waitForTimeout(250);
  // 言語は OS のロケールで決まる（en: "Length" / ja: "長さ"）。
  const lenItem = viewer.getByText(/^(✓ )?(長さ|Length)$/).first();
  await lenItem.waitFor({ state: "visible", timeout: 5_000 }).catch(async () => {
    await viewer.screenshot({ path: path.join(OUT_DIR, "length-menu-missing.png") }).catch(() => {});
  });
  await lenItem.click();
  await viewer.waitForTimeout(300);
}

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
  await dragOnCanvasHost(viewer, HOST, dx, dy, 0, 14, { fracX: f[0].fx, fracY: f[0].fy });
  await viewer.waitForTimeout(800);
}

/** 表示フレーム（1 始まり）を読む。 */
async function shownFrame(viewer: Page): Promise<number> {
  const t = (await viewer.getByTestId("series-viewer-root").first().innerText()).replace(/\s+/g, " ");
  const m = t.match(/(\d+)\/(\d+) ◀\|/);
  if (!m) throw new Error("フレーム表示（N/総数）を読めない");
  return Number(m[1]);
}

/** ホイール 1 目盛り = 1 フレーム。目的（0 始まり）になるまで送り、表示で確かめる。 */
async function setFrame(viewer: Page, frame0: number): Promise<void> {
  const host = await viewer.getByTestId(HOST).first().boundingBox();
  if (!host) throw new Error("キャンバスが見つかりません");
  await viewer.mouse.move(host.x + host.width / 2, host.y + host.height / 2);
  for (let i = 0; i < 40; i++) {
    const diff = frame0 + 1 - (await shownFrame(viewer));
    if (diff === 0) return;
    for (let k = 0; k < Math.min(Math.abs(diff), 10); k++) {
      await viewer.mouse.wheel(0, diff > 0 ? 120 : -120);
      await viewer.waitForTimeout(60);
    }
    await viewer.waitForTimeout(250);
  }
  throw new Error(`フレーム ${frame0} に合わせられない（表示 ${await shownFrame(viewer)}）`);
}

/** 1 方向ぶんの 2D QCA。ボタンが無い・結果が出ないときは理由つきで投げる（＝未達）。 */
async function runQcaForView(
  driver: DesktopDriver,
  mainPage: Page,
  seriesUid: string,
  ends: [[number, number], [number, number]],
  frame0: number,
  tag: string,
  reuse?: { viewer: Page; run: number },
): Promise<Page> {
  const viewer = reuse?.viewer ?? (await openViewerForSeries(driver, mainPage, seriesUid));
  // 同じシリーズに 2 本のシネが入っているとき（Case2）は「Run n/2」で切り替える。
  if (reuse) {
    await viewer.locator('input[type="range"]').nth(1).fill(String(reuse.run));
    await viewer.waitForTimeout(1_500);
  }
  await setFrame(viewer, frame0);
  check((await shownFrame(viewer)) === frame0 + 1, `[${tag}] 指定フレーム（0 始まり ${frame0}）を表示している`);
  await viewer.screenshot({ path: path.join(OUT_DIR, `${tag}-opened.png`) }).catch(() => {});
  await selectLengthTool(viewer);
  await drawBetweenImagePixels(viewer, ends[0], ends[1]);
  await viewer.screenshot({ path: path.join(OUT_DIR, `${tag}-line.png`) }).catch(() => {});
  const open = viewer.getByTestId("xa-analysis-open");
  if (!(await open.isVisible().catch(() => false))) {
    throw new Error(`${tag}: xa-analysis-open が出ない（この画像は XA 解析の対象として扱われていない）`);
  }
  await open.click();
  await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await viewer.getByTestId("xa-qca-run").click();
  await viewer.waitForTimeout(3_500);
  await viewer.screenshot({ path: path.join(OUT_DIR, `${tag}-qca.png`) }).catch(() => {});
  fs.writeFileSync(
    path.join(OUT_DIR, `${tag}-qca.txt`),
    (await viewer.getByTestId("xa-analysis-dialog").textContent().catch(() => "")) ?? "",
  );
  await viewer.getByTestId("xa-dialog-close").click();
  await viewer.waitForTimeout(400);
  return viewer;
}

interface Xa3dSnap {
  anchorCount: number;
  steps: unknown;
  refinement: unknown;
  result: { acceptable: boolean; lengthMm: number; anchorReprojectionPx: number; separationDeg: number; warnings: unknown[] } | null;
}
async function xa3dSnap(viewer: Page): Promise<Xa3dSnap | null> {
  const raw = (await viewer.evaluate(`(() => {
    const g = window.__graphyDebug;
    const s = g && g.getXa3dState ? g.getXa3dState() : null;
    return s ? JSON.stringify(s) : null;
  })()`)) as string | null;
  return raw ? (JSON.parse(raw) as Xa3dSnap) : null;
}

/**
 * 中心線プレビュー（SVG）の上で、画像画素 target に最も近い場所をクリックしてアンカーの片側を指す。
 * 中心線の画素座標は公開されていないので、始点 S・終点 E（＝線を引いた端点）の画面位置から
 * 画素→画面の等方変換を推定する。端点が中心線に吸着されていれば推定は近似になる（誤差を返す）。
 */
async function clickCurveAtPixel(
  viewer: Page,
  testId: string,
  ends: [[number, number], [number, number]],
  target: [number, number],
): Promise<{ nearestImgPx: number }> {
  const raw = (await viewer.evaluate(`(() => {
    const svg = document.querySelector('[data-testid="${testId}"]');
    const pl = svg && svg.querySelector("polyline");
    return pl ? pl.getAttribute("points") : null;
  })()`)) as string | null;
  if (!raw) throw new Error(`${testId} の中心線を読めない`);
  const pts = raw.trim().split(/\s+/).map((q) => q.split(",").map(Number) as [number, number]);
  const S = pts[0];
  const E = pts[pts.length - 1];
  const dImg = Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]);
  const scale = Math.hypot(E[0] - S[0], E[1] - S[1]) / Math.max(1e-6, dImg);
  const sx = S[0] + (target[0] - ends[0][0]) * scale;
  const sy = S[1] + (target[1] - ends[0][1]) * scale;
  let nearest = Infinity;
  for (const q of pts) nearest = Math.min(nearest, Math.hypot(q[0] - sx, q[1] - sy));
  await viewer.getByTestId(testId).click({ position: { x: sx, y: sy } });
  await viewer.waitForTimeout(250);
  return { nearestImgPx: nearest / scale };
}

async function runOne(
  driver: DesktopDriver,
  caseId: CaseId,
  kind: RunKind,
  segs: Segments,
  uids: Record<string, UidEntry>,
): Promise<RunResult> {
  const c = CASES[caseId];
  const tag = `${caseId}-${kind}`;
  const mainPage = driver.page;
  const views = c.viewKeys.map((k) => segs.views[k]);
  const ends = (v: ViewSeg): [[number, number], [number, number]] => [
    kind === "primary" ? v.ostium : v.lad_origin,
    v.distal,
  ];
  const uidOf = (n: number) => uids[`${c.dir}/DICOM/${c.statics[n]}`];

  console.log(`\n── ${tag}（Pa ${c.paMmHg} mmHg・近位端 ${kind === "primary" ? "左主幹入口" : "LAD 起始部"}）──`);
  await resetDb(driver.ports.http);
  const imp = await importPaths(
    driver.ports.http,
    c.statics.map((s) => path.join(CASES_DIR, "FFR", c.dir, "DICOM", s)),
  );
  check(imp.imported === 2, `[${tag}] シネ 2 本を取り込めた`, imp);
  await waitForMainScreenReady(mainPage, 60_000);
  await openStudy(mainPage, uidOf(0).studyUid);

  let viewer = await runQcaForView(driver, mainPage, uidOf(0).seriesUid, ends(views[0]), views[0].frame, `${tag}-A`);
  if (uidOf(0).seriesUid === uidOf(1).seriesUid) {
    viewer = await runQcaForView(driver, mainPage, uidOf(1).seriesUid, ends(views[1]), views[1].frame, `${tag}-B`, { viewer, run: 1 });
  } else {
    await viewer.close();
    await mainPage.waitForTimeout(600);
    viewer = await runQcaForView(driver, mainPage, uidOf(1).seriesUid, ends(views[1]), views[1].frame, `${tag}-B`);
  }

  await viewer.getByTestId("xa3d-open").click();
  await viewer.getByTestId("xa3d-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await viewer.waitForTimeout(500);
  const opts = (await viewer.evaluate(`(() => {
    const a = document.querySelector('[data-testid="xa3d-view-a"]');
    return a ? JSON.stringify(Array.from(a.options).map((o) => o.value)) : null;
  })()`)) as string | null;
  const values = opts ? (JSON.parse(opts) as string[]).filter(Boolean) : [];
  if (values.length < 2) throw new Error(`${tag}: 2D QCA が 2 本そろっていない（${values.length} 本）`);
  await viewer.selectOption('[data-testid="xa3d-view-a"]', values[0]);
  await viewer.selectOption('[data-testid="xa3d-view-b"]', values[1]);
  await viewer.waitForTimeout(300);
  // 試行 B: 端点 2 点に、両方向で同定した解剖点を足す（登録済みの点を 1 回だけ。結果を見て選び直さない）。
  const extra = TRIAL === "B" ? segs.anchors?.[caseId]?.[kind] ?? [] : [];
  const anchorLog: { name: string; nearestImgPxA: number; nearestImgPxB: number }[] = [];
  for (const a of extra) {
    const ra = await clickCurveAtPixel(viewer, "xa3d-curve-a", ends(views[0]), a.A);
    const rb = await clickCurveAtPixel(viewer, "xa3d-curve-b", ends(views[1]), a.B);
    anchorLog.push({ name: a.name, nearestImgPxA: Number(ra.nearestImgPx.toFixed(1)), nearestImgPxB: Number(rb.nearestImgPx.toFixed(1)) });
  }
  if (TRIAL === "B") {
    const sn = await xa3dSnap(viewer);
    check(sn?.anchorCount === 2 + extra.length, `[${tag}] アンカー数が 端点 2 + 追加 ${extra.length}`, { anchorCount: sn?.anchorCount, anchorLog });
    fs.writeFileSync(path.join(OUT_DIR, `${tag}-anchors.json`), JSON.stringify(anchorLog, null, 1));
  }
  await viewer.getByTestId("xa3d-run").click();
  await viewer.waitForTimeout(4_000);
  fs.writeFileSync(
    path.join(OUT_DIR, `${tag}-xa3d-before-orientation.txt`),
    (await viewer.getByTestId("xa3d-dialog").textContent().catch(() => "")) ?? "",
  );
  await viewer.screenshot({ path: path.join(OUT_DIR, `${tag}-xa3d-before-orientation.png`) }).catch(() => {});
  fs.writeFileSync(path.join(OUT_DIR, `${tag}-xa3d-state.json`), JSON.stringify(await xa3dSnap(viewer), null, 1));
  // 近位端 = 線を引いた始点 S（大動脈側から遠位へ引いている）
  await viewer.getByTestId("xa3d-proximal-start").check({ timeout: 8_000 });
  await viewer.waitForTimeout(400);
  fs.writeFileSync(
    path.join(OUT_DIR, `${tag}-xa3d.txt`),
    (await viewer.getByTestId("xa3d-dialog").textContent().catch(() => "")) ?? "",
  );
  await viewer.screenshot({ path: path.join(OUT_DIR, `${tag}-xa3d.png`) }).catch(() => {});

  await viewer.getByTestId("xa3d-close").click();
  await viewer.waitForTimeout(600);
  if (await viewer.getByTestId("xa3d-dialog").isVisible().catch(() => false)) {
    await viewer.mouse.click(5, 5);
    await viewer.waitForTimeout(600);
  }

  if (!(await runPlugin(viewer, QUANT_ID))) throw new Error(`${tag}: angio-quant を起動できない`);
  await viewer.getByTestId("angio-quant-panel").waitFor({ state: "visible", timeout: 20_000 });
  const qfrBtn = viewer.getByTestId("angio-quant-qfr");
  if (await qfrBtn.isDisabled()) throw new Error(`${tag}: 3D モデルが無く QFR を開けない（3D 再構成が出なかった）`);
  await qfrBtn.click();
  await viewer.getByTestId("qfr-panel").waitFor({ state: "visible", timeout: 20_000 });

  const modelFacts = await viewer.evaluate(`(() => {
    const g = window.__graphyDebug;
    const m = g && g.getVesselModel ? g.getVesselModel() : null;
    if (!m) return null;
    const seg = (m.segments || [])[0] || null;
    const d = seg ? seg.diameterMm : [];
    const ok = d.filter((v) => v != null);
    return {
      kind: m.kind, pointCount: seg ? seg.points.length : 0,
      diameterNulls: d.length - ok.length,
      diameterMin: ok.length ? Math.min.apply(null, ok) : null,
      diameterMax: ok.length ? Math.max.apply(null, ok) : null,
      calibration: m.calibration,
      separationDeg: m.provenance ? m.provenance.separationDeg : null,
      angleCorrected: m.provenance ? m.provenance.angleCorrected : null,
    };
  })()`);
  fs.writeFileSync(path.join(OUT_DIR, `${tag}-vessel-model.json`), JSON.stringify(modelFacts, null, 2));

  // 流速モデルは既定（単一フレームなので fQFR）のまま。フレームカウントは行わない＝cQFR / aQFR は未達。
  const runQfr = viewer.getByTestId("qfr-run");
  check(await runQfr.isDisabled(), `[${tag}] ★Pa 未入力・向き未確認では計算ボタンが押せない`);
  await viewer.getByTestId("qfr-pa").fill(String(c.paMmHg));
  await viewer.waitForTimeout(200);
  const dirBox = viewer.getByTestId("qfr-direction");
  // S を選んでいれば本体が向きを確定している（H62）。無ければここで初めて確認が要る。
  const needsManual = await dirBox.isVisible().catch(() => false);
  if (needsManual) {
    console.log(`  [情報] ${tag}: 向きのチェックが画面に出た（本体が向きを確定していない）`);
  }
  if (await runQfr.isDisabled()) {
    if (needsManual) await dirBox.check();
    await viewer.waitForTimeout(200);
  }
  if (await runQfr.isDisabled()) throw new Error(`${tag}: Pa を入れても計算ボタンが押せない`);
  await runQfr.click();
  await viewer.waitForTimeout(5_000);

  const afterRun = (await viewer.getByTestId("qfr-panel").textContent()) ?? "";
  fs.writeFileSync(path.join(OUT_DIR, `${tag}-after-run.txt`), afterRun);
  await viewer.screenshot({ path: path.join(OUT_DIR, `${tag}-qfr-panel.png`) }).catch(() => {});
  if ((await viewer.getByTestId("qfr-value").count()) === 0) {
    throw new Error(`${tag}: QFR の値が出なかった（${afterRun.slice(-200).replace(/\s+/g, " ").trim()}）`);
  }
  const num = async (id: string) =>
    Number(((await viewer.getByTestId(id).textContent()) ?? "").replace(/[^0-9.]/g, ""));
  const qfr1d = await num("qfr-primary");
  const qfrKirkeeide = await num("qfr-cross");
  const diff = await num("qfr-diff");
  const displayed = ((await viewer.getByTestId("qfr-value").textContent()) ?? "").trim();
  const caveats = await viewer.getByTestId("qfr-caveats").locator("li").allTextContents();
  await viewer.close().catch(() => {});
  return { caseId, kind, status: "ok", qfr1d, qfrKirkeeide, diff, displayed, caveats, modelFacts };
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const segs = JSON.parse(
    fs.readFileSync(path.join(CASES_DIR, TRIAL === "B" ? "ffr-cases-segments-B.json" : "ffr-cases-segments.json"), "utf8"),
  ) as Segments;
  const uids = JSON.parse(fs.readFileSync(path.join(CASES_DIR, "ffr-cases-uids.json"), "utf8")) as Record<string, UidEntry>;
  console.log(`試行 ${TRIAL}・区間の版: ${segs.revision}（事前登録の区間ファイル）`);

  installAngioQuant();
  const driver = new DesktopDriver();
  await driver.start();
  const results: RunResult[] = [];
  try {
    driver.page.on("dialog", (d) => void d.accept().catch(() => {}));
    const only = process.env.FFR_ONLY; // 例 "Case1-primary"。確認用。全部走らせるときは未指定。
    for (const kind of ["primary", "secondary"] as RunKind[]) {
      for (const caseId of ["Case1", "Case2"] as CaseId[]) {
        if (only && only !== `${caseId}-${kind}`) continue;
        try {
          results.push(await runOne(driver, caseId, kind, segs, uids));
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          console.log(`  [未達] ${caseId}-${kind}: ${reason}`);
          results.push({ caseId, kind, status: "unreached", reason });
        }
      }
    }
  } finally {
    await driver.stop();
  }

  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2));

  console.log("\n── 結果 ──");
  for (const r of results) {
    console.log(
      r.status === "ok"
        ? `  ${r.caseId} ${r.kind}: QFR(1D) ${r.qfr1d} / Kirkeeide ${r.qfrKirkeeide} / 差 ${r.diff}（実測 FFR ${CASES[r.caseId].ffr}）`
        : `  ${r.caseId} ${r.kind}: 未達 — ${r.reason}`,
    );
  }
  const judge = (kind: RunKind) => {
    const c1 = results.find((r) => r.caseId === "Case1" && r.kind === kind);
    const c2 = results.find((r) => r.caseId === "Case2" && r.kind === kind);
    if (!c1 || !c2 || c1.status !== "ok" || c2.status !== "ok") return "未達";
    return c1.qfr1d! < CUTOFF && c2.qfr1d! > CUTOFF ? "合格" : "失敗";
  };
  console.log(`\n判定（基準: QFR(Case1) < ${CUTOFF} かつ QFR(Case2) > ${CUTOFF}・1D・fQFR）`);
  console.log(`  主解析（左主幹入口 → 遠位）: ${judge("primary")}`);
  console.log(`  副解析（LAD 起始部 → 遠位）: ${judge("secondary")}`);
  console.log("  cQFR / aQFR: 未達（フレームカウント未実施）");
  console.log(`\n検査 ${passed} 合格 / ${failures.length} 失敗`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

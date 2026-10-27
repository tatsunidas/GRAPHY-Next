/*
 * 2D QCA ダイアログの「側枝の候補を探す」（GN-XA-001 P2.5d）の実機検証。
 *
 * 準備:  cd bench && python3 make_phantom_xa.py --out ./phantom
 *        cd backend && mvn -q -Dfrontend.skip=true -DskipTests package
 * 実行:  cd automator && npx tsx src/spike/xaBranchProposalCheck.ts
 *
 * 見ること（正例と負例の両方）:
 * 1. QCA 結果が無いうちは「探す」が押せない。
 * 2. 近位の主枝区間を解析 → 「探す」→ 候補が出て、「追加」で解析区間の一覧が 1 本増え選択される。
 * 3. 追加した線を「実行」すると、中心線が**真値の娘枝**に重なる（候補が本当に娘枝だった裏取り）。
 * 4. 追加済みの候補のボタンは押せなくなり、中心線が変わると候補の一覧は消える。
 * 5. スクリーンショットで描画（緑の破線・英字ラベル）を目視する。
 *
 * ⚠️ ファントムは単純（側枝 1 本）で、合格しても実画像（カテーテル・ワイヤ・骨）の根拠にならない。
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
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-branch-proposal");
const HOST = "viewer2d-canvas-host";
const VIEW = 2;
const VARIANT = process.env.GNBP_XA3_VARIANT ?? "d-noise-mid";
/** 真値の主枝（60 点に間引き）での区間（始点・終点の添字）。 */
const PROXIMAL_FROM = 16;
/** 利用者が主枝を分岐の先まで引いたとする（分岐位置は 27）。 */
const BIF = 36;

interface VariantFiles {
  file: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
}
interface Truth {
  geometry: { mmPerPxAtIsocenter: number };
  recon3d: {
    views: {
      view: number;
      exact: VariantFiles;
      noise?: Record<string, VariantFiles>;
      branchesPx: { id: string; pointsPx: [number, number][] }[];
    }[];
  };
}

let pass = 0;
let fail = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) pass++;
  else fail++;
  const d = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  console.log(`  [${cond ? "ok  " : "FAIL"}] ${label}${d}`);
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

const optionCount = async (viewer: Page): Promise<number> =>
  (await viewer.evaluate(
    `(() => { const s = document.querySelector('[data-testid="xa-analysis-pick"]'); return s ? s.options.length : -1; })()`,
  )) as number;

const qcaState = async (viewer: Page): Promise<{ centerline: [number, number][] } | null> => {
  const raw = (await viewer.evaluate(`(() => {
    const g = window.__graphyDebug;
    const s = g && g.getQcaState ? g.getQcaState() : null;
    return s ? JSON.stringify({ centerline: s.centerline }) : null;
  })()`)) as string | null;
  return raw ? JSON.parse(raw) : null;
};

function distToPolyline(p: [number, number], pl: [number, number][]): number {
  let m = Infinity;
  for (let i = 1; i < pl.length; i++) {
    const [ax, ay] = pl[i - 1];
    const [bx, by] = pl[i];
    const dx = bx - ax;
    const dy = by - ay;
    const L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L));
    m = Math.min(m, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
  }
  return m;
}

async function main(): Promise<void> {
  if (!fs.existsSync(TRUTH_PATH)) throw new Error(`ファントムがありません: ${PHANTOM_DIR}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const truth = JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8")) as Truth;
  const v = truth.recon3d.views.find((x) => x.view === VIEW)!;
  const files = VARIANT === "exact" ? v.exact : v.noise?.[VARIANT];
  if (!files) throw new Error(`版 "${VARIANT}" がありません`);
  const mainPts = v.branchesPx.find((b) => b.id === "main")!.pointsPx;
  const dauPts = v.branchesPx.find((b) => b.id === "daughter")!.pointsPx;
  console.log(`[版] ${VARIANT} / 視点 ${VIEW}`);

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [path.join(PHANTOM_DIR, files.file)]);
    check(imp.imported === 1, "[準備] 取り込めた", imp);
    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    await openStudy(mainPage, files.studyInstanceUid);
    const row = mainPage.locator(`[data-testid="series-row-${files.seriesInstanceUid}"]`);
    await row.waitFor({ state: "visible", timeout: 30_000 });
    await row.click();
    await mainPage.waitForTimeout(400);
    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);

    // 近位の主枝区間を引く（長さツール）。
    await viewer.getByTestId("viewer2d-menu-measure").click();
    await viewer.waitForTimeout(250);
    await viewer.getByText("長さ", { exact: true }).first().click();
    await viewer.waitForTimeout(300);
    await drawBetweenImagePixels(viewer, mainPts[PROXIMAL_FROM], mainPts[BIF]);
    await viewer.getByTestId("xa-analysis-open").click();
    await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });

    // 1. 結果が無いうちは押せない（負例）。
    check(
      await viewer.getByTestId("xa-branch-find").isDisabled(),
      "[負例] QCA 結果が無いうちは「探す」が押せない",
    );
    const before = await optionCount(viewer);
    check(before === 1, "[準備] 解析区間が 1 本ある", before);
    await viewer.selectOption('[data-testid="xa-analysis-pick"]', "0");
    await viewer.getByTestId("xa-qca-run").click();
    await viewer.waitForTimeout(3_500);
    check(!(await viewer.getByTestId("xa-branch-find").isDisabled()), "[正例] QCA 結果が出ると「探す」が押せる");
    check((await viewer.getByTestId("xa-branch-proposals").count()) === 0, "[負例] 押すまでは候補を出さない（自動では走らない）");

    // 2. 探す。
    await viewer.getByTestId("xa-branch-find").click();
    await viewer.waitForTimeout(1_500);
    const items = await viewer.getByTestId("xa-branch-item").count();
    check(items >= 1, "[正例] 側枝の候補が出た", items);
    console.log("[診断] 候補:", await viewer.getByTestId("xa-branch-item").allTextContents());
    await viewer.getByTestId("xa-pick-preview").scrollIntoViewIfNeeded().catch(() => {});
    await viewer.waitForTimeout(300);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-proposals-full.png") }).catch(() => {});
    if (items < 1) return;

    // 3. 追加 → 一覧が 1 本増えて選択される。
    // 人が選ぶ代わりに、最も長い候補（娘枝）を選ぶ。最初の候補は主枝の続き（短い）のことがある。
    const texts = await viewer.getByTestId("xa-branch-item").allTextContents();
    const lens = texts.map((x) => parseFloat(/長さ ([\d.]+) mm/.exec(x)?.[1] ?? "0"));
    const pickIdx = lens.indexOf(Math.max(...lens));
    await viewer.getByTestId("xa-branch-add").nth(pickIdx).click();
    await viewer.waitForTimeout(500);
    const after = await optionCount(viewer);
    check(after === before + 1, "[正例] 「追加」で解析区間の一覧が 1 本増えた", { before, after });
    const selectedIdx = (await viewer.evaluate(
      `(() => { const s = document.querySelector('[data-testid="xa-analysis-pick"]'); return s ? s.selectedIndex : -1; })()`,
    )) as number;
    check(selectedIdx === after - 1, "[正例] 追加した線が選択されている", { selectedIdx, after });
    check(await viewer.getByTestId("xa-branch-add").nth(pickIdx).isDisabled(), "[負例] 追加済みの候補は、もう一度追加できない");
    // 追加しただけでは解析しない（人が「実行」を押すまで）。
    const stateBefore = await qcaState(viewer);
    await viewer.getByTestId("xa-qca-run").click();
    await viewer.waitForTimeout(3_500);
    const st = await qcaState(viewer);
    const brief = (q: { centerline: [number, number][] } | null) =>
      q ? { n: q.centerline.length, first: q.centerline[0], last: q.centerline[q.centerline.length - 1] } : null;
    console.log("[診断] 実行前の状態:", JSON.stringify(brief(stateBefore)), "/ 実行後:", JSON.stringify(brief(st)), "/ 娘枝の真値の端:", JSON.stringify([dauPts[0], dauPts[dauPts.length - 1]]), "/ 主枝区間:", JSON.stringify([mainPts[PROXIMAL_FROM], mainPts[BIF]]));
    const dump = (await viewer.evaluate(`(() => document.body.innerText.split(String.fromCharCode(10)).filter((l) => /短すぎ|失敗|できません|解析できません/.test(l)).slice(0, 5).join(" | "))()`)) as string;
    console.log("[診断] 画面の警告・エラー:", dump, "/ 一覧:", await viewer.evaluate(`(() => Array.from(document.querySelector('[data-testid="xa-analysis-pick"]').options).map((o) => o.textContent).join(" || "))()`));
    check(!!st && st.centerline.length > 20, "[正例] 追加した線を「実行」で解析できた", st?.centerline.length);
    check(stateBefore === null, "[負例] 追加しただけでは解析されない（人が「実行」を押すまで結果が無い）", brief(stateBefore));
    // 4. 中心線が真値の娘枝に重なる（候補が本当に娘枝だった）。
    if (st) {
      const near = st.centerline.filter((p) => distToPolyline(p, dauPts) <= 3).length / st.centerline.length;
      check(near >= 0.8, "[正例] 解析した中心線の 80% 以上が真値の娘枝から 3 px 以内", { near: Number(near.toFixed(3)) });
      const nearMain = st.centerline.filter((p) => distToPolyline(p, mainPts) <= 3).length / st.centerline.length;
      check(nearMain < 0.5, "[負例] 解析した中心線は主枝をなぞったものではない", { nearMain: Number(nearMain.toFixed(3)) });
    }
    // 別の線を解析しても、主枝に対する候補の一覧は残り、追加済みのものは押せない（残りを追加できる）。
    check(
      (await viewer.getByTestId("xa-branch-proposals").count()) === 1 && (await viewer.getByTestId("xa-branch-add").nth(pickIdx).isDisabled()),
      "[正例] 追加した線を解析した後も候補の一覧が残り、追加済みは押せない",
    );
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-after-run.png") }).catch(() => {});
  } finally {
    await driver.stop().catch(() => {});
    console.log(`\n結果: ${pass} 合格 / ${fail} 失敗`);
    process.exitCode = fail ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/*
 * QVA（末梢・脳血管の定量解析 / A5a）の実機検証 — `fw/angio-design.md` §9.1。
 *
 * 準備:  cd bench && python3 make_phantom_xa.py --out ./phantom   # GNBP-XA-6 が要る
 *        cd backend && mvn -q -Dfrontend.skip=true -DskipTests package
 * 実行:  cd automator && npx tsx src/spike/xaQvaCheck.ts
 *
 * <h3>ここで確かめたいこと</h3>
 * 1. **瘤の大きさを真値と突き合わせる**（GNBP-XA-6 は最大径・瘤長・偏心が既知）。
 * 2. 🔑 **比（最大径 / 参照径）は半値法の系統誤差（約 13% 過小・§16.4）が打ち消される**こと。
 *    絶対径は真値 ×0.870 に寄り、**比は真値どおり**——という非対称を数値で見る。
 *    「1.5 倍以上を瘤と呼ぶ」という判定がこの性質の上に乗っているので、ここが要。
 * 3. **紡錘状と嚢状を偏心度で区別できる**こと（最大径が同じでも別物）。
 * 4. **拡張が無いフレームで瘤を作り出さない**こと。
 * 5. ランチャーの QVA カードから**このダイアログが開く**こと（A13-2 の経路に新しい行き先を足した）。
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
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-qva");
const HOST = "viewer2d-canvas-host";

/**
 * 🚨 既知の系統誤差（§16.4）の**幅**。半値法は円柱の径を過小に測るが、
 * **係数は径に依存する**（実測: 3mm で 0.870、6mm で 0.908）。
 * 「0.870 ちょうど」を期待すると太い血管で必ず落ちるので、**帯で見る**。
 */
const FACTOR_MIN = 0.85;
const FACTOR_MAX = 0.93;
/** 【目標】比の絶対誤差。判定（1.5 倍）が乗っている量なので、ここは厳しく見る。 */
const TARGET_RATIO = 0.1;
/** 【目標】瘤長の絶対誤差 [mm]。 */
const TARGET_LENGTH_MM = 2.0;

interface QvaFrameTruth {
  frame: number;
  referenceDiameterMm: number;
  maxDiameterMm: number;
  ratio: number;
  aneurysmLengthMm: number;
  eccentricity: number | null;
  saccular: boolean;
  aneurysmal: boolean;
  blurSigmaPx: number;
  photonsPerPixel: number | null;
}

interface Truth {
  qva: {
    file: string;
    studyInstanceUid: string;
    mmPerPx: number;
    aneurysmRatio: number;
    frames: QvaFrameTruth[];
  };
}

interface QvaState {
  imageId: string;
  unit: string;
  mld: number;
  rvd: number;
  qva: {
    maxDiameter: number;
    referenceAtMax: number;
    ratio: number;
    percentDilation: number;
    length: number;
    proximalNeck: number;
    distalNeck: number;
    eccentricity: number | null;
    aneurysmal: boolean;
  } | null;
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

/** 設計目標。未達でも失敗にはしないが、**合格にも数えない**（xaPhantomCheck と同じ方針）。 */
function target(cond: boolean, label: string, detail?: unknown): void {
  if (cond) pass++;
  else unmet++;
  const d = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  lines.push(`  [${cond ? "ok  " : "UNMET"}] ${label}${d}`);
  console.log(lines[lines.length - 1]);
}

async function qvaState(page: Page): Promise<QvaState | null> {
  const raw = (await page.evaluate(`(() => {
    const g = window.__graphyDebug;
    const s = g && g.getQcaState ? g.getQcaState() : null;
    return s ? JSON.stringify(s) : null;
  })()`)) as string | null;
  return raw ? (JSON.parse(raw) as QvaState) : null;
}

async function openStudy(page: Page, studyUid: string): Promise<void> {
  await dismissStartupDialogs(page);
  const blocker = await findBlockingOverlay(page, "search-submit-button");
  if (blocker) throw new Error(`検索ボタンが別の要素に塞がれています: ${blocker}`);
  // ⚠️ ダイアログは main() で一括して受けている。ここで once を足すと
  //    「already handled」で落ちる（実際に踏んだ）。
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

/** 血管軸に沿って解析区間を引く（画像中央 ±halfSpanMm）。座標は**キャンバス**の割合。 */
async function drawSegment(viewer: Page, halfSpanMm: number): Promise<void> {
  const raw = (await viewer.evaluate(`(() => {
    const g = window.__graphyDebug;
    const geo = g && g.getViewportGeometry ? g.getViewportGeometry() : null;
    if (!geo || !geo.length) return null;
    const v = geo[0];
    return JSON.stringify({ h: v.canvas.height, w: v.canvas.width, ps: v.camera.parallelScale });
  })()`)) as string | null;
  if (!raw) throw new Error("ビューポートの幾何を取得できませんでした");
  const { h, w, ps } = JSON.parse(raw) as { h: number; w: number; ps: number };
  const mmPerCanvasPx = (2 * ps) / h;
  const halfPx = halfSpanMm / mmPerCanvasPx;
  if (halfPx * 2 < 20) throw new Error(`表示が小さすぎて区間を引けません（${(halfPx * 2).toFixed(1)}px）`);
  await dragOnCanvasHost(viewer, HOST, Math.round(halfPx * 2), 0, 0, 12, {
    fracX: 0.5 - halfPx / w,
    fracY: 0.5,
  });
  await viewer.waitForTimeout(800);
}

async function main(): Promise<void> {
  if (!fs.existsSync(TRUTH_PATH)) throw new Error(`ファントムがありません: ${PHANTOM_DIR}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const truth = JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8")) as Truth;
  if (!truth.qva) throw new Error("truth.json に qva がありません（make_phantom_xa.py を回し直す）");
  const rows: Record<string, unknown>[] = [];

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [path.join(PHANTOM_DIR, truth.qva.file)]);
    check(imp.imported === 1, "[準備] GNBP-XA-6 を取り込めた", imp);

    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    await openStudy(mainPage, truth.qva.studyInstanceUid);
    await mainPage.locator('[data-testid^="series-row-"]').first().click();

    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);
    await selectLengthTool(viewer);

    for (const t of truth.qva.frames) {
      await viewer.getByTestId("cine-seek").fill(String(t.frame - 1));
      await viewer.waitForTimeout(900);
      // 計測は imageId（＝フレーム）ごとなので、解析するフレームで引き直す。
      await drawSegment(viewer, 40);
      await viewer.getByTestId("qva-open").click();
      await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });
      await viewer.getByTestId("xa-qca-run").click();
      await viewer.waitForTimeout(3_500);
      const st = await qvaState(viewer);
      const analyzedFrame = /[?&]frame=(\d+)/.exec(st?.imageId ?? "")?.[1];
      const shownJudgement = await viewer
        .getByTestId("qva-judgement")
        .textContent()
        .catch(() => null);
      const noDilationShown = (await viewer.getByTestId("qva-no-dilation").count()) > 0;

      const label =
        `frame ${t.frame} (${t.saccular ? "嚢状" : "紡錘状"} 比 ${t.ratio}, 長 ${t.aneurysmLengthMm}mm` +
        `${t.photonsPerPixel ? `, I0=${t.photonsPerPixel}` : ""})`;
      // 🚨 別フレームの結果でも「もっともらしい数値」が出る。**解析した imageId** で確かめる。
      check(analyzedFrame === String(t.frame), `[XA-6] ${label} — ★狙ったフレームを解析している`, {
        want: t.frame,
        analyzed: analyzedFrame,
      });

      if (!t.aneurysmal && t.ratio === 1.0) {
        // 拡張の無いフレーム。**瘤を作り出さない**ことが要点。
        check(st?.qva == null, `[XA-6] ${label} — ★拡張が無ければ瘤を報告しない`, st?.qva);
        check(noDilationShown, `[XA-6] ${label} — 画面にも「拡張なし」と出る`);
        await viewer.getByTestId("xa-dialog-close").click();
        await viewer.waitForTimeout(400);
        continue;
      }

      if (!st?.qva) {
        check(false, `[XA-6] ${label} — 拡張を検出できた`, { state: st });
        await viewer.getByTestId("xa-dialog-close").click();
        await viewer.waitForTimeout(400);
        continue;
      }
      const q = st.qva;
      rows.push({
        frame: t.frame,
        truthRatio: t.ratio,
        measuredRatio: Number(q.ratio.toFixed(3)),
        ratioError: Number((q.ratio - t.ratio).toFixed(3)),
        truthMaxMm: t.maxDiameterMm,
        measuredMaxMm: Number(q.maxDiameter.toFixed(3)),
        factor: Number((q.maxDiameter / t.maxDiameterMm).toFixed(3)),
        truthLengthMm: t.aneurysmLengthMm,
        measuredLengthMm: Number(q.length.toFixed(2)),
        eccentricity: q.eccentricity == null ? null : Number(q.eccentricity.toFixed(3)),
        saccular: t.saccular,
        aneurysmal: q.aneurysmal,
      });

      check(st.unit === "mm", `[XA-6] ${label} — 単位が mm（装置校正済みタグを読めている）`, st.unit);
      // ── ★ 比は系統誤差に依らない ────────────────────────────────
      target(Math.abs(q.ratio - t.ratio) < TARGET_RATIO, `[XA-6] ${label} — 【目標】拡張比の誤差 < ${TARGET_RATIO}`, {
        truth: t.ratio,
        measured: Number(q.ratio.toFixed(3)),
      });
      // ── 絶対径は既知の系統誤差どおり（＝ここがずれたらエッジ検出か校正が壊れている）──
      const factor = q.maxDiameter / t.maxDiameterMm;
      check(
        factor > FACTOR_MIN && factor < FACTOR_MAX,
        `[XA-6] ${label} — 最大径が既知の系統誤差の帯に入る（真値 × ${FACTOR_MIN}〜${FACTOR_MAX}）`,
        { factor: Number(factor.toFixed(3)), measured: Number(q.maxDiameter.toFixed(3)), truth: t.maxDiameterMm },
      );
      check(
        q.aneurysmal === t.aneurysmal,
        `[XA-6] ${label} — 瘤かどうかの判定が真値と一致（基準 ${truth.qva.aneurysmRatio} 倍）`,
        { truth: t.aneurysmal, measured: q.aneurysmal },
      );
      check(
        (shownJudgement ?? "").includes(String(truth.qva.aneurysmRatio)),
        `[XA-6] ${label} — ★画面に判定と**基準そのもの**が出ている`,
        shownJudgement,
      );
      target(
        Math.abs(q.length - t.aneurysmLengthMm) < TARGET_LENGTH_MM,
        `[XA-6] ${label} — 【目標】瘤長の誤差 < ${TARGET_LENGTH_MM}mm`,
        { truth: t.aneurysmLengthMm, measured: Number(q.length.toFixed(2)) },
      );
      // ── ★ 紡錘状と嚢状の区別 ────────────────────────────────────
      if (q.eccentricity != null) {
        check(
          t.saccular ? q.eccentricity > 0.4 : q.eccentricity < 0.25,
          `[XA-6] ${label} — ★偏心度が形を言い当てる`,
          { saccular: t.saccular, eccentricity: Number(q.eccentricity.toFixed(3)) },
        );
      }
      // ネックは参照径に戻っているはず（系統誤差ぶんだけ小さく出る）。
      check(
        Math.abs(q.proximalNeck - t.referenceDiameterMm * 0.87) < 0.3 &&
          Math.abs(q.distalNeck - t.referenceDiameterMm * 0.87) < 0.3,
        `[XA-6] ${label} — ネック径が参照径に戻っている`,
        { prox: Number(q.proximalNeck.toFixed(3)), dist: Number(q.distalNeck.toFixed(3)) },
      );

      // 最初の瘤フレームだけ SR 保存まで通す（保存経路は 1 回確かめれば足りる）。
      if (t.frame === 1) {
        await viewer.getByTestId("xa-save-sr").click();
        await viewer.waitForTimeout(2_500);
        const saved = await viewer.getByTestId("xa-analysis-dialog").locator("..").textContent();
        check(
          (saved ?? "").includes("SR") || (saved ?? "").includes("保存"),
          "[XA-6] QVA の結果を SR として保存できる",
          (saved ?? "").replace(/\s+/g, " ").slice(-140),
        );
      }
      await viewer.getByTestId("xa-dialog-close").click();
      await viewer.waitForTimeout(400);
    }
    // ★ 係数が径に依存することを**数値で残す**（比が完全には打ち消せない理由）。
    const f3 = rows.find((r) => r.truthMaxMm === 3.6)?.factor as number | undefined;
    const f6 = rows.find((r) => r.truthMaxMm === 6)?.factor as number | undefined;
    check(
      f3 != null && f6 != null && f6 > f3,
      "[XA-6] ★半値法の係数は径が太いほど 1 に近づく（比が数 % 残る理由）",
      { at3_6mm: f3, at6mm: f6 },
    );

    await viewer.screenshot({ path: path.join(OUT_DIR, "1-qva.png") }).catch(() => {});
    fs.writeFileSync(path.join(OUT_DIR, "qva-accuracy.json"), JSON.stringify(rows, null, 2));
    console.table(rows);
    await viewer.close().catch(() => {});

    // ══ ランチャー（A13-2）から QVA が開く ═══════════════════════════
    await mainPage.bringToFront();
    await mainPage.getByTestId("mainscreen-menu-function").click();
    await mainPage.getByTestId("menu-item-task-launcher").click();
    await mainPage.getByTestId("task-launcher").waitFor({ state: "visible", timeout: 10_000 });
    const enabled = await mainPage.getByTestId("task-card-qva").getAttribute("data-enabled");
    check(enabled === "1", "[ランチャー] QVA のカードが押せる（実装済みになった）", enabled);
    const viewer2 = await driver.waitForNewPage(
      () => mainPage.getByTestId("task-card-qva").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer2.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    // ⚠️ 依頼の有効期限は 60 秒（`xaTaskLaunch.ts`）。ビューアの起動が遅い実行では
    //    20 秒では足りず、**同じコードで通ったり落ちたりした**（実際に 1 度落ちた）。
    //    期限より短く、かつ余裕のある 40 秒で待つ。
    const opened = await viewer2
      .getByTestId("xa-analysis-dialog")
      .waitFor({ state: "visible", timeout: 40_000 })
      .then(() => true)
      .catch(() => false);
    if (!opened) {
      // 失敗したときに「開かなかった」だけでは切り分けられない。ビューア側の状態を残す。
      const diag = await viewer2.evaluate(`(() => JSON.stringify({
        url: location.href,
        tiles: document.querySelectorAll('[data-testid="series-viewer-root"]').length,
        qvaButton: document.querySelectorAll('[data-testid="qva-open"]').length,
        dialogs: document.querySelectorAll('[data-testid="xa-analysis-dialog"]').length,
        toast: (document.querySelector('[data-testid="toast"]') || {}).textContent || null,
      }))()`);
      await viewer2.screenshot({ path: path.join(OUT_DIR, "3-launcher-failed.png") }).catch(() => {});
      check(false, "[ランチャー] ★カードからビューアが開き QVA のダイアログまで開く", diag);
    } else {
      check(true, "[ランチャー] ★カードからビューアが開き QVA のダイアログまで開く");
    }
    if (opened) {
      // 🚨 QCA と同じダイアログなので、**開いたのが QVA であること**を明示的に見る。
      check(
        (await viewer2.getByTestId("xa-analysis-dialog").getAttribute("data-mode")) === "qva",
        "[ランチャー] ★開いたのは QCA ではなく QVA",
      );
      await viewer2.screenshot({ path: path.join(OUT_DIR, "2-launcher-qva.png") }).catch(() => {});
    }
  } finally {
    await driver.stop().catch(() => {});
    const summary = `\n===== QVA（A5a・GNBP-XA-6）実機検証 =====\n合格 ${pass} / 失敗 ${fail} / 設計目標に未達 ${unmet}`;
    console.log(summary);
    fs.writeFileSync(path.join(OUT_DIR, "log.txt"), lines.join("\n") + summary + "\n");
  }
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

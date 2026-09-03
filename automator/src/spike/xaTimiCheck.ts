/*
 * TIMI フレームカウント（A15）の実機検証 — `fw/angio-design.md` §24。
 *
 * 実行:  cd automator && npx tsx src/spike/xaTimiCheck.ts
 *
 * <h3>この機能で検証できること・できないこと</h3>
 * 🔴 **開始/到達フレームの「正しさ」は検証できない。** 真値は人が数えた値しか無く、
 * 合成ボーラスを立てて同じ閾値モデルで検出すれば必ず当たる（この repo が 4 回踏んだ
 * 「測る側と同じモデルで的を作る」罠）。**だから製品側で自動決定しない設計を採っている。**
 *
 * ✅ **検証できるのは換算式と規則**——与えたフレーム差から出る数字が正しいか、
 * そして**出してはいけない条件で出していないか**。後者がこの機能の要点なので、
 * 検査の半分は「**数字が出ないこと**」を見ている。
 *
 * <h3>運用（この repo で実際に踏んだ罠）</h3>
 * 🚨 走らせる前に `.results/xa-timi` を消す（失敗した実行が前回の成果物を持ち帰る）。
 * 🚨 編集直後の 1 回目は測定値として使わない（Vite が冷えていて座標が 1px ずれる）。
 * 🚨 実機を回す前に `git branch --show-current` を見る。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-timi");
const XA_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "xa-angio");
/** 96 フレーム・FrameTime 33ms（≒30.303fps）。右冠動脈系なので RCA を選ぶのが自然。 */
const SAMPLE = "0002.DCM";
/** 与えるフレーム（0 origin）。 */
const START = 10;
const END = 40;

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

interface TimiState {
  imageId: string | null;
  vessel: string | null;
  startFrame: number | null;
  endFrame: number | null;
  endSelection: string | null;
  currentFrame: number;
  frameCount: number;
  fps: number;
  fpsSource: string;
  frameTimesMs: number[];
  roi: { x0: number; y0: number; x1: number; y1: number } | null;
  roiFrame: number | null;
  intensityCurve: { frame: number; value: number }[];
  candidateFrame: number | null;
  result: {
    vessel: string;
    frames: number;
    elapsedMs: number | null;
    tfc30: number | null;
    ctfc: number | null;
    fps: number;
    fpsSource: string;
    rateUniform: boolean;
    unit: string;
    warnings: string[];
  } | null;
  steps: { id: string; state: string; reasonKey: string | null }[];
}

async function timiState(page: Page): Promise<TimiState | null> {
  const raw = await page.evaluate(`(() => {
    const g = window.__graphyDebug;
    const s = g && g.getTimiState ? g.getTimiState() : null;
    return s ? JSON.stringify(s) : null;
  })()`);
  return raw ? (JSON.parse(raw as string) as TimiState) : null;
}

const stepState = (s: TimiState, id: string) => s.steps.find((x) => x.id === id);

async function firstStudyUid(httpPort: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/studies`);
  const list = (await res.json()) as { studyInstanceUid: string }[];
  if (!list.length) throw new Error("スタディがありません");
  return list[0].studyInstanceUid;
}

/**
 * 画像の上（＝ダイアログの箱の**外**）でホイールを回してフレームを送る。
 *
 * 🚨 **キャンバスの中心を使ってはいけない。** ダイアログは画面中央に出るので、
 * 中心はパネルの上になる。最初にそう書いて「外でも中でもフレームが動かない」という
 * 結果になり、**製品の不具合と読み違えかけた**（2026-09-03）。
 * この repo の「操作したつもりで何も起きていない」の典型。
 * → **パネルの外にある点**を実際に計算して使う。
 */
async function wheelOutsideDialog(viewer: Page, ticks: number): Promise<void> {
  const at = await pointOutsideDialog(viewer);
  await viewer.mouse.move(at.x, at.y);
  for (let i = 0; i < Math.abs(ticks); i++) {
    await viewer.mouse.wheel(0, ticks > 0 ? 120 : -120);
    await viewer.waitForTimeout(60);
  }
  await viewer.waitForTimeout(300);
}

/** キャンバスの上で、かつダイアログのパネルに重ならない点。 */
async function pointOutsideDialog(viewer: Page): Promise<{ x: number; y: number }> {
  const host = await viewer.getByTestId("viewer2d-canvas-host").first().boundingBox();
  if (!host) throw new Error("キャンバスが見つかりません");
  const panel = await viewer.getByTestId("xa-timi-dialog").boundingBox();
  if (!panel) return { x: host.x + host.width / 2, y: host.y + host.height / 2 };
  // パネルの左側に十分な隙間があればそこ、無ければ上側を使う。
  const gapLeft = panel.x - host.x;
  if (gapLeft > 40) return { x: host.x + gapLeft / 2, y: host.y + host.height / 2 };
  const gapTop = panel.y - host.y;
  if (gapTop > 40) return { x: host.x + host.width / 2, y: host.y + gapTop / 2 };
  throw new Error("ダイアログがキャンバスを覆い尽くしていて、画像の上を指せません");
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sample = path.join(XA_DIR, SAMPLE);
  if (!fs.existsSync(sample)) {
    throw new Error(`XA のサンプルがありません: ${sample}（bash automator/scripts/fetch-xa-samples.sh）`);
  }

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [sample]);
    check(imp.imported === 1, "[準備] サンプルを取り込めた", imp);
    const studyUid = await firstStudyUid(driver.ports.http);

    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    const blocked = await findBlockingOverlay(mainPage, "search-submit-button");
    if (blocked) throw new Error(`クリックが塞がれています: ${blocked}`);
    const dates = mainPage.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await mainPage.getByTestId("search-submit-button").click();
    await mainPage.getByTestId(`study-row-${studyUid}`).click();
    await mainPage.locator('[data-testid^="series-row-"]').first().click();

    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);

    // ── 1. 導線とダイアログ ────────────────────────────────────────
    check(
      await viewer.getByTestId("timi-open").isVisible().catch(() => false),
      "[1] XA シリーズに TIMI の導線が出る",
    );
    await viewer.getByTestId("timi-open").click();
    await viewer.getByTestId("xa-timi-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await viewer.waitForTimeout(1_500);

    let s = await timiState(viewer);
    check(!!s, "[1] 状態を取得できる");
    if (!s) throw new Error("TIMI の状態を取得できませんでした");

    // ── 2. 撮影レートの読み取り ────────────────────────────────────
    check(s.fpsSource === "frameTime", "[2] ★撮影レートの根拠が FrameTime（既定 15fps に落ちていない）", {
      fpsSource: s.fpsSource,
      fps: s.fps,
    });
    check(Math.abs(s.fps - 1000 / 33) < 0.01, "[2] fps が 30.303（FrameTime 33ms）", { fps: s.fps });
    check(s.frameCount === 96, "[2] 96 フレーム", { frameCount: s.frameCount });
    check(s.frameTimesMs.length === s.frameCount, "[2] フレーム時刻が全フレームぶんある", {
      n: s.frameTimesMs.length,
    });
    const steps33 = s.frameTimesMs.slice(1).map((t, i) => t - s!.frameTimesMs[i]);
    check(
      steps33.every((d) => Math.abs(d - 33) < 1e-6),
      "[2] フレーム間隔が 33ms 一定（可変レートではない）",
      { first: steps33[0], last: steps33[steps33.length - 1] },
    );
    check(stepState(s, "rate")?.state === "done", "[2] 段「撮影レート」が done", stepState(s, "rate"));

    // ── 3. 血管を選ぶまで結果を出さない ────────────────────────────
    check(s.result === null, "[3] ★血管を選ぶまで結果を出さない", { result: s.result });
    check(stepState(s, "vessel")?.state === "active", "[3] 段「血管」が active", stepState(s, "vessel"));
    check(
      await viewer.getByTestId("timi-no-result").isVisible().catch(() => false),
      "[3] 結果が出ない理由を画面に書いている",
    );

    await viewer.getByTestId("timi-vessel-rca").click();
    await viewer.waitForTimeout(300);
    s = (await timiState(viewer))!;
    check(s.vessel === "rca", "[3] 血管を選べる", { vessel: s.vessel });
    check(
      await viewer.getByTestId("timi-landmark").isVisible().catch(() => false),
      "[3] 指標点の説明を画面に出している",
    );

    // ── 4. フレームを与えて換算を検算する ──────────────────────────
    // ビューアのフレームを START へ送ってから「開始にする」。
    // 🔑 ダイアログの外（画像の上）でホイールが効くことの確認も兼ねている。
    const before = (await timiState(viewer))!.currentFrame;
    await wheelOutsideDialog(viewer, 3);
    const after = (await timiState(viewer))!.currentFrame;
    check(after !== before, "[4] ★ダイアログの外（画像の上）ではフレームを送れる", { before, after });

    // ダイアログの中でホイールを回してもフレームが動かないこと。
    const panelBox = await viewer.getByTestId("xa-timi-dialog").boundingBox();
    if (panelBox) {
      // 箱の中で回す（ここが動いてしまうと、ダイアログをスクロールできない）。
      await viewer.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height / 2);
      const f0 = (await timiState(viewer))!.currentFrame;
      await viewer.mouse.wheel(0, 120);
      await viewer.waitForTimeout(300);
      const f1 = (await timiState(viewer))!.currentFrame;
      check(f0 === f1, "[4] ★ダイアログの中のホイールでフレームが送られない", { f0, f1 });
    }

    // 与えたフレームでの計算を検算する。表示フレームに依らず数値が決まることを見たいので、
    // デバッグ API 越しではなく画面の操作（現在フレームを採用）で入れる。
    await setFrame(viewer, START);
    await viewer.getByTestId("timi-use-start").click();
    await setFrame(viewer, END);
    await viewer.getByTestId("timi-use-end").click();
    await viewer.waitForTimeout(400);
    s = (await timiState(viewer))!;

    check(s.startFrame === START && s.endFrame === END, "[4] 開始・到達を指定できた", {
      start: s.startFrame,
      end: s.endFrame,
    });
    check(!!s.result, "[4] 結果が出た");
    if (s.result) {
      check(s.result.frames === END - START, "[4] フレーム差 = 到達 − 開始", { frames: s.result.frames });
      // ★スパイク側で独立に計算した期待値と突き合わせる（製品の式を写さない）。
      const expected = ((END - START) * 33 * 30) / 1000; // 経過 990ms → 29.70
      check(
        s.result.tfc30 != null && Math.abs(s.result.tfc30 - expected) < 0.05,
        "[4] ★TFC30 が独立計算と一致（30fps 換算が効いている）",
        { tfc30: s.result.tfc30, expected },
      );
      check(s.result.unit === "frames@30fps", "[4] 単位が frames@30fps", { unit: s.result.unit });
      check(s.result.rateUniform === true, "[4] 一様レートと判定している");
      check(s.result.ctfc === null, "[4] ★RCA では CTFC を出さない（LAD 補正を掛けない）", {
        ctfc: s.result.ctfc,
      });
      check(
        s.result.warnings.includes("rateNot30") === false,
        "[4] 30.303fps は 30fps とみなす（±0.5 の許容内）",
        { warnings: s.result.warnings },
      );
    }

    // ── 5. LAD に切り替えると CTFC が出る／フレーム選択は捨てる ─────
    await viewer.getByTestId("timi-vessel-lad").click();
    await viewer.waitForTimeout(300);
    s = (await timiState(viewer))!;
    check(
      s.startFrame === null && s.endFrame === null,
      "[5] ★血管を変えるとフレーム選択を捨てる（別の入口部・別の指標点だから）",
      { start: s.startFrame, end: s.endFrame },
    );
    await setFrame(viewer, START);
    await viewer.getByTestId("timi-use-start").click();
    await setFrame(viewer, END);
    await viewer.getByTestId("timi-use-end").click();
    await viewer.waitForTimeout(400);
    s = (await timiState(viewer))!;
    if (s.result) {
      const expectedCtfc = s.result.tfc30! / 1.7;
      check(
        s.result.ctfc != null && Math.abs(s.result.ctfc - expectedCtfc) < 1e-6,
        "[5] ★LAD では CTFC = TFC30 / 1.7",
        { ctfc: s.result.ctfc, expected: expectedCtfc },
      );
    }

    // ── 6. 出してはいけない条件で出さない ──────────────────────────
    // (a) 到達 < 開始
    await setFrame(viewer, START - 5);
    await viewer.getByTestId("timi-use-end").click();
    await viewer.waitForTimeout(400);
    s = (await timiState(viewer))!;
    check(s.result === null, "[6] ★到達 < 開始 では数字を出さない", { result: s.result });
    check(
      stepState(s, "end")?.reasonKey === "timi.step.reason.endBeforeStart",
      "[6] その理由を段に出している",
      stepState(s, "end"),
    );
    check(
      await viewer.getByTestId("timi-end-before-start").isVisible().catch(() => false),
      "[6] その理由を本文にも出している",
    );

    // (b) 到達がランの最終フレーム
    await setFrame(viewer, s.frameCount - 1);
    await viewer.getByTestId("timi-use-end").click();
    await viewer.waitForTimeout(400);
    s = (await timiState(viewer))!;
    check(s.result === null, "[6] ★到達が最終フレームなら、確認するまで数字を出さない", {
      result: s.result,
    });
    check(
      stepState(s, "end")?.reasonKey === "timi.step.reason.endAtLastFrame",
      "[6] 造影が途中で切れている可能性を段に出している",
      stepState(s, "end"),
    );
    await viewer.getByTestId("timi-confirm-last-frame").check();
    await viewer.waitForTimeout(400);
    s = (await timiState(viewer))!;
    check(!!s.result, "[6] 確認すれば出す");
    check(
      s.result?.warnings.includes("endAtLastFrame") === true,
      "[6] 確認しても注記は消さない",
      s.result?.warnings,
    );

    // ── 7. ROI が無ければカーブを作らない ──────────────────────────
    check(s.roi === null, "[7] ROI は既定で無い");
    check(
      s.intensityCurve.length === 0,
      "[7] ★ROI が無ければ時間輝度カーブを作らない（全画面平均へ落ちない）",
      { n: s.intensityCurve.length },
    );
    check(
      await viewer.getByTestId("timi-roi-none").isVisible().catch(() => false),
      "[7] ROI が無いことを画面に出している",
    );

    // ROI を引く（ダイアログの中のキャンバス上でドラッグ）。
    const canvas = viewer.getByTestId("timi-roi-canvas");
    const cb = await canvas.boundingBox();
    if (cb) {
      await viewer.mouse.move(cb.x + cb.width * 0.4, cb.y + cb.height * 0.4);
      await viewer.mouse.down();
      await viewer.mouse.move(cb.x + cb.width * 0.6, cb.y + cb.height * 0.6, { steps: 8 });
      await viewer.mouse.up();
      // 全フレーム読むので待つ。
      await viewer.waitForTimeout(20_000);
      s = (await timiState(viewer))!;
      check(!!s.roi, "[7] ROI を引ける", s.roi);
      check(s.intensityCurve.length >= 3, "[7] ★ROI を引くとカーブが作られる", {
        n: s.intensityCurve.length,
      });
      check(s.roiFrame != null, "[7] ROI を引いたフレームを出自に残している", { roiFrame: s.roiFrame });
    }

    // ── 8. 保存は未実装だが段には並べる ────────────────────────────
    check(
      stepState(s, "save")?.state === "invalid" &&
        stepState(s, "save")?.reasonKey === "timi.step.reason.srNotImplemented",
      "[8] 保存は未実装として理由つきで並べている（黙って隠さない）",
      stepState(s, "save"),
    );

    // ── 9. TIMI flow grade と取り違えさせない ──────────────────────
    check(
      await viewer.getByTestId("timi-not-flow-grade").isVisible().catch(() => false),
      "[9] ★「これは TIMI flow grade ではない」と画面に書いている",
    );

    fs.writeFileSync(path.join(OUT_DIR, "timi.json"), JSON.stringify(s, null, 2));
    await viewer.screenshot({ path: path.join(OUT_DIR, "dialog.png") }).catch(() => {});
  } finally {
    await driver.stop().catch(() => {});
  }

  console.log(`\n===== TIMI フレームカウント（A15）実機検証 =====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

/** ビューアの表示フレームを目的の番号に合わせる。 */
async function setFrame(viewer: Page, target: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const s = await timiState(viewer);
    if (!s) return;
    const diff = target - s.currentFrame;
    if (diff === 0) return;
    await wheelOutsideDialog(viewer, diff > 0 ? Math.min(diff, 5) : Math.max(diff, -5));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

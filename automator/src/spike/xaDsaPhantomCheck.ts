/*
 * GNBP-XA-2 による **DSA のピクセルシフト自動推定**の精度検証（A2）
 * — `fw/angio-design.md` §6.4 / §16.3。
 *
 * 準備:  cd bench && python3 make_phantom_xa.py --out ./phantom --series dsa
 * 実行:  cd automator && npx tsx src/spike/xaDsaPhantomCheck.ts
 *
 * `xaDsaCheck.ts`（実データ Rubo）との違いは**真値があること**。あちらは「差分が出ている」
 * 「シネが動く」までしか言えない。ここは**注入した体動を何 px で取り戻せたか**に答える。
 *
 * 🚨 このハーネスを書いて初めて分かったこと（設計 §6.4.1）:
 *   - 旧 GNBP-XA-2 の背景は斜めの帯だけで、**帯に沿った体動が原理的に回収できなかった**。
 *     ファントムを直すまで、この目標は**測れないまま「未測定」だった**。
 *   - 推定器は**端数のシフトへ引き込まれる**（双線形補間がノイズを平滑化するため）。
 *   - 探索半径 4px では GNBP-XA-2 の dy=5 に**届かない**。
 * ファントム側の性質（体動が回収できること）は `bench/check_xa2_motion.py` が別に測る。
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

const REPO_ROOT = path.resolve(AUTOMATOR_ROOT, "..");
const PHANTOM_DIR = path.join(REPO_ROOT, "bench", "phantom", "GNBP-XA");
const TRUTH_PATH = path.join(PHANTOM_DIR, "truth.json");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-dsa-phantom");
const HOST = "viewer2d-canvas-host";

/** 設計 §16.3 の目標: ピクセルシフト自動推定の誤差。 */
const TARGET_SHIFT_PX = 0.2;
/**
 * 体動を消した後の残差が、そもそも動いていないフレームの残差の何倍まで許されるか。
 * 1.0 なら「ノイズだけ」。ここを見ないと「シフトの数値は合っているのに絵は合っていない」
 * を見逃す（数値と絵が別経路なので実際に起こりうる）。
 */
const RESIDUAL_RATIO_MAX = 1.25;

const failures: string[] = [];
const unmet: string[] = [];
let passed = 0;

function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}
/** 設計目標に届いていない項目。**失敗にはしないが必ず出す**（黙って緩めない）。 */
function target(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`  [未達] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    unmet.push(label);
  }
}

interface DsaTruth {
  file: string;
  studyInstanceUid: string;
  maskFrames: number[];
  contrastArrivalFrame: number;
  shifts: { frame: number; dxPx: number; dyPx: number }[];
}

/** "マスク: フレーム 1, 2, 3, 4, 5" → [1,2,3,4,5]（表示は 1 origin）。 */
async function maskFrames(page: Page): Promise<number[]> {
  const text = (await page.getByTestId("dsa-mask").textContent()) ?? "";
  return [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/** "ピクセルシフト: 1.0, -2.0 px" → {dx, dy} */
async function shift(page: Page): Promise<{ dx: number; dy: number }> {
  const text = (await page.getByTestId("dsa-shift").textContent()) ?? "";
  const m = /(-?[\d.]+),\s*(-?[\d.]+)/.exec(text);
  if (!m) throw new Error(`dsa-shift を読めません: ${JSON.stringify(text)}`);
  return { dx: Number(m[1]), dy: Number(m[2]) };
}

/** "背景残差 12.3" → 12.3（未表示なら null） */
async function residual(page: Page): Promise<number | null> {
  const el = page.getByTestId("dsa-residual");
  if ((await el.count()) === 0) return null;
  const text = (await el.textContent()) ?? "";
  const m = /([\d.]+(?:e-?\d+)?)/i.exec(text);
  return m ? Number(m[1]) : null;
}

async function currentImageId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const dbg = (window as unknown as {
      __graphyDebug?: { getViewportGeometry?: () => { imageId: string | null }[] };
    }).__graphyDebug;
    const geo = dbg?.getViewportGeometry?.() ?? [];
    return geo.length ? geo[0].imageId : null;
  });
}

async function openStudy(page: Page, studyUid: string): Promise<void> {
  await dismissStartupDialogs(page);
  const blocker = await findBlockingOverlay(page, "search-submit-button");
  if (blocker) throw new Error(`検索ボタンが別の要素に塞がれています: ${blocker}`);
  page.once("dialog", (d) => void d.accept());
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

/** そのフレームへ送って、自動位置合わせを掛ける。戻り値は前後の残差と推定シフト。 */
async function alignAt(
  page: Page,
  frameNo: number,
): Promise<{ before: number | null; after: number | null; dx: number; dy: number }> {
  await page.getByTestId("cine-seek").fill(String(frameNo - 1)); // seek は 0 origin
  await page.waitForTimeout(1_200);
  const before = await residual(page);
  await page.getByTestId("dsa-auto-align").click();
  // 512² で数百通りを試すので数秒かかる。ボタンが再び押せるようになるまで待つ。
  await page.getByTestId("dsa-auto-align").waitFor({ state: "visible" });
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1_000);
    if (await page.getByTestId("dsa-auto-align").isEnabled()) break;
  }
  await page.waitForTimeout(1_200);
  const s = await shift(page);
  return { before, after: await residual(page), ...s };
}

async function main(): Promise<void> {
  if (!fs.existsSync(TRUTH_PATH)) {
    throw new Error(
      `ファントムがありません: ${PHANTOM_DIR}\n` +
        `先に "cd bench && python3 make_phantom_xa.py --out ./phantom" を実行してください。`,
    );
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const truth = (JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8")) as { dsa: DsaTruth }).dsa;
  const file = path.join(PHANTOM_DIR, truth.file);

  // 注入した体動の**種類**ごとに 1 フレーム。同じ値のフレームを 20 回測っても情報は増えない
  //（そのうえ 1 回の自動位置合わせに数秒かかる）。
  const kinds = new Map<string, { frame: number; dx: number; dy: number }>();
  for (const f of truth.shifts) {
    if (f.frame <= truth.maskFrames.length) continue;
    const key = `${f.dxPx},${f.dyPx}`;
    if (!kinds.has(key)) kinds.set(key, { frame: f.frame, dx: f.dxPx, dy: f.dyPx });
  }

  const driver = new DesktopDriver();
  await driver.start();
  const rows: Record<string, unknown>[] = [];
  try {
    const page = driver.page;
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [file]);
    if (imp.imported !== 1) throw new Error(`取込に失敗: ${JSON.stringify(imp)}`);

    await waitForMainScreenReady(page, 60_000);
    await openStudy(page, truth.studyInstanceUid);
    await page.locator('[data-testid^="series-row-"]').first().click();
    await page.getByTestId(HOST).waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(2_500);

    // ── DSA ON ──────────────────────────────────────────────────────
    await page.getByTestId("dsa-check").click();
    await page.getByTestId("dsa-mask").waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForTimeout(2_000);

    const dsaImageId = await currentImageId(page);
    check(
      !!dsaImageId && dsaImageId.startsWith("graphy-dsa:"),
      "[前提] 表示中の imageId が合成（graphy-dsa:）になっている",
      dsaImageId?.slice(0, 32),
    );
    check(
      await page.getByTestId("dsa-log-check").isChecked(),
      "[1] PixelIntensityRelationship=LIN なので対数変換が ON",
    );

    // ── マスクの自動選択 ────────────────────────────────────────────
    // 🚨 骨の濃い背景では**フレーム単独の暗部テールが造影に反応しない**。
    //    直す前はここが 4,5,6,7,8（＝造影入りの 3 枚がマスクに混ざる）だった。
    const masks = await maskFrames(page);
    check(
      masks.length === truth.maskFrames.length && masks.every((m, i) => m === truth.maskFrames[i]),
      "[2] マスクの自動選択が真値どおり",
      { measured: masks, truth: truth.maskFrames },
    );
    check(
      masks.every((m) => m < truth.contrastArrivalFrame),
      "[3] マスクに造影フレームが 1 枚も混ざっていない",
      { masks, arrival: truth.contrastArrivalFrame },
    );
    await page.getByTestId("series-controls").screenshot({ path: path.join(OUT_DIR, "0-dsa-on.png") }).catch(() => {});

    // ── 体動の自動推定 ──────────────────────────────────────────────
    // 体動 0 のフレームを先に測り、以降の「消えたか」の基準にする。
    const zero = [...kinds.values()].find((k) => k.dx === 0 && k.dy === 0);
    if (!zero) throw new Error("体動 0 のフレームが真値に見当たりません");
    const baseline = await alignAt(page, zero.frame);
    check(
      Math.hypot(baseline.dx, baseline.dy) <= TARGET_SHIFT_PX,
      `[4] 動いていないフレームでシフトを作らない（< ${TARGET_SHIFT_PX}px）`,
      { measured: [baseline.dx, baseline.dy], residual: baseline.after },
    );
    const floor = baseline.after ?? 0;
    rows.push({ frame: zero.frame, truth: [0, 0], measured: [baseline.dx, baseline.dy], ...baseline });

    for (const k of [...kinds.values()].filter((k) => k !== zero)) {
      const r = await alignAt(page, k.frame);
      const err = Math.hypot(r.dx - k.dx, r.dy - k.dy);
      const label = `frame ${k.frame} 真値 (${k.dx}, ${k.dy})`;
      rows.push({ frame: k.frame, truth: [k.dx, k.dy], measured: [r.dx, r.dy], err, ...r });
      target(err <= TARGET_SHIFT_PX, `[5] ${label} — 自動推定の誤差 < ${TARGET_SHIFT_PX}px`, {
        measured: [r.dx, r.dy],
        err: Number(err.toFixed(3)),
      });
      // 🚨 「合わせた後が良い」だけでは足りない。**合わせる前が本当にずれていたか**も見る。
      //    ずれていない状態から始めていたら、何を測ってもこの検査は通ってしまう。
      //    （実機で `dsa-residual` がフレームを送っても更新されず、前のフレームの数値が
      //     出たままだったのをここで掴んだ。数値で判断させる表示なので致命的だった。）
      check(
        r.before != null && floor > 0 && r.before >= floor * 1.5,
        `[6a] ${label} — 合わせる前は残差が明らかに大きい（本当にずれた状態から始めている）`,
        { before: r.before, floor, ratio: r.before != null && floor ? Number((r.before / floor).toFixed(2)) : null },
      );
      check(
        r.before != null && r.after != null && r.after <= r.before + 1e-9,
        `[6b] ${label} — 自動位置合わせで背景残差が下がる`,
        { before: r.before, after: r.after },
      );
      check(
        r.after != null && floor > 0 && r.after <= floor * RESIDUAL_RATIO_MAX,
        `[7] ${label} — 合わせた後の残差が「動いていないフレーム」並みに戻る`,
        { after: r.after, floor, ratio: r.after != null && floor ? Number((r.after / floor).toFixed(3)) : null },
      );
    }
    await page.getByTestId("series-controls").screenshot({ path: path.join(OUT_DIR, "1-after-align.png") }).catch(() => {});
    await page.screenshot({ path: path.join(OUT_DIR, "2-full.png") }).catch(() => {});
  } finally {
    await driver.stop();
  }

  fs.writeFileSync(path.join(OUT_DIR, "shifts.json"), JSON.stringify(rows, null, 2), "utf8");
  console.log(`\n===== GNBP-XA-2（A2）体動の自動推定 =====`);
  console.log(`合格 ${passed} / 退行 ${failures.length} / 設計目標に未達 ${unmet.length}`);
  if (failures.length) {
    console.log("★退行（現状より悪化。直すこと）:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
  if (unmet.length) {
    console.log("設計目標に未達:");
    for (const f of unmet) console.log(`  - ${f}`);
  }
  console.log(`結果: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

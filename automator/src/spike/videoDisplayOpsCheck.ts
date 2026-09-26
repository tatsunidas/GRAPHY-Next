/*
 * 動画ビューアの表示の基本機能（段 A2）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/videoDisplayOpsCheck.ts
 *
 * 確かめること（**要素の有無ではなく、画面に出ている絵**で見る）:
 *   1. 2D ビューアの**画面のツールバー**の回転・左右反転・上下反転・Fit・リセットが、動画タイルに届く
 *      （以前は動画タイルが未登録で、押しても黙って捨てられていた）
 *   2. 回転・反転の**向き**が正しい（4 象限を別の色に塗った非対称なフィクスチャで、象限の色の入れ替わりを読む）
 *   3. タイルの操作バーのズーム・パン・Fit が効く
 *   4. W/L プリセット・左ドラッグの W/L・階調反転が効く（CSS の filter なので canvas の画素ではなく**スクリーンショット**で読む）
 *   5. 回転しても、描いた ROI が動画上の同じ場所に付いてくる（描画と注釈の座標変換がそろっている）
 *   6. 動画タイルの 🔗（同期）は押せない
 *   7. （段 A3）ROI は 2D ビューアの ROI 機能が管理する: 画面の ROI メニューで選んだツールで動画に描け、
 *      ROI マネージャにフレームつき（🎞 F1）で並び、マネージャの表示切替・削除が動画の絵に効く。
 *      描いた ROI はそのフレームにだけ出る（フレームは T 軸。全フレーム共通は段 C）。
 *      動画独自のツールの列・ROI 一覧・解析のボタンは無くなっている
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）。
 * フィクスチャは無ければ ffmpeg で自動生成する（`fixtures/video-mp4-avi/display-ops/`）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importNonDicomPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "video-display-ops");
const FIXTURE_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "video-mp4-avi", "display-ops");
const HOST = "video-viewport-host";

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

/** 左上=赤・右上=緑・左下=青・右下=灰(128) の 320×240 の動画（2 秒）。 */
function ensureFixtureVideo(): string {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const out = path.join(FIXTURE_DIR, "quadrants.mp4");
  if (fs.existsSync(out)) return out;
  console.log(`フィクスチャ動画を ffmpeg で合成します: ${out}`);
  const q = (c: string) => ["-f", "lavfi", "-i", `color=c=${c}:s=160x120:r=15:d=2`];
  execFileSync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      ...q("0xFF0000"), ...q("0x00FF00"), ...q("0x0000FF"), ...q("0x808080"),
      "-filter_complex", "[0][1]hstack[t];[2][3]hstack[b];[t][b]vstack,format=yuv420p",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      out,
    ],
    { stdio: "inherit" },
  );
  return out;
}

type Rgb = [number, number, number];
type Quad = "TL" | "TR" | "BL" | "BR";
const QUADS: Record<Quad, [number, number]> = { TL: [-1, -1], TR: [1, -1], BL: [-1, 1], BR: [1, 1] };

function colorName([r, g, b]: Rgb): string {
  if (r > 150 && g < 110 && b < 110) return "red";
  if (g > 150 && r < 110 && b < 110) return "green";
  if (b > 150 && r < 110 && g < 110) return "blue";
  if (r < 110 && g > 150 && b > 150) return "cyan";
  if (Math.abs(r - g) < 25 && Math.abs(g - b) < 25) return r < 20 ? "black" : `gray${Math.round((r + g + b) / 3)}`;
  return `?(${r},${g},${b})`;
}

/**
 * canvas の画素（回転・反転・ズーム・パンが入る。W/L・階調反転は CSS の filter なので入らない）。
 * 点は canvas の中心から (fx·k, fy·k)。k = 短辺の 15%（回転して縦横が入れ替わっても動画の内側に収まる大きさ）。
 */
async function canvasAt(page: Page, pts: [number, number][]): Promise<Rgb[]> {
  return (await page.evaluate(
    ({ pts }) => {
      const c = document.querySelector('[data-testid="video-viewport-host"] canvas') as HTMLCanvasElement;
      const ctx = c.getContext("2d")!;
      const k = 0.15 * Math.min(c.width, c.height);
      return pts.map(([fx, fy]) => {
        const x = Math.round(c.width / 2 + fx * k);
        const y = Math.round(c.height / 2 + fy * k);
        const d = ctx.getImageData(Math.min(c.width - 1, Math.max(0, x)), Math.min(c.height - 1, Math.max(0, y)), 1, 1).data;
        return [d[0], d[1], d[2]];
      });
    },
    { pts },
  )) as Rgb[];
}

/** 画面に出ている色（CSS の filter を含む）。canvas のスクリーンショットをページ内で読み直す。 */
async function screenAt(page: Page, pts: [number, number][]): Promise<Rgb[]> {
  const canvas = page.locator(`[data-testid="${HOST}"] canvas`).first();
  const png = (await canvas.screenshot()).toString("base64");
  return (await page.evaluate(
    async ({ png, pts }) => {
      const c = document.querySelector('[data-testid="video-viewport-host"] canvas') as HTMLCanvasElement;
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const off = document.createElement("canvas");
      off.width = img.width;
      off.height = img.height;
      const ctx = off.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const sx = img.width / c.clientWidth;
      const sy = img.height / c.clientHeight;
      const k = 0.15 * Math.min(c.clientWidth, c.clientHeight);
      return pts.map(([fx, fy]) => {
        const x = Math.round((c.clientWidth / 2 + fx * k) * sx);
        const y = Math.round((c.clientHeight / 2 + fy * k) * sy);
        const d = ctx.getImageData(x, y, 1, 1).data;
        return [d[0], d[1], d[2]];
      });
    },
    { png, pts },
  )) as Rgb[];
}

async function quadColors(page: Page): Promise<Record<Quad, string>> {
  const names = Object.keys(QUADS) as Quad[];
  const rgb = await canvasAt(page, names.map((q) => QUADS[q]));
  return Object.fromEntries(names.map((q, i) => [q, colorName(rgb[i])])) as Record<Quad, string>;
}

const IDENTITY_COLORS = { TL: "red", TR: "green", BL: "blue", BR: "gray128" };
const sameQuads = (got: Record<Quad, string>, want: Record<string, string>) =>
  (Object.keys(want) as Quad[]).every((q) => {
    const w = want[q];
    // 灰は符号化で ±数階調ずれる
    return w.startsWith("gray") ? /^gray1[23]\d$/.test(got[q]) : got[q] === w;
  });

/** canvas の端（上辺の中央・左辺の中央）が動画で埋まっているか（黒/透明でないか）。 */
async function edgesFilled(page: Page): Promise<{ left: boolean; top: boolean }> {
  return (await page.evaluate(() => {
    const c = document.querySelector('[data-testid="video-viewport-host"] canvas') as HTMLCanvasElement;
    const ctx = c.getContext("2d")!;
    const k = Math.round(0.15 * Math.min(c.width, c.height));
    // 象限の境目を避けて、赤の象限の側を見る（🔴 evaluate 内で名前付きの関数を作らない: tsx が __name を差し込み落ちる）
    const [l, t] = [
      [3, Math.round(c.height / 2) - k],
      [Math.round(c.width / 2) - k, 3],
    ].map(([x, y]) => ctx.getImageData(x, y, 1, 1).data);
    return { left: l[3] > 0 && l[0] + l[1] + l[2] > 60, top: t[3] > 0 && t[0] + t[1] + t[2] > 60 };
  })) as { left: boolean; top: boolean };
}

async function click(page: Page, testId: string, wait = 350): Promise<void> {
  await page.getByTestId(testId).first().click();
  await page.waitForTimeout(wait);
}

/**
 * 画面の ROI メニュー（2D ビューアのメニュー）からツールを選ぶ。項目名は ✓ が付くことがあるので前方を許す。
 * メニューが開き切る前に押すと取りこぼすので、見つかるまで数回開き直す（`angioHostApiCheck` と同じ）。
 */
async function pickRoiTool(page: Page, name: RegExp): Promise<void> {
  const item = page.getByRole("button", { name });
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.getByTestId("viewer2d-menu-roi").click();
    try {
      await item.first().waitFor({ state: "visible", timeout: 2000 });
      await item.first().click();
      await page.waitForTimeout(300);
      return;
    } catch {
      /* 開き直す */
    }
  }
  throw new Error(`ROI メニューの ${name} を選べませんでした`);
}

async function openRoiManager(page: Page): Promise<void> {
  if (await page.getByTestId("roi-mgr-save").isVisible().catch(() => false)) return;
  await page.getByTestId("viewer2d-menu-roiTools").click();
  await page.getByRole("button", { name: /ROI マネージャ|ROI manager/ }).first().click();
  await page.getByTestId("roi-mgr-save").waitFor({ state: "visible", timeout: 10_000 });
}

/** 動画の上に描かれている注釈の図形（SVG）の数。 */
async function drawnShapes(page: Page): Promise<number> {
  return page.evaluate(() => {
    const host = document.querySelector('[data-testid="video-viewport-host"]') as HTMLElement;
    return Array.from(host.querySelectorAll("svg path, svg rect, svg polyline, svg line, svg ellipse")).filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 2 || r.height > 2;
    }).length;
  });
}

/** 動画の注釈（SVG）の外接矩形の中心を、canvas の中心からの相対（CSS px）で返す。無ければ null。 */
async function annotationCenter(page: Page): Promise<[number, number] | null> {
  return (await page.evaluate(() => {
    const host = document.querySelector('[data-testid="video-viewport-host"]') as HTMLElement;
    const c = host.querySelector("canvas") as HTMLCanvasElement;
    const cr = c.getBoundingClientRect();
    const shapes = Array.from(host.querySelectorAll("svg path, svg rect, svg polyline, svg line")).filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && r.width < cr.width * 0.9;
    });
    if (shapes.length === 0) return null;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const e of shapes) {
      const bb = e.getBoundingClientRect();
      l = Math.min(l, bb.left); t = Math.min(t, bb.top); r = Math.max(r, bb.right); b = Math.max(b, bb.bottom);
    }
    return [(l + r) / 2 - (cr.left + cr.width / 2), (t + b) / 2 - (cr.top + cr.height / 2)];
  })) as [number, number] | null;
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const video = ensureFixtureVideo();
  console.log(`フィクスチャ: ${video}`);

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    const imp = await importNonDicomPaths(driver.ports.http, [video], {
      patientId: "VIDEO-OPS",
      patientName: "VIDEO^DISPLAYOPS",
      seriesDescription: "display ops",
    });
    check((imp as { imported?: number }).imported === 1, "[準備] 4 象限の動画を取り込めた", imp);

    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    const dates = mainPage.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await mainPage.getByTestId("search-submit-button").click();
    const row = mainPage.locator('[data-testid^="study-row-"]').first();
    await row.waitFor({ state: "visible", timeout: 20_000 });
    await row.click();
    const seriesRow = mainPage.locator('[data-testid^="series-row-"]').first();
    await seriesRow.waitFor({ state: "visible", timeout: 30_000 });
    await seriesRow.click();
    const page = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    page.on("dialog", (d) => void d.accept().catch(() => {}));
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e?.stack ?? e)));
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") console.log(`    [console.${m.type()}] ${m.text().slice(0, 300)}`);
    });
    await page.getByTestId("video-display-bar").waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(1_500);
    check(true, "[1] 2D ビューアで動画タイルが開き、表示の操作バーが出る");

    // ── 6. 🔗 は押せない
    check(await page.getByTestId("tile-sync-toggle").first().isDisabled(), "[2] 動画タイルの 🔗（同期）は押せない");

    // ── 2. 向き（画面のツールバーから）
    const q0 = await quadColors(page);
    check(sameQuads(q0, IDENTITY_COLORS), "[3] 初期表示の象限の色（左上=赤・右上=緑・左下=青・右下=灰）", q0);
    await page.screenshot({ path: path.join(OUT_DIR, "0-initial.png") }).catch(() => {});

    await click(page, "toolbar-rotate");
    const q90 = await quadColors(page);
    check(
      sameQuads(q90, { TL: "blue", TR: "red", BL: "gray128", BR: "green" }),
      "[4] ★画面のツールバーの回転で、時計回りに 90° 回る（左上=青・右上=赤）",
      q90,
    );
    await page.screenshot({ path: path.join(OUT_DIR, "1-rotated.png") }).catch(() => {});
    // 回転後も縦長になった動画の全体が収まっている（上辺・下辺に余白が無い＝高さいっぱい、左右は余白）
    const e90 = await edgesFilled(page);
    check(!e90.left, "[5] 回転後は縦横が入れ替わって収め直される（左右に余白）", e90);

    for (let i = 0; i < 3; i++) await click(page, "toolbar-rotate", 200);
    check(sameQuads(await quadColors(page), IDENTITY_COLORS), "[6] 4 回まわすと元に戻る");

    await click(page, "toolbar-flip-h");
    const qh = await quadColors(page);
    check(sameQuads(qh, { TL: "green", TR: "red", BL: "gray128", BR: "blue" }), "[7] ★左右反転（左上=緑・右上=赤）", qh);
    await click(page, "toolbar-flip-h");
    await click(page, "toolbar-flip-v");
    const qv = await quadColors(page);
    check(sameQuads(qv, { TL: "blue", TR: "gray128", BL: "red", BR: "green" }), "[8] ★上下反転（左上=青・左下=赤）", qv);
    await click(page, "toolbar-reset");
    check(sameQuads(await quadColors(page), IDENTITY_COLORS), "[9] 画面のツールバーのリセットで元の向きに戻る");

    // ── 3. ズーム・Fit・パン（タイルの操作バー）
    const e0 = await edgesFilled(page);
    for (let i = 0; i < 3; i++) await click(page, "video-zoom-in", 200);
    const ez = await edgesFilled(page);
    check(!(e0.left && e0.top) && ez.left && ez.top, "[10] ★拡大すると動画が canvas の上下左右いっぱいにはみ出す", { before: e0, after: ez });
    await page.screenshot({ path: path.join(OUT_DIR, "2-zoomed.png") }).catch(() => {});
    await click(page, "toolbar-fit");
    const ef = await edgesFilled(page);
    check(ef.left === e0.left && ef.top === e0.top, "[11] 画面のツールバーの Fit で全体表示に戻る", ef);

    await click(page, "video-pan");
    const k = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="video-viewport-host"] canvas') as HTMLCanvasElement;
      return 0.15 * Math.min(c.clientWidth, c.clientHeight);
    });
    check(
      (await page.getByTestId("video-pan").getAttribute("aria-pressed")) === "true",
      "[12a] パンのボタン（アイコン付き）が 1 回目のクリックで押される",
    );
    await dragOnCanvasHost(page, HOST, -2 * k, 0, 0, 12);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT_DIR, "2b-panned.png") }).catch(() => {});
    const [afterPan] = await canvasAt(page, [QUADS.TL]);
    check(colorName(afterPan) === "green", "[12] ★パン: 左へ 2k ドラッグすると、左上の点に右上（緑）の象限が来る", colorName(afterPan));
    await click(page, "video-pan"); // W/L に戻す
    check((await page.getByTestId("video-pan").getAttribute("aria-pressed")) === "false", "[12b] もう一度押すとパンが外れる");
    await click(page, "toolbar-fit");

    // ── 4. W/L・階調反転（画面の色＝スクリーンショット）
    const [gray0] = await screenAt(page, [QUADS.BR]);
    const preset = await page.getByTestId("toolbar-wl-preset").evaluate((el: HTMLSelectElement) => {
      const o = Array.from(el.options).find((x) => x.value && !x.value.startsWith("__"));
      return o ? o.value : null;
    });
    if (preset) {
      await page.getByTestId("toolbar-wl-preset").selectOption(preset);
      await page.waitForTimeout(400);
      const [grayP] = await screenAt(page, [QUADS.BR]);
      const [grayRaw] = await canvasAt(page, [QUADS.BR]);
      check(
        Math.abs(grayP[0] - gray0[0]) > 15 && Math.abs(grayRaw[0] - gray0[0]) < 6,
        `[13] ★画面のツールバーの W/L プリセット（${preset}）で灰の明るさが変わる（canvas の画素は元のまま＝表示だけ）`,
        { before: gray0, after: grayP, raw: grayRaw },
      );
      await page.getByTestId("toolbar-wl-preset").selectOption("__default__");
      await page.waitForTimeout(400);
      const [grayD] = await screenAt(page, [QUADS.BR]);
      check(Math.abs(grayD[0] - gray0[0]) < 6, "[14] 「既定」で元の明るさに戻る", { before: gray0, after: grayD });
    } else {
      check(false, "[13] W/L プリセットが 1 つも無い");
    }

    await dragOnCanvasHost(page, HOST, 0, -80, 0, 12, { fracX: 0.5, fracY: 0.7 });
    await page.waitForTimeout(400);
    const [grayW] = await screenAt(page, [QUADS.BR]);
    check(Math.abs(grayW[0] - gray0[0]) > 10, "[15] 左ドラッグの W/L でも明るさが変わる", { before: gray0, after: grayW });
    await page.getByTestId("toolbar-wl-preset").selectOption("__default__");
    await page.waitForTimeout(300);

    await click(page, "toolbar-invert");
    const [inv] = await screenAt(page, [QUADS.TL]);
    check(colorName(inv) === "cyan", "[16] ★画面のツールバーの階調反転で、赤がシアンになる", inv);
    await page.screenshot({ path: path.join(OUT_DIR, "3-inverted.png") }).catch(() => {});
    await click(page, "toolbar-invert");
    const [back] = await screenAt(page, [QUADS.TL]);
    check(colorName(back) === "red", "[17] もう一度押すと戻る", back);

    // ── 5. 回転しても ROI が動画上の同じ場所に付いてくる
    // 🔑 段 A3: 動画独自のツールの列は無い。**画面の ROI メニュー**から選ぶ
    check(
      (await page.locator('[data-testid^="video-tool-"], [data-testid="video-analyze-run"], [data-testid="video-roi-list"]').count()) === 0,
      "[18a] 動画独自のツールの列・ROI 一覧・解析のボタンは無い（ROI は 2D ビューアの ROI 機能に一本化）",
    );
    await pickRoiTool(page, /^(✓\s*)?(矩形 ROI|Rectangle ROI)$/);
    await dragOnCanvasHost(page, HOST, k, k, 0, 12, {
      fracX: 0.5 - (1.6 * k) / (await page.getByTestId(HOST).evaluate((e) => (e as HTMLElement).clientWidth)),
      fracY: 0.5 - (1.6 * k) / (await page.getByTestId(HOST).evaluate((e) => (e as HTMLElement).clientHeight)),
    });
    await page.waitForTimeout(500);
    const a0 = await annotationCenter(page);
    check(a0 !== null && a0[0] < 0 && a0[1] < 0, "[18] 左上（赤）の象限に ROI を描けた", a0);
    await click(page, "toolbar-rotate", 500);
    const a90 = await annotationCenter(page);
    check(a90 !== null && a90[0] > 0 && a90[1] < 0, "[19] ★回転すると ROI も右上へ移る（赤の象限に付いたまま）", a90);
    if (a90) {
      const [under] = await canvasAt(page, [[a90[0] / k, a90[1] / k]]);
      check(colorName(under) === "red", "[20] 回転後の ROI の中心の下の絵は赤のまま", colorName(under));
    }
    await page.screenshot({ path: path.join(OUT_DIR, "4-roi-rotated.png") }).catch(() => {});
    await click(page, "toolbar-reset");

    // ── フレーム送りが壊れていない（A1 の回帰）
    await click(page, "video-frame-next", 400);
    const shown = ((await page.getByTestId("video-frame-number").textContent()) ?? "").trim();
    check(/\b2 \/ 30\b/.test(shown), "[21] フレーム送りは今まで通り（▶ で 2 / 30）", shown);

    // ── 7. ROI は 2D ビューアの ROI マネージャが管理する（段 A3）
    check((await drawnShapes(page)) === 0, "[22] ★フレーム 1 に描いた ROI は、フレーム 2 では出ない（フレームに付く）");
    await click(page, "video-frame-prev", 400);
    check((await drawnShapes(page)) > 0, "[23] フレーム 1 に戻ると ROI が出る");

    await openRoiManager(page);
    const rows = page.locator('[data-testid="roi-mgr-row"]');
    check((await rows.count()) === 1, "[24] ★動画に描いた ROI が ROI マネージャに並ぶ", await rows.count());
    const row0 = rows.first();
    const rowText = ((await row0.textContent()) ?? "").trim();
    check(
      ((await row0.getByTestId("roi-mgr-video-chip").textContent()) ?? "").includes("F1"),
      "[25] ★行にフレーム（🎞 F1）が出る（scope は T 軸: t=0）",
      rowText,
    );
    check(
      (await row0.getByRole("button", { name: "Σ" }).count()) === 0 && (await row0.getByTestId("roi-mgr-duplicate").count()) === 0,
      "[26] 動画の ROI の行には、まだ対応していない統計（Σ）・複製（⧉）を出さない",
    );
    await page.screenshot({ path: path.join(OUT_DIR, "5-roi-manager.png") }).catch(() => {});

    await row0.getByRole("button", { name: "👁" }).click();
    await page.waitForTimeout(400);
    check((await drawnShapes(page)) === 0, "[27] ★ROI マネージャで非表示にすると、動画の上から消える");
    await row0.getByRole("button", { name: "🚫" }).click();
    await page.waitForTimeout(400);
    check((await drawnShapes(page)) > 0, "[28] もう一度押すと出る");

    // 画像タイルと同じ計測ツール（双方向）も動画に描ける。
    // ⚠ 最初の ROI の統計の文字枠（緑・右下の灰の象限）の上から始めると、描かずに文字枠を動かしてしまう。
    //   何も無い青の象限で描く
    await pickRoiTool(page, /^(✓\s*)?(長径・短径|Long\/short axis)/);
    await dragOnCanvasHost(page, HOST, 60, 20, 0, 12, { fracX: 0.12, fracY: 0.55 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT_DIR, "6-bidirectional.png") }).catch(() => {});
    check((await rows.count()) === 2, "[29] 双方向計測のツールでも描け、ROI マネージャに並ぶ", await rows.count());

    // 輪郭系（閉じたフリーハンド）も描ける。閉じた輪郭は面積が要るので、円を描くようにドラッグする（緑の象限）
    await pickRoiTool(page, /^(✓\s*)?(フリーハンド ROI（閉）|Freehand ROI \(closed\))$/);
    {
      const box = (await page.getByTestId(HOST).boundingBox())!;
      const cx = box.x + box.width * 0.75;
      const cy = box.y + box.height * 0.36;
      const r = Math.min(box.width, box.height) * 0.08;
      await page.mouse.move(cx + r, cy);
      await page.mouse.down();
      for (let i = 1; i <= 36; i++) {
        const th = (i / 36) * 2 * Math.PI;
        await page.mouse.move(cx + r * Math.cos(th), cy + r * Math.sin(th));
        await page.waitForTimeout(15);
      }
      await page.mouse.up();
    }
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT_DIR, "7-freehand.png") }).catch(() => {});
    check((await rows.count()) === 3, "[29b] 輪郭系（フリーハンド）のツールでも描け、ROI マネージャに並ぶ", await rows.count());

    for (let i = (await rows.count()) - 1; i >= 0; i--) {
      await rows.nth(i).getByRole("button", { name: "🗑" }).click();
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(300);
    check((await rows.count()) === 0 && (await drawnShapes(page)) === 0, "[30] ★ROI マネージャで削除すると、動画の上からも消える", {
      rows: await rows.count(),
      shapes: await drawnShapes(page),
    });
    check(pageErrors.length === 0, "[31] 画面の例外（pageerror）が 0 件", pageErrors.slice(0, 3));
  } finally {
    await driver.stop();
  }

  console.log("\n=== 結果 ===");
  if (failures.length === 0) {
    console.log(`${passed} 項目すべて OK。スクリーンショット: ${OUT_DIR}`);
  } else {
    console.log(`${passed} 項目 OK / FAIL ${failures.length} 件:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();

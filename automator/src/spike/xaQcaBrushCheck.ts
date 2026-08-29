/*
 * QCA の**「ならす」ブラシ**（§8.8.1）／**エッジ・マスクの表示切り替え**（§8.8.3）／
 * **解析中のフレーム固定**（§8.8.2）／**ストレート像**（§8.9）の実機検証 — `fw/angio-design.md`。
 * 併せて **XA を開いた瞬間にエラーが出ないこと**（§5.10）も見る。
 *
 * 実行:  cd automator && npx tsx src/spike/xaQcaBrushCheck.ts
 *
 * 🚨 3 つとも「利用者が実機で言ってきたこと」への対処なので、**画面で効いているか**を
 *    見ないと意味がない。単体テスト（`qcaBrush.test.ts` / `sliceNavigationLock.test.ts`）は
 *    純関数と錠のカウントを見ているだけで、**ダイアログから実際に呼ばれているか**は
 *    一切見ていない（呼び忘れても緑になる）。
 *
 * 🚨 この検証で一番危ないのは「操作したつもりで何も起きていない」パターン。canvas 上の
 *    ドラッグは掴めていなくてもエラーにならず、結果も変わらないので「変わらない＝正常」と
 *    読めてしまう。よって **まず操作が効いたことを数値で確かめ**、そのうえで期待する変化を見る。
 *    「ならす」の検証では、まず**外れ点の塊を自分で作れたこと**を確かめてから、それが
 *    直ることを見る（塊が作れていなければ、何もせずとも「直った」ように見える）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-qca-brush");
const XA_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "xa-angio");
const SAMPLE = "0002.DCM";
const HOST = "viewer2d-canvas-host";
/** 解析するフレーム（0002.DCM は 96 フレーム。造影が濃い辺り）。 */
const FRAME = 55;

const failures: string[] = [];
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

interface QcaState {
  imageId: string;
  centerline: [number, number][];
  edges: { left: [number, number]; right: [number, number] }[];
  pathIndices: number[];
  centerlineToken: string;
  provenance: { waypoints: number; editedEdges: number[]; trimmed: boolean; reference: string; edited: boolean };
  mld: number;
  rvd: number;
  points: number;
  unit: string;
  view: { cx0: number; cy0: number; cw: number; ch: number; scale: number; dw: number; dh: number } | null;
  straight: {
    cols: number;
    rows: number;
    halfWidthPx: number;
    lengthPx: number;
    scale: number;
    dw: number;
    dh: number;
  } | null;
}

async function qcaState(page: Page): Promise<QcaState | null> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { __graphyDebug?: { getQcaState?: () => unknown } }).__graphyDebug;
    return (dbg?.getQcaState?.() ?? null) as unknown;
  }) as Promise<QcaState | null>;
}

/** 表示中ビューポートの imageId（`&frame=N` まで入っている）。 */
async function viewportImageId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const dbg = (window as unknown as {
      __graphyDebug?: { getViewportGeometry?: () => { imageId: string | null }[] };
    }).__graphyDebug;
    const all = dbg?.getViewportGeometry?.() ?? [];
    return all.length ? all[0].imageId : null;
  });
}

/** シネの「n / total」表示。**画面が示しているフレーム**をここから読む。 */
async function frameIndex(page: Page): Promise<number> {
  const text = (await page.getByTestId("cine-indicator").textContent()) ?? "";
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text);
  if (!m) throw new Error(`cine-indicator を読めません: ${JSON.stringify(text)}`);
  return Number(m[1]);
}

async function wheelOnViewer(page: Page, notches: number): Promise<void> {
  const box = await page.getByTestId(HOST).boundingBox();
  if (!box) throw new Error("ビューポートの位置を取得できません");
  for (let i = 0; i < Math.abs(notches); i++) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, notches > 0 ? 120 : -120);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(600);
}

/** 画像 px → 拡大パネル上のクライアント座標。 */
async function panelPoint(page: Page, st: QcaState, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("qca-editor-canvas").boundingBox();
  if (!box || !st.view) throw new Error("拡大パネルが見つかりません");
  return {
    x: box.x + ((x - st.view.cx0) / st.view.cw) * box.width,
    y: box.y + ((y - st.view.cy0) / st.view.ch) * box.height,
  };
}

/**
 * 拡大パネルの canvas を**画素で**読む。
 *
 * <p>🔴 表示の On/Off は DOM に出ないので、**描かれているかどうかは画素でしか確かめられない**。
 * 「トグルの `aria-pressed` が変わった」を見ても、描画が変わった証拠にはならない。
 *
 * <p>背景は白黒（XA・MONOCHROME2）なので R≒G≒B。重ね描きのうち**青系だけ**を数える:
 * - エッジ線 `#4fc3f7` … B−R = 168（濃い）
 * - 内腔マスク `rgba(79,195,247,0.28)` … 白黒 g の上で B−R ≒ 47（薄いが面で広い）
 * - 中心線 `#7fd1b9` は B < G なので**数えない**（消えない線なので混ざると判定が鈍る）
 * - MLD の線 `#e07a5f` は R > B なので数えない
 */
async function panelInk(page: Page): Promise<{ line: number; area: number; total: number }> {
  const v = await page.evaluate(`(function () {
    var c = document.querySelector('[data-testid="qca-editor-canvas"]');
    if (!c) return null;
    var ctx = c.getContext("2d");
    if (!ctx) return null;
    var d = ctx.getImageData(0, 0, c.width, c.height).data;
    var line = 0, area = 0;
    for (var i = 0; i < d.length; i += 4) {
      var r = d[i], g = d[i + 1], b = d[i + 2];
      if (b > g + 5 && b - r > 30) { area++; if (b - r > 140) line++; }
    }
    return { line: line, area: area, total: d.length / 4 };
  })()`);
  if (!v) throw new Error("拡大パネルの canvas を読めません");
  return v as { line: number; area: number; total: number };
}

/**
 * ストレート像の canvas の寸法と、描かれている中身の**署名**。
 *
 * <p>🔴 署名を見るのは「本画面で直したら帯も変わる」を**画素で**確かめるため。
 * 「両方に同じ `result` を渡している」ことはコードを読めば分かるが、**描き直しているか**は
 * 画面からしか分からない（ref に貯めた古い絵が残るのは実際にある壊れ方）。
 */
async function stripState(page: Page): Promise<{ w: number; h: number; sig: number; ink: number } | null> {
  const v = await page.evaluate(`(function () {
    var c = document.querySelector('[data-testid="qca-straight-canvas"]');
    if (!c) return null;
    var ctx = c.getContext("2d");
    if (!ctx) return null;
    var d = ctx.getImageData(0, 0, c.width, c.height).data;
    var sig = 0, ink = 0;
    for (var i = 0; i < d.length; i += 4) {
      var r = d[i], g = d[i + 1], b = d[i + 2];
      if (b > g + 5 && b - r > 30) ink++;
      sig = (sig * 31 + r + g * 3 + b * 7) | 0;
    }
    return { w: c.width, h: c.height, sig: sig, ink: ink };
  })()`);
  return v as { w: number; h: number; sig: number; ink: number } | null;
}

/** 帯の上のクライアント座標（col は 0..1 の相対位置、offset は画像 px）。 */
async function stripPoint(
  page: Page,
  colFrac: number,
  offsetPx: number,
  halfWidthPx: number,
): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("qca-straight-canvas").boundingBox();
  if (!box) throw new Error("ストレート像が見つかりません");
  const rows = halfWidthPx * 2 + 1;
  return {
    x: box.x + box.width * colFrac,
    y: box.y + ((offsetPx + halfWidthPx) / rows) * box.height,
  };
}

/**
 * 中心線の**弧長**で `frac` の位置にある計測点の添字。
 *
 * <p>🔴 添字の割合で代用しない。帯の横は弧長なので、点の間隔が一定でない区間では
 * 「帯の 35% の位置」と「計測点の 35% 番目」は**別の場所**になる。
 */
function indexAtArcFraction(points: readonly [number, number][], frac: number): number {
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  const target = frac * cum[cum.length - 1];
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < cum.length; i++) {
    const d = Math.abs(cum[i] - target);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** 中心線の全長 [画像 px]（帯の列数の期待値）。 */
function polylineLengthPx(points: readonly [number, number][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

/** 中心線からエッジまでの距離（＝オフセット）。手修正で押し出した量をこれで測る。 */
function offsets(st: QcaState, side: "left" | "right"): number[] {
  return st.edges.map((e, i) => {
    const c = st.centerline[i];
    return Math.hypot(e[side][0] - c[0], e[side][1] - c[1]);
  });
}

/** 窓のなかの中央値（外れの塊を含めない基準線を作るため、対象の添字は除く）。 */
function baselineAround(values: number[], center: number, half: number, exclude: Set<number>): number {
  const pool: number[] = [];
  for (let i = Math.max(0, center - half); i <= Math.min(values.length - 1, center + half); i++) {
    if (!exclude.has(i)) pool.push(values[i]);
  }
  pool.sort((a, b) => a - b);
  if (!pool.length) return NaN;
  return pool[Math.floor(pool.length / 2)];
}

async function firstStudyUid(httpPort: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/studies`);
  const studies = (await res.json()) as { studyInstanceUid: string }[];
  if (!studies.length) throw new Error("スタディがありません");
  return studies[0].studyInstanceUid;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sample = path.join(XA_DIR, SAMPLE);
  if (!fs.existsSync(sample)) {
    throw new Error(`XA サンプルがありません: ${sample}\n  bash automator/scripts/fetch-xa-samples.sh で取得してください。`);
  }

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [sample]);
    if (imp.imported !== 1) throw new Error(`取込に失敗: ${JSON.stringify(imp)}`);
    await firstStudyUid(driver.ports.http);

    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    mainPage.once("dialog", (d) => void d.accept());
    const dateInputs = mainPage.locator('input[type="date"]');
    await dateInputs.nth(0).fill("");
    await dateInputs.nth(1).fill("");
    await mainPage.getByTestId("search-submit-button").click();
    await mainPage.locator('[data-testid^="study-row-"]').first().click();
    await mainPage.locator('[data-testid^="series-row-"]').first().click();

    // 🚨 **「開いた瞬間だけ出るエラー」は、出た後に探しても捕まらない。**
    //    ページが出来てから `evaluate` で見張りを付けたのでは**間に合わない**
    //    （実際に間に合わず、"出なかった" ではなく "見ていない" 状態で合格しかけた）。
    //    `addInitScript` はページの最初のスクリプトより前に走るので、確実に先回りできる。
    //    間に合ったことは `readyState === "loading"` で残し、**それも合格条件にする**。
    await driver.app.context().addInitScript(`(function () {
      var w = window;
      w.__xaErrWatch = { seen: 0, readyAtInstall: document.readyState };
      var scan = function () {
        if (document.querySelector('[data-testid="viewer2d-error"]')) w.__xaErrWatch.seen++;
      };
      var start = function () {
        if (!document.documentElement) return false;
        new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
        scan();
        return true;
      };
      if (!start()) document.addEventListener("readystatechange", start);
    })()`);

    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);

    // ── §5.10 開いた瞬間のエラー ──────────────────────────────────
    const watch = JSON.parse((await viewer.evaluate(`(function () {
      return JSON.stringify(window.__xaErrWatch || null);
    })()`)) as string) as { seen: number; readyAtInstall: string } | null;
    check(
      watch?.readyAtInstall === "loading",
      "[E1] ★ページが描画を始める前に見張りを付けられた（間に合っていなければ「見ていない」）",
      watch,
    );
    const errSeen = watch ? watch.seen : -1;
    check(
      errSeen === 0,
      "[E2] ★XA を開く間に「取得に失敗しました」が一度も出ない（空のフレーム列は失敗ではない）",
      { seen: errSeen },
    );
    check(
      (await viewer.getByTestId("viewer2d-error").count()) === 0,
      "[E3] 表示後もエラーは出ていない",
    );

    await viewer.getByTestId("cine-seek").fill(String(FRAME));
    await viewer.waitForTimeout(1_500);

    // 解析区間を Length で指定する（既存 A4 と同じ導線）。
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.waitForTimeout(300);
    await viewer.getByText("長さ", { exact: true }).first().click();
    await viewer.waitForTimeout(400);
    await dragOnCanvasHost(viewer, HOST, 90, 60, 0, 12, { fracX: 0.42, fracY: 0.35 });
    await viewer.waitForTimeout(1_200);

    await viewer.getByTestId("xa-analysis-open").click();
    await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });

    // ══ §8.8.2 フレーム固定 ═══════════════════════════════════════════
    // 🔴 錠は「ダイアログを開いている間ずっと」ではなく「**結果がある間だけ**」。
    //    解析前にフレームを選ぶのは正当な操作で、そこまで止めると解析したいフレームへ行けない。
    const lockedBefore = await viewer.getByTestId("xa-qca-frame-locked").count();
    check(lockedBefore === 0, "[L1a] 解析前は「固定中」の表示が出ていない", lockedBefore);
    const idxBefore = await frameIndex(viewer);
    await wheelOnViewer(viewer, 3);
    const idxWheeled = await frameIndex(viewer);
    check(idxWheeled !== idxBefore, "[L1b] ★解析前はホイールでフレームを送れる（錠が掛かっていない）", {
      before: idxBefore,
      after: idxWheeled,
    });

    // 解析するフレームへ戻してから走らせる。
    await viewer.getByTestId("cine-seek").fill(String(FRAME));
    await viewer.waitForTimeout(1_200);
    await viewer.getByTestId("xa-qca-run").click();
    await viewer.waitForTimeout(6_000);

    const auto = await qcaState(viewer);
    check(!!auto && auto.points > 10, "[0] 自動解析が結果を返す", { points: auto?.points, mld: auto?.mld, unit: auto?.unit });
    if (!auto) throw new Error("QCA の状態を取得できませんでした");
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-auto.png") }).catch(() => {});

    // 🚨 **拡大パネルはダイアログのスクロール領域の中にあり、既定では下半分が隠れている。**
    //    `boundingBox()` は隠れている部分も含めて返すので、そのまま座標を作ると
    //    **スクロール容器のほうへクリックが落ちる**（掴めず、しかしエラーも出ないので
    //    「操作したが何も起きない」になる。実際にこの検証の初回でここを踏んだ）。
    await viewer.getByTestId("qca-editor-canvas").scrollIntoViewIfNeeded();
    await viewer.waitForTimeout(500);

    const lockedNotice = await viewer.getByTestId("xa-qca-frame-locked").count();
    check(lockedNotice === 1, "[L2] 結果が出ると「止まっている理由」が画面に出る", lockedNotice);

    const lockIdx0 = await frameIndex(viewer);
    const lockImg0 = await viewportImageId(viewer);
    // 🔴 入口を 1 つでも残すと、そこから裏で動く＝錠の意味が無い。全部塞げているかを見る。
    await wheelOnViewer(viewer, 3);
    check((await frameIndex(viewer)) === lockIdx0, "[L3] ★ホイールでフレームが動かない", {
      want: lockIdx0,
      got: await frameIndex(viewer),
    });

    const hostBox = await viewer.getByTestId(HOST).boundingBox();
    if (hostBox) {
      await viewer.mouse.click(hostBox.x + hostBox.width / 2, hostBox.y + hostBox.height / 2);
      for (let i = 0; i < 3; i++) {
        await viewer.keyboard.press("ArrowDown");
        await viewer.waitForTimeout(150);
      }
      await viewer.waitForTimeout(500);
    }
    check((await frameIndex(viewer)) === lockIdx0, "[L4] キー（↓）でも動かない", await frameIndex(viewer));

    // スライダーは**押せなくなる**。無効化せずに onChange だけ握り潰すと、つまみは動くのに
    // 絵が変わらない＝壊れているようにしか見えない（シネの再生ボタンで実際に踏んだ）。
    const seek = viewer.getByTestId("cine-seek");
    check(await seek.isDisabled(), "[L5a] スライダーが押せない");
    check((await frameIndex(viewer)) === lockIdx0, "[L5b] スライダーからもフレームは動かない", await frameIndex(viewer));

    const playBtn = viewer.getByTestId("cine-play");
    const playCount = await playBtn.count();
    if (playCount) {
      check(await playBtn.first().isDisabled(), "[L6] シネ再生ボタンが押せない（再生から裏で動かせない）");
    } else {
      check(false, "[L6] シネ再生ボタンを見つけられた", { playCount });
    }

    // ★「画面の画像」と「解析した画像」が同じであること。錠の目的そのもの。
    const lockImg1 = await viewportImageId(viewer);
    check(lockImg1 === lockImg0, "[L7a] 表示中の imageId が変わっていない", { before: lockImg0, after: lockImg1 });
    check(
      !!lockImg1 && !!auto.imageId && lockImg1 === auto.imageId,
      "[L7b] ★画面の画像と、解析した画像が一致している",
      { viewport: lockImg1, analyzed: auto.imageId },
    );

    // ══ §8.8.3 エッジ／マスクの表示切り替え ═══════════════════════════
    // 既定は「エッジ ON・マスク OFF」。
    const inkA = await panelInk(viewer);
    check(inkA.line > 50, "[T1a] 既定でエッジの線が描かれている（青の濃い画素がある）", inkA);
    check(inkA.area < inkA.total * 0.05, "[T1b] 既定ではマスクの面は描かれていない", {
      area: inkA.area,
      total: inkA.total,
    });

    await viewer.getByTestId("xa-qca-show-mask").click();
    await viewer.waitForTimeout(600);
    const inkAM = await panelInk(viewer);
    // 🔴 「面が出たか」を線込みの総量で測らない。エッジ線にも太さぶんの面積があるので、
    //    倍率で見ると閾値がエッジの多さ（＝画像の乱れ）に左右される。**増えた分**を見る。
    check(
      inkAM.area - inkA.area > inkAM.total * 0.02,
      "[T2] ★マスクを ON にすると内腔が面で塗られる",
      { before: inkA.area, after: inkAM.area, added: inkAM.area - inkA.area, total: inkAM.total },
    );
    // 🔴 マスクは線より**先に**敷く。順序を間違えると輪郭が面に沈む＝濃い青の画素が減る。
    check(inkAM.line > inkA.line * 0.8, "[T3] ★面を敷いてもエッジ線が沈まない（マスクが線より先に描かれている）", {
      lineBefore: inkA.line,
      lineAfter: inkAM.line,
    });
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-mask.png") }).catch(() => {});

    await viewer.getByTestId("xa-qca-show-edges").click();
    await viewer.waitForTimeout(600);
    const inkM = await panelInk(viewer);
    check(inkM.line < inkA.line * 0.2, "[T4] ★エッジを OFF にすると線が消える（面は残る）", {
      lineBefore: inkA.line,
      lineAfter: inkM.line,
      area: inkM.area,
    });
    check(inkM.area > 500, "[T4b] エッジを消してもマスクは残る", inkM.area);

    await viewer.getByTestId("xa-qca-show-mask").click();
    await viewer.waitForTimeout(600);
    const inkNone = await panelInk(viewer);
    check(inkNone.area < inkA.area * 0.5 && inkNone.line < inkA.line * 0.2, "[T5] ★両方 OFF にすると重ね描きが消える（画像そのものを確かめられる）", inkNone);
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-none.png") }).catch(() => {});

    // 🔴 見えないエッジは掴ませない。掴めてしまうと、どこを動かしたか分からないまま
    //    手修正が入り `provenance.editedEdges` だけが増える。
    await viewer.getByTestId("xa-qca-mode-edge").click();
    await viewer.waitForTimeout(400);
    const hiddenNotice = await viewer.getByTestId("xa-qca-edges-hidden").count();
    check(hiddenNotice === 1, "[T6a] エッジ非表示中は「掴めない理由」が画面に出る", hiddenNotice);
    const stHidden = (await qcaState(viewer))!;
    const hi = Math.floor(stHidden.edges.length / 2);
    const hEdge = stHidden.edges[hi].right;
    const hCenter = stHidden.centerline[hi];
    const hFrom = await panelPoint(viewer, stHidden, hEdge[0], hEdge[1]);
    const hdx = hEdge[0] - hCenter[0];
    const hdy = hEdge[1] - hCenter[1];
    const hl = Math.hypot(hdx, hdy) || 1;
    const hTo = await panelPoint(viewer, stHidden, hEdge[0] + (hdx / hl) * 5, hEdge[1] + (hdy / hl) * 5);
    await viewer.mouse.move(hFrom.x, hFrom.y);
    await viewer.mouse.down();
    await viewer.mouse.move(hTo.x, hTo.y, { steps: 6 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(1_200);
    const stAfterHidden = (await qcaState(viewer))!;
    check(
      stAfterHidden.provenance.editedEdges.length === 0,
      "[T6b] ★見えていないエッジは掴めない（手修正が勝手に増えない）",
      stAfterHidden.provenance.editedEdges.length,
    );

    // 表示を戻す（既定の姿へ）。
    await viewer.getByTestId("xa-qca-show-edges").click();
    await viewer.waitForTimeout(600);
    const inkBack = await panelInk(viewer);
    check(inkBack.line > inkA.line * 0.8, "[T7] エッジ表示を戻すと元どおり描かれる", {
      first: inkA.line,
      back: inkBack.line,
    });
    check((await viewer.getByTestId("xa-qca-edges-hidden").count()) === 0, "[T7b] 掴めない旨の表示は消える");

    // ══ §8.8.1 「ならす」ブラシ — 外れ点の“塊” ═══════════════════════
    // 🔴 実機で言われたのは「外れ値が**塊**だとならせない」。1 点だけの外れで確かめても
    //    再現しない（中央値がまだ効く）ので、**隣り合う数点をまとめて**外す。
    const st0 = (await qcaState(viewer))!;
    const base = Math.floor(st0.edges.length / 2);
    const CLUSTER = 5;
    const PUSH_PX = 5;
    for (let k = 0; k < CLUSTER; k++) {
      const st = (await qcaState(viewer))!;
      const i = base + k - Math.floor(CLUSTER / 2);
      const e = st.edges[i];
      const c = st.centerline[i];
      if (!e || !c) continue;
      const dx = e.right[0] - c[0];
      const dy = e.right[1] - c[1];
      const l = Math.hypot(dx, dy) || 1;
      const from = await panelPoint(viewer, st, e.right[0], e.right[1]);
      const to = await panelPoint(viewer, st, e.right[0] + (dx / l) * PUSH_PX, e.right[1] + (dy / l) * PUSH_PX);
      await viewer.mouse.move(from.x, from.y);
      await viewer.mouse.down();
      await viewer.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 3 });
      await viewer.mouse.move(to.x, to.y, { steps: 3 });
      await viewer.mouse.up();
      await viewer.waitForTimeout(700);
    }
    const stOut = (await qcaState(viewer))!;
    const edited = [...stOut.provenance.editedEdges].sort((a, b) => a - b);
    check(edited.length >= 3, "[S1a] ★外れ点の塊を作れた（手修正として記録されている）", { edited });
    // 「隣り合っている」ことまで見る。バラバラの点を直すのは元の実装でもできていた。
    const contiguous = edited.length >= 3 && edited[edited.length - 1] - edited[0] <= edited.length + 2;
    check(contiguous, "[S1b] ★外れが隣り合った塊になっている（1 点ずつではない）", {
      first: edited[0],
      last: edited[edited.length - 1],
      count: edited.length,
    });

    const offBefore = offsets(stOut, "right");
    const excl = new Set(edited);
    const center = edited[Math.floor(edited.length / 2)];
    const baseline = baselineAround(offBefore, center, 30, excl);
    const residBefore = edited.map((i) => Math.abs(offBefore[i] - baseline));
    const maxResidBefore = Math.max(...residBefore);
    check(maxResidBefore > 2.0, "[S1c] ★塊が周囲から実際に外れている [px]", {
      baseline: Number(baseline.toFixed(2)),
      maxResidual: Number(maxResidBefore.toFixed(2)),
    });
    await viewer.screenshot({ path: path.join(OUT_DIR, "4-outliers.png") }).catch(() => {});

    // 「ならす」でなでる。掴んだ点を中心に、動かすたびに 1 回効く（strength 0.6）。
    await viewer.getByTestId("xa-qca-mode-smooth").click();
    await viewer.waitForTimeout(500);
    const stSm = (await qcaState(viewer))!;
    const ci = stSm.centerline[center];
    const ei = stSm.edges[center].right;
    const grab = await panelPoint(viewer, stSm, ei[0], ei[1]);
    const nx = ei[0] - ci[0];
    const ny = ei[1] - ci[1];
    const nl = Math.hypot(nx, ny) || 1;
    await viewer.mouse.move(grab.x, grab.y);
    await viewer.mouse.down();
    // なで続ける（＝pointermove を何度も出す）。位置は使われないが、動かさないと発火しない。
    for (let k = 0; k < 8; k++) {
      const wob = await panelPoint(
        viewer,
        stSm,
        ei[0] + (nx / nl) * (k % 2 === 0 ? 0.6 : -0.6),
        ei[1] + (ny / nl) * (k % 2 === 0 ? 0.6 : -0.6),
      );
      await viewer.mouse.move(wob.x, wob.y, { steps: 2 });
      await viewer.waitForTimeout(250);
    }
    await viewer.mouse.up();
    await viewer.waitForTimeout(1_500);

    const stAfter = (await qcaState(viewer))!;
    const offAfter = offsets(stAfter, "right");
    const residAfter = edited.map((i) => Math.abs(offAfter[i] - baseline));
    const maxResidAfter = Math.max(...residAfter);
    // 🚨 **掴めていなければ何も起きず、残差も変わらない**——「効かない」と「触れていない」を
    //    数値で区別できるようにしておく。掴めていれば、なでた点の周り（半径の中）も
    //    一緒に動くので**手修正の点が増える**。
    check(
      stAfter.provenance.editedEdges.length > edited.length,
      "[S2a] ★なでる操作が実際に効いた（手修正の点が増える）",
      { before: edited.length, after: stAfter.provenance.editedEdges.length },
    );
    check(
      maxResidAfter < maxResidBefore * 0.5,
      "[S2b] ★「ならす」で外れ点の塊が周囲へ寄る（塊でも効く＝§8.8.1 の退行の見張り）",
      { before: Number(maxResidBefore.toFixed(2)), after: Number(maxResidAfter.toFixed(2)) },
    );
    // 🔴 合っている点はほとんど動かない。全体を均してしまうなら、それは「ならす」ではない。
    let maxFar = 0;
    for (let i = 0; i < offAfter.length; i++) {
      if (Math.abs(i - center) <= 40) continue;
      maxFar = Math.max(maxFar, Math.abs(offAfter[i] - offBefore[i]));
    }
    check(maxFar < 0.5, "[S3] 離れた点は動かない（狭窄そのものを均していない）[px]", Number(maxFar.toFixed(3)));
    check(stAfter.provenance.edited === true, "[S4] 「ならす」も手修正として記録される", {
      edited: stAfter.provenance.editedEdges.length,
    });
    await viewer.screenshot({ path: path.join(OUT_DIR, "5-smoothed.png") }).catch(() => {});

    // ══ §8.9 ストレート像 ═══════════════════════════════════════════
    // 🔴 見るのは「帯が出る」ことではなく、**帯の座標が本画面の量と同じ意味を持つ**こと。
    //    横が弧長でなく添字だと、斜めの区間だけ縮んだ帯になる（絵は出るので気付けない）。
    await viewer.getByTestId("qca-straight-canvas").scrollIntoViewIfNeeded();
    await viewer.waitForTimeout(400);
    const stSt = (await qcaState(viewer))!;
    check(!!stSt.straight, "[ST1a] ストレート像が既定で出ている", stSt.straight);
    if (!stSt.straight) throw new Error("ストレート像が出ていません");
    const lengthPx = polylineLengthPx(stSt.centerline);
    check(
      Math.abs(stSt.straight.lengthPx - lengthPx) < 0.5,
      "[ST1b] ★帯の全長が中心線の弧長と一致する",
      { strip: Number(stSt.straight.lengthPx.toFixed(2)), centerline: Number(lengthPx.toFixed(2)) },
    );
    check(
      Math.abs(stSt.straight.cols - (Math.round(lengthPx) + 1)) <= 1,
      "[ST1c] ★横は弧長で 1px ごとに刻まれている（計測点の添字ではない）",
      { cols: stSt.straight.cols, expected: Math.round(lengthPx) + 1, points: stSt.centerline.length },
    );
    check(
      stSt.straight.rows === stSt.straight.halfWidthPx * 2 + 1,
      "[ST1d] 縦は中心線からの ±オフセット",
      stSt.straight,
    );
    const inkSt = await stripState(viewer);
    check(!!inkSt && inkSt.ink > 50, "[ST1e] 帯にエッジが描かれている（画素で確認）", inkSt);
    await viewer.screenshot({ path: path.join(OUT_DIR, "6-straight.png") }).catch(() => {});

    // ★本画面で直したら帯も変わる（別々の絵を持っていない）。
    const sigBefore = (await stripState(viewer))!.sig;
    const stMain = (await qcaState(viewer))!;
    const mi = Math.min(stMain.edges.length - 5, Math.floor(stMain.edges.length / 2) + 20);
    const me = stMain.edges[mi].right;
    const mc = stMain.centerline[mi];
    const mdx = me[0] - mc[0];
    const mdy = me[1] - mc[1];
    const ml = Math.hypot(mdx, mdy) || 1;
    const mFrom = await panelPoint(viewer, stMain, me[0], me[1]);
    const mTo = await panelPoint(viewer, stMain, me[0] + (mdx / ml) * 4, me[1] + (mdy / ml) * 4);
    await viewer.mouse.move(mFrom.x, mFrom.y);
    await viewer.mouse.down();
    await viewer.mouse.move(mTo.x, mTo.y, { steps: 6 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(1_200);
    const sigAfterMain = (await stripState(viewer))!.sig;
    check(sigAfterMain !== sigBefore, "[ST2] ★本画面で直すと帯も描き直される（連動）", {
      before: sigBefore,
      after: sigAfterMain,
    });

    // ★帯の上でエッジを掴んで直せる。
    // 🚨 **モードを明示して入る。** ここまでの検証で「ならす」のままだったため、帯の
    //    ドラッグが（正しく）ならしブラシとして効き、11 点がまとめて動いた——
    //    「掴んだ点と直った点が違う」という**偽の不具合**に見えた（2026-08-29）。
    await viewer.getByTestId("xa-qca-mode-edge").click();
    await viewer.waitForTimeout(400);
    // 🚨 触る直前に毎回スクロールし直す。上のボタンを押すと Playwright がそちらを
    //    可視化するので、帯がスクロール領域の外へ戻る（§18-2 と同じ罠）。
    await viewer.getByTestId("qca-straight-canvas").scrollIntoViewIfNeeded();
    await viewer.waitForTimeout(300);
    const stBefore = (await qcaState(viewer))!;
    const editedBefore = [...stBefore.provenance.editedEdges];
    const colFrac = 0.35;
    const idxAtCol = indexAtArcFraction(stBefore.centerline, colFrac);
    const offBefore0 = offsets(stBefore, "right")[idxAtCol];
    const half = stBefore.straight!.halfWidthPx;
    const grabPt = await stripPoint(viewer, colFrac, offBefore0, half);
    const dropOffset = offBefore0 + 4;
    const dropPt = await stripPoint(viewer, colFrac, dropOffset, half);
    await viewer.mouse.move(grabPt.x, grabPt.y);
    await viewer.mouse.down();
    await viewer.mouse.move((grabPt.x + dropPt.x) / 2, (grabPt.y + dropPt.y) / 2, { steps: 4 });
    await viewer.mouse.move(dropPt.x, dropPt.y, { steps: 4 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(1_500);
    const stAfterStrip = (await qcaState(viewer))!;
    const newlyEdited = stAfterStrip.provenance.editedEdges.filter((p) => !editedBefore.includes(p));
    check(newlyEdited.length === 1, "[ST3a] ★帯の上でエッジを 1 点だけ掴んで動かせた", {
      before: editedBefore.length,
      after: stAfterStrip.provenance.editedEdges.length,
      newly: newlyEdited,
    });
    // 🔴 `editedEdges` は**計測点の添字**（`pathIndices` で引き直さない。引き直すと別の点になる）。
    const stripEditIndex = newlyEdited.length ? newlyEdited[0] : -1;
    // 🔴 掴んだ「列」が狙った計測点に対応しているか。ここがずれると、帯で直したつもりの
    //    点と実際に直った点が違う——値は出るので画面からは気付けない。
    check(
      stripEditIndex >= 0 && Math.abs(stripEditIndex - idxAtCol) <= 2,
      "[ST3b] ★掴んだ列に対応する計測点が直された",
      { edited: stripEditIndex, wanted: idxAtCol },
    );
    const offAfterStrip = stripEditIndex >= 0 ? offsets(stAfterStrip, "right")[stripEditIndex] : NaN;
    check(
      Math.abs(offAfterStrip - dropOffset) < 1.5,
      "[ST3c] ★落とした位置と同じオフセットになる（帯の縦＝法線方向のずれ）[px]",
      { want: Number(dropOffset.toFixed(2)), got: Number(offAfterStrip.toFixed(2)) },
    );

    // ★帯から中間点を置くと中心線が変わる（中心線の編集も帯からできる）。
    await viewer.getByTestId("xa-qca-mode-waypoint").click();
    await viewer.waitForTimeout(400);
    await viewer.getByTestId("qca-straight-canvas").scrollIntoViewIfNeeded();
    await viewer.waitForTimeout(300);
    const stWp = (await qcaState(viewer))!;
    const wpPt = await stripPoint(viewer, 0.6, 5, stWp.straight!.halfWidthPx);
    await viewer.mouse.click(wpPt.x, wpPt.y);
    await viewer.waitForTimeout(2_500);
    const stWpAfter = (await qcaState(viewer))!;
    check(
      stWpAfter.provenance.waypoints > stWp.provenance.waypoints,
      "[ST4a] ★帯から中間点を置ける",
      { before: stWp.provenance.waypoints, after: stWpAfter.provenance.waypoints },
    );
    check(
      stWpAfter.centerlineToken !== stWp.centerlineToken,
      "[ST4b] ★中心線が実際に変わった（帯からの編集が本体へ効く）",
      { before: stWp.centerlineToken, after: stWpAfter.centerlineToken },
    );
    await viewer.screenshot({ path: path.join(OUT_DIR, "7-straight-edited.png") }).catch(() => {});

    // トグルで消せる／戻せる。
    await viewer.getByTestId("xa-qca-show-straight").click();
    await viewer.waitForTimeout(500);
    check((await viewer.getByTestId("qca-straight-canvas").count()) === 0, "[ST5a] トグルで帯を消せる");
    await viewer.getByTestId("xa-qca-show-straight").click();
    await viewer.waitForTimeout(700);
    check((await viewer.getByTestId("qca-straight-canvas").count()) === 1, "[ST5b] トグルで戻せる");

    // ══ 錠は必ず外れる ═══════════════════════════════════════════════
    // 🔴 外れ残ると「フレームが二度と送れないビューア」になり、原因が「前に開いた解析
    //    ダイアログ」なので利用者からは絶対に辿れない。**ここが一番怖い**。
    await viewer.getByTestId("xa-dialog-close").click();
    await viewer.waitForTimeout(1_000);
    const idxClosed = await frameIndex(viewer);
    await wheelOnViewer(viewer, 3);
    const idxAfterClose = await frameIndex(viewer);
    check(idxAfterClose !== idxClosed, "[L8] ★ダイアログを閉じると錠が外れる（またフレームを送れる）", {
      before: idxClosed,
      after: idxAfterClose,
    });
  } finally {
    await driver.stop();
  }

  console.log(`\n===== QCA ならす／表示切替／フレーム固定（§8.8.1〜§8.8.3） =====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) {
    console.log("失敗した項目:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
  console.log(`スクリーンショット: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

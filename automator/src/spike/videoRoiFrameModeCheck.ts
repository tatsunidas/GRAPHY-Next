/*
 * 動画 ROI の「フレーム指定モード」実機検証（`fw/video-viewer-design.md` §12 モード①）。
 *
 * 実行:  cd automator && npx tsx src/spike/videoRoiFrameModeCheck.ts
 *
 * 背景: PR #69（フレーム指定 ROI の明示切替＋単一フレーム統計）は typecheck / vitest のみ green で、
 * **UI の振る舞いが未検証**のまま残っていた（design doc §12「未検証（要・実機確認）」）。ここで確認するのは:
 *   1. フレーム送りに追従した ROI の表示/非表示（描いたフレームだけに出る）
 *   2. 帰属トグルの実挙動（フレーム指定 ⇔ グローバル。別フレームの ROI を黙って付け替えない）
 *   3. 単一フレーム統計とヒストグラムの描画（＋**要求したフレームを実際に読んでいる**こと）
 *   4. 時系列解析がグローバル帰属の ROI だけを対象にすること
 *
 * 表示/非表示の判定は cornerstone の内部 API ではなく **SVG レイヤの DOM**で行う（利用者に見えるもので判定する）。
 * frame 指定 ROI は Rectangle（svg `rect`）、グローバル ROI は Ellipse（svg `ellipse`）で描き分けて識別する。
 *
 * フィクスチャ: `automator/fixtures/video-mp4-avi/*.mp4`（無ければ ffmpeg で合成して置く）。
 * 合成動画は **輝度が時間とともに単調増加**（かつ横方向グラデーション）なので、
 * 「フレーム f の統計が本当にフレーム f のものか」「TIC が右肩上がりか」を数値で検証できる。
 * 全フレーム I フレーム（`-g 1`）にしてあるので、time シークの GOP 誤差（§10-3 の既知の甘さ）に依存しない。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importNonDicomPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "video-roi-frame-mode");
const FIXTURE_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "video-mp4-avi");
const HOST = "video-viewport-host";

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

/**
 * 検証用の合成動画を用意する（既にフィクスチャがあればそれを使う）。
 * `lum = 20 + (X/W)*100 + T*60` … 横グラデーション（ヒストグラムが広がる）＋時間で単調に明るくなる
 * （フレーム別統計・TIC が数値で判定できる）。2 秒 / 15fps = 30 フレーム。
 */
function ensureFixtureVideo(): string {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const existing = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => /\.(mp4|avi)$/i.test(f))
    .map((f) => path.join(FIXTURE_DIR, f));
  if (existing.length > 0) {
    return existing[0];
  }
  const out = path.join(FIXTURE_DIR, "tic-ramp.mp4");
  console.log(`フィクスチャ動画が無いので ffmpeg で合成します: ${out}`);
  execFileSync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=320x240:r=15:d=2",
      "-vf", "geq=lum='clip(20 + (X/W)*100 + T*60, 0, 255)':cb=128:cr=128,format=yuv420p",
      "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.1",
      "-g", "1", "-pix_fmt", "yuv420p",
      out,
    ],
    { stdio: "inherit" },
  );
  return out;
}

/** ROI 一覧チップの状態（帰属バッジ・淡色破線か）をまとめて読む。 */
interface ChipState {
  uid: string;
  badge: string; // 「全」 or "F5"
  dashed: boolean; // 現在フレームで非表示（淡色破線）
}

async function readChips(page: Page): Promise<ChipState[]> {
  return page.evaluate(`
    (function () {
      var chips = Array.from(document.querySelectorAll('[data-testid="video-roi-chip"]'));
      return chips.map(function (chip) {
        var toggle = chip.querySelector('[data-testid^="video-roi-scope-toggle-"]');
        var uid = toggle ? toggle.getAttribute("data-testid").replace("video-roi-scope-toggle-", "") : "";
        return {
          uid: uid,
          badge: (toggle && toggle.textContent || "").trim(),
          dashed: getComputedStyle(chip).borderStyle === "dashed",
        };
      });
    })()
  `) as Promise<ChipState[]>;
}

interface SvgShapes {
  rect: number;
  ellipse: number;
  total: number;
}

/**
 * 期待どおりの描画になるまで最大 3 秒ポーリングして、最後に読めた状態を返す。
 * 再描画は video のフレーム描画（IMAGE_RENDERED）に乗るので、シーク/トグル直後は 1 テンポ遅れる。
 * 「出る」ことの確認も「消える」ことの確認も、この関数で待ってから判定する（フレーキー回避）。
 */
async function waitForSvgShapes(page: Page, want: (s: SvgShapes) => boolean): Promise<SvgShapes> {
  let last = await readSvgShapes(page);
  for (let i = 0; i < 30 && !want(last); i++) {
    await page.waitForTimeout(100);
    last = await readSvgShapes(page);
  }
  return last;
}

/** SVG レイヤに実際に描かれている図形を数える（＝利用者に見えているか）。 */
async function readSvgShapes(page: Page): Promise<SvgShapes> {
  return page.evaluate(`
    (function () {
      var host = document.querySelector('[data-testid="${HOST}"]');
      var svg = host && host.querySelector(".svg-layer");
      if (!svg) return { rect: 0, ellipse: 0, total: 0 };
      // rect.background は計測値テキストボックスの背景なので図形として数えない。
      return {
        rect: svg.querySelectorAll("rect:not(.background)").length,
        ellipse: svg.querySelectorAll("ellipse").length,
        total: svg.childElementCount,
      };
    })()
  `) as Promise<{ rect: number; ellipse: number; total: number }>;
}

/**
 * シークバー（`video-seek`）でフレームを移動する。
 * React の onChange は "input" イベントで発火するため、value を native setter で入れてから dispatch する
 * （Playwright の fill() は range 入力では使えない）。
 */
async function seekToFrame(page: Page, frame: number): Promise<number> {
  await page.evaluate(`
    (function (f) {
      var el = document.querySelector('[data-testid="video-seek"]');
      if (!el) throw new Error("video-seek が見つかりません");
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(el, String(f));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })(${frame})
  `);
  // フレームは IMAGE_RENDERED でも更新されるので、落ち着くまで待って**実際の**フレームを返す。
  const seek = page.getByTestId("video-seek");
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(100);
    const v = Number(await seek.inputValue());
    if (v === frame) {
      return v;
    }
  }
  return Number(await seek.inputValue());
}

/** 単一フレーム統計パネルが開いていれば閉じる（読み取りが前回値を掴まないように）。 */
async function closeFrameStats(page: Page): Promise<void> {
  const close = page.getByTestId("video-frame-stats-close");
  if ((await close.count()) > 0) {
    await close.click();
    await page.getByTestId("video-frame-stats-panel").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  }
}

/** ROI の帰属モード（新規作成時の既定）を切り替える。 */
async function setScopeMode(page: Page, mode: "global" | "frame"): Promise<void> {
  await page.getByTestId(`video-roi-scope-${mode}`).click();
  await page.waitForTimeout(200);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) }).catch(() => {});
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const video = ensureFixtureVideo();
  console.log(`検証に使う動画: ${video}`);

  const driver = new DesktopDriver();
  await driver.start();
  try {
    await resetDb(driver.ports.http);
    const imp = await importNonDicomPaths(driver.ports.http, [video], {
      patientId: "VIDEO-ROI",
      patientName: "VIDEO^ROI",
      seriesDescription: "video roi frame mode",
    });
    console.log(`取込結果: ${JSON.stringify(imp)}`);
    if (imp.imported !== 1) {
      throw new Error(`動画の DICOM 化取込に失敗しました: ${JSON.stringify(imp)}`);
    }

    const page = driver.page;
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await waitForMainScreenReady(page, 60_000);

    // 無条件検索 → スタディ → シリーズ（動画は MainScreen のインライン VideoViewer で開く）。
    page.once("dialog", (d) => void d.accept());
    const dateInputs = page.locator('input[type="date"]');
    await dateInputs.nth(0).fill("");
    await dateInputs.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    const studyRow = page.locator('[data-testid^="study-row-"]').first();
    await studyRow.waitFor({ state: "visible", timeout: 30_000 });
    await studyRow.click();
    const seriesRow = page.locator('[data-testid^="series-row-"]').first();
    await seriesRow.waitFor({ state: "visible", timeout: 20_000 });
    await seriesRow.click();

    // 方式 A（VideoViewport）で開けたこと＝ツールバーが出ること。方式 B フォールバックでは ROI は使えない。
    await page.getByTestId(HOST).waitFor({ state: "visible", timeout: 60_000 });
    const toolbarOk = await page
      .getByTestId("video-tool-rectangle")
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    check(toolbarOk, "VideoViewport（方式 A）で開き ROI ツールバーが出る");
    if (!toolbarOk) {
      throw new Error("方式 B フォールバックで開いたため ROI の検証ができません");
    }
    await page.waitForTimeout(800);
    const totalFrames = Number(await page.getByTestId("video-seek").getAttribute("max"));
    console.log(`総フレーム数: ${totalFrames}`);
    await shot(page, "00-opened");

    // ── 1. フレーム指定 ROI を frame 5 に描く
    await setScopeMode(page, "frame");
    const f5 = await seekToFrame(page, 5);
    check(f5 === 5, "シークバーでフレーム 5 へ移動できる", { frame: f5 });
    await page.getByTestId("video-tool-rectangle").click();
    await page.waitForTimeout(200);
    await dragOnCanvasHost(page, HOST, 70, 50, 0, 12, { fracX: 0.3, fracY: 0.3 });
    await page.waitForTimeout(600);
    let chips = await readChips(page);
    check(chips.length === 1, "ROI が 1 件として一覧に出る", chips);
    check(chips[0]?.badge === "F5", "帰属バッジが F5（描いたフレームに紐づく）", chips[0]);
    let svg = await waitForSvgShapes(page, (s) => s.rect > 0);
    check(svg.rect > 0, "フレーム 5 では ROI が描画されている（svg rect あり）", svg);
    check(chips[0]?.dashed === false, "チップは実線（現在フレームで表示中）", chips[0]);
    await shot(page, "01-frame5-rect-drawn");

    // ── 2. 別フレームへ送ると消える
    const f12 = await seekToFrame(page, 12);
    check(f12 === 12, "フレーム 12 へ移動できる", { frame: f12 });
    svg = await waitForSvgShapes(page, (s) => s.rect === 0);
    chips = await readChips(page);
    check(svg.rect === 0, "フレーム 12 では ROI が描画されない（フレーム送りに追従して非表示）", svg);
    check(chips.length === 1 && chips[0].dashed, "一覧には残り、淡色破線で示される（迷子にならない）", chips);
    const counts = ((await page.getByTestId("video-roi-scope-counts").textContent()) ?? "").trim();
    check(/1/.test(counts), "内訳表示に「別フレーム 1」が出る", counts);
    await shot(page, "02-frame12-hidden");

    // ── 3. 戻すと再表示
    await seekToFrame(page, 5);
    svg = await waitForSvgShapes(page, (s) => s.rect > 0);
    chips = await readChips(page);
    check(svg.rect > 0 && !chips[0].dashed, "フレーム 5 に戻すと再表示される", { svg, chip: chips[0] });

    // ── 4. 時系列解析はグローバル帰属の ROI だけを対象にする
    await page.getByTestId("video-analyze-run").click();
    await page.waitForTimeout(1000);
    let body = await page.evaluate(() => document.body.innerText);
    check(
      /グローバル帰属|global-scoped|グローバル ROI|Global ROI/i.test(body),
      "フレーム指定 ROI だけでは時系列解析が「グローバル ROI が必要」と断る",
      body.split("\n").filter((l) => /ROI/.test(l)).slice(0, 3),
    );
    check((await page.getByTestId("video-analyze-summary").count()) === 0, "時系列カーブは出ない");

    // ── 5. 単一フレーム統計: 現在フレームに ROI が無ければ断る
    await seekToFrame(page, 12);
    await page.getByTestId("video-frame-stats").click();
    await page.waitForTimeout(1200);
    check(
      (await page.getByTestId("video-frame-stats-panel").count()) === 0,
      "現在フレームに表示中の ROI が無ければ単一フレーム統計は出ない",
    );

    // ── 6. 単一フレーム統計＋ヒストグラム（フレーム 5 の ROI で）
    await seekToFrame(page, 5);
    await closeFrameStats(page);
    await page.getByTestId("video-frame-stats").click();
    await page.getByTestId("video-frame-stats-panel").waitFor({ state: "visible", timeout: 30_000 });
    const stat5 = ((await page.getByTestId("video-frame-stats-summary").textContent()) ?? "").trim();
    const bars5 = await page.evaluate(`
      (function () {
        var p = document.querySelector('[data-testid="video-frame-stats-panel"]');
        var svg = p && p.querySelector("svg");
        if (!svg) return { bars: 0, nonzero: 0 };
        var rects = Array.from(svg.querySelectorAll("rect"));
        return {
          bars: rects.length,
          nonzero: rects.filter(function (r) { return Number(r.getAttribute("height")) > 0; }).length,
        };
      })()
    `) as { bars: number; nonzero: number };
    check(stat5.length > 0, "単一フレーム統計の要約が出る（面積/平均/最小/最大/SD）", stat5);
    check(bars5.bars > 4 && bars5.nonzero > 1, "ヒストグラムが描画される（複数ビンに度数がある）", bars5);
    await shot(page, "03-frame5-histogram");

    // ── 7. 帰属トグル: 別フレームで押しても「現在フレームへ付け替える」のではなくグローバル化する
    const uid = chips[0].uid;
    await seekToFrame(page, 12);
    await page.getByTestId(`video-roi-scope-toggle-${uid}`).click();
    await page.waitForTimeout(600);
    chips = await readChips(page);
    svg = await waitForSvgShapes(page, (s) => s.rect > 0);
    check(chips[0]?.badge !== "F12", "別フレームで押した時に現在フレームへ黙って付け替えない", chips[0]);
    check(chips[0]?.badge !== "F5" && svg.rect > 0, "グローバルへ切り替わり全フレームで表示される", {
      chip: chips[0],
      svg,
    });
    await shot(page, "04-toggled-to-global");

    // ── 8. もう一度押すと現在フレーム（12）に紐づく
    await page.getByTestId(`video-roi-scope-toggle-${uid}`).click();
    await page.waitForTimeout(600);
    chips = await readChips(page);
    check(chips[0]?.badge === "F12", "グローバル → 現在フレーム（F12）に切り替わる", chips[0]);
    await seekToFrame(page, 5);
    svg = await waitForSvgShapes(page, (s) => s.rect === 0);
    check(svg.rect === 0, "F12 に紐づけ直した ROI はフレーム 5 で非表示", svg);

    // ── 9. グローバル ROI（楕円）は全フレームで表示される
    await setScopeMode(page, "global");
    await page.getByTestId("video-tool-ellipse").click();
    await page.waitForTimeout(200);
    await dragOnCanvasHost(page, HOST, 60, 45, 0, 12, { fracX: 0.62, fracY: 0.62 });
    await page.waitForTimeout(600);
    chips = await readChips(page);
    check(chips.length === 2, "ROI が 2 件になる", chips);
    const gChip = chips.find((c) => c.uid !== uid);
    check(gChip !== undefined && !/^F/.test(gChip.badge), "新規 ROI はグローバル帰属で作られる", gChip);
    svg = await waitForSvgShapes(page, (s) => s.ellipse > 0 && s.rect === 0);
    check(svg.ellipse > 0 && svg.rect === 0, "フレーム 5: グローバルのみ表示（frame 指定は非表示）", svg);
    await seekToFrame(page, 25);
    svg = await waitForSvgShapes(page, (s) => s.ellipse > 0);
    check(svg.ellipse > 0, "フレーム 25 でもグローバル ROI は表示される", svg);
    await shot(page, "05-global-ellipse");

    // ── 10. 単一フレーム統計は**要求したフレーム**を読んでいる
    //        （合成動画は時間とともに明るくなるので、後のフレームの平均が必ず大きい）
    const meanOfFrameStats = async (f: number): Promise<number> => {
      await seekToFrame(page, f);
      // ⚠ 開いたままのパネルを読むと**前のフレーム/前の ROI の値**を掴む（実際に踏んだ）。必ず閉じてから開く。
      await closeFrameStats(page);
      await page.getByTestId("video-frame-stats").click();
      await page.getByTestId("video-frame-stats-panel").waitFor({ state: "visible", timeout: 30_000 });
      const txt = ((await page.getByTestId("video-frame-stats-summary").textContent()) ?? "").trim();
      // 「平均 123.4」/"mean 123.4" 形式。最初に現れる小数を平均として拾う。
      const nums = txt.match(/\d+\.\d/g) ?? [];
      console.log(`    frame ${f}: ${txt}`);
      return nums.length > 0 ? Number(nums[0]) : NaN;
    };
    const mEarly = await meanOfFrameStats(3);
    const mLate = await meanOfFrameStats(28);
    check(
      Number.isFinite(mEarly) && Number.isFinite(mLate) && mLate > mEarly + 20,
      "フレームごとに違う統計が出る（後のフレームの方が明るい＝指定フレームを読んでいる）",
      { mEarly, mLate },
    );
    await shot(page, "06-frame28-histogram");

    // ── 10b. cornerstone が ROI に重ねる計測テキストがフレームに追従する
    //         （cachedStats は作成フレームの値のままになりがち。無効化して再計算させている）
    const overlayMean = async (): Promise<number> => {
      const txt = await page.evaluate(`
        (function () {
          var host = document.querySelector('[data-testid="${HOST}"]');
          var svg = host && host.querySelector(".svg-layer");
          return svg ? (svg.textContent || "") : "";
        })()
      `) as string;
      const m = txt.match(/(?:Mean|平均)[^0-9-]*(-?\d+(?:\.\d+)?)/);
      return m ? Number(m[1]) : NaN;
    };
    await seekToFrame(page, 3);
    const ov3 = await overlayMean();
    await seekToFrame(page, 28);
    const ov28 = await overlayMean();
    console.log(`    計測テキストの平均: frame3=${ov3} frame28=${ov28}`);
    check(
      Number.isFinite(ov3) && Number.isFinite(ov28) && ov28 > ov3 + 20,
      "ROI に重なる計測テキストがフレームに追従して更新される",
      { ov3, ov28 },
    );
    await shot(page, "06b-overlay-follows-frame");

    // ── 10c. 複数 ROI から解析対象を選べる（選択した ROI が解析される）
    //         いま frame 指定(F12)の矩形とグローバルの楕円があるので、矩形を選んで
    //         「グローバルROI解析」を押すと帰属が合わず断られる＝選択が効いていることが分かる。
    await seekToFrame(page, 12);
    await page.getByTestId(`video-roi-select-${uid}`).click();
    await page.waitForTimeout(300);
    check(
      (await page.getByTestId("video-roi-selected-note").count()) === 1,
      "ROI を選択すると「選択中の ROI を解析します」が出る",
    );
    check(
      (await page.locator('[data-testid="video-roi-chip"][data-selected="1"]').count()) === 1,
      "選択中のチップが 1 つだけ強調される",
    );
    await page.getByTestId("video-analyze-run").click();
    await page.waitForTimeout(1200);
    check(
      (await page.getByTestId("video-analyze-summary").count()) === 0,
      "選択した ROI がフレーム指定なら時系列解析は断られる（＝直近ではなく選択が使われている）",
    );
    // 選択を楕円（グローバル）へ移すと今度は解析できる。
    const gUid = chips.find((c) => c.uid !== uid)!.uid;
    await page.getByTestId(`video-roi-select-${uid}`).click(); // いったん解除
    await page.getByTestId(`video-roi-select-${gUid}`).click();
    await page.waitForTimeout(300);
    await shot(page, "06c-roi-selection");

    // ── 11. グローバル ROI があれば時系列解析が走る（右肩上がりの TIC）
    await page.getByTestId("video-analyze-run").click();
    await page.getByTestId("video-analyze-summary").waitFor({ state: "visible", timeout: 90_000 });
    // TimeIntensityChart は <path d="M…L…"> でカーブを描く（polyline ではない）。
    const tic = await page.evaluate(`
      (function () {
        var panel = Array.from(document.querySelectorAll("div")).find(function (d) {
          return d.querySelector('[data-testid="video-analyze-summary"]');
        });
        var paths = panel ? Array.from(panel.querySelectorAll("svg path")) : [];
        var verts = paths.map(function (p) { return ((p.getAttribute("d") || "").match(/[ML]/g) || []).length; });
        return {
          verts: verts,
          summary: (panel && panel.querySelector('[data-testid="video-analyze-summary"]').textContent) || "",
        };
      })()
    `) as { verts: number[]; summary: string };
    check(Math.max(0, ...tic.verts) >= 10, "TIC カーブが描画される（頂点が全フレーム分ある）", tic.verts.slice(0, 4));
    console.log(`    TIC 要約: ${String(tic.summary).trim()}`);
    await shot(page, "07-tic");

    // ── 12. 片付け（削除・全消去）が帰属モード導入後も効く
    await page.getByTestId("video-roi-clear").click();
    await page.waitForTimeout(600);
    check((await page.getByTestId("video-roi-list").count()) === 0, "全消去で一覧が消える");
    svg = await waitForSvgShapes(page, (s) => s.rect === 0 && s.ellipse === 0);
    check(svg.rect === 0 && svg.ellipse === 0, "全消去で描画も消える", svg);

    const bad = consoleErrors.filter((m) => !/DevTools|Autofill|GPU stall/i.test(m));
    check(bad.length === 0, "コンソールに未処理エラーが出ない", bad.slice(0, 3));
    body = await page.evaluate(() => document.body.innerText);
    check(!/\{\{/.test(body), "i18n の補間漏れ（{{…}} の字面表示）が無い");
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

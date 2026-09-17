/*
 * フーリエ解析ダイアログ（2D Viewer > 解析 > フーリエ解析）の実機検証スパイク（fw/fourier-design.md）。
 *
 * 実行:  cd automator && npx tsx src/spike/fourierCheck.ts
 *
 * 🔴 押す系は押した検査でしか守れない（CLAUDE.md ルール 9）。ここでは各コントロールを**実際に操作し、
 * 画面（canvas の画素・数値欄・ヘッダ）が期待どおり変わること**を見る。
 *
 *   1. メニューから開くと、表示中スライスの番号がヘッダに出て、スペクトル・逆変換が描かれる。
 *   2. フィルタ「なし」の 2D-iDFT が原画像と同じ見た目になる（往復）。
 *   3. 表示切替（|Re|/|Im|/|F|）・log・四象限入れ替えで、スペクトルの描画が変わる。
 *   4. 円形 ∧ → 半径 → !∧、ドーナツ、長方形（縦ドラッグは位置だけ動く）、σ で結果が変わる。
 *   5. 基底: スライダー・スペクトルのクリック・重み付けで基底画像と座標が変わる。
 *   6. 32-bit TIFF の書き出しボタンが TIFF（II*・SampleFormat=3）を出す。
 *   7. スライスを送って「再取得」すると、ヘッダのスライス番号が追従する。
 *
 * 前提: backend jar と fixture ct-basic。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "fourier-check");

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

/** canvas の画素（グレー値）を取り出す。 */
async function canvasGray(page: Page, testId: string): Promise<number[]> {
  return page.evaluate(`
    (function () {
      var c = document.querySelector('[data-testid="${testId}"]');
      if (!c) return [];
      var d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      var out = new Array(d.length / 4);
      for (var i = 0; i < out.length; i++) out[i] = d[i * 4];
      return out;
    })()
  `) as Promise<number[]>;
}

function meanAbsDiff(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
function stdev(a: number[]): number {
  if (!a.length) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
}

async function settle(page: Page, ms = 700): Promise<void> {
  await page.waitForTimeout(ms);
}

async function setRange(page: Page, testId: string, value: number): Promise<void> {
  await page.getByTestId(testId).fill(String(value));
  await settle(page);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver();
  await d.start();
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importFixtureCategory(d.ports.http, "ct-basic"))}`);
    const mainPage = d.page;
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await mainPage.waitForTimeout(2000);
    // 検証用 jar が最新リリースより古いと「新しいバージョンがあります」が被さるので閉じる。
    const later = mainPage.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) {
      await later.click();
      await mainPage.waitForTimeout(500);
    }
    await openFirstSeriesInViewer(mainPage, createStepRecorder());
    const viewer = await d.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    viewer.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
    });
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(3000);

    // ダウンロードを横取りして中身を確かめる（保存ダイアログを出さない）。
    await viewer.evaluate(`
      (function () {
        window.__fourierDownloads = [];
        var orig = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          var a = this;
          if (a.download && a.href.indexOf("blob:") === 0) {
            fetch(a.href).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
              var dv = new DataView(buf), ifd = dv.getUint32(4, true), cnt = dv.getUint16(ifd, true), off = 0, bytesPer = 0;
              for (var k = 0; k < cnt; k++) {
                var e = ifd + 2 + k * 12, tag = dv.getUint16(e, true);
                if (tag === 273) off = dv.getUint32(e + 8, true);
                if (tag === 279) bytesPer = dv.getUint32(e + 8, true);
              }
              var pages = 0, next = ifd;
              while (next && pages < 10) { pages++; var c = dv.getUint16(next, true); next = dv.getUint32(next + 2 + c * 12, true); }
              var sum = 0, neg = 0;
              for (var p = off; p + 4 <= off + bytesPer * pages && p + 4 <= buf.byteLength; p += 4) { var x = dv.getFloat32(p, true); if (isFinite(x)) { sum += Math.abs(x); if (x < 0) neg++; } }
              window.__fourierDownloads.push({ name: a.download, bytes: Array.from(new Uint8Array(buf.slice(0, 200))), size: buf.byteLength, sum: sum, neg: neg, pages: pages });
            });
            return;
          }
          return orig.call(this);
        };
      })()
    `);

    console.log("\n[1] メニューから開く");
    await viewer.getByTestId("dim-slider-z").fill("10");
    await settle(viewer, 900);
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    await viewer.getByTestId("menu-fourier").click();
    await viewer.getByTestId("fourier-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await settle(viewer, 3000);
    const headerText = (await viewer.getByTestId("fourier-dialog").textContent()) ?? "";
    check(/スライス 11|slice 11/.test(headerText), "ヘッダに表示中スライス（11 枚目）が出る", headerText.slice(0, 200));
    const spec0 = await canvasGray(viewer, "fourier-spectrum");
    check(stdev(spec0) > 5, "スペクトルが描かれている", stdev(spec0));
    const src = await canvasGray(viewer, "fourier-source");
    const res0 = await canvasGray(viewer, "fourier-result");
    check(stdev(src) > 5, "原画像が描かれている", stdev(src));
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-open.png") });

    console.log("\n[2] フィルタなしの 2D-iDFT は原画像と一致する");
    const roundTrip = meanAbsDiff(src, res0);
    check(roundTrip < 1, "iDFT の見た目が原画像と一致（平均差 < 1 階調）", roundTrip);

    console.log("\n[3] 表示切替");
    await viewer.getByTestId("fourier-view-real").click();
    await settle(viewer);
    const specRe = await canvasGray(viewer, "fourier-spectrum");
    check(meanAbsDiff(spec0, specRe) > 0.5, "|Re| に切り替えると描画が変わる", meanAbsDiff(spec0, specRe));
    await viewer.getByTestId("fourier-view-imag").click();
    await settle(viewer);
    const specIm = await canvasGray(viewer, "fourier-spectrum");
    check(meanAbsDiff(specRe, specIm) > 0.5, "|Im| に切り替えると描画が変わる", meanAbsDiff(specRe, specIm));
    await viewer.getByTestId("fourier-view-mag").click();
    await viewer.getByTestId("fourier-log").uncheck();
    await settle(viewer);
    const specLin = await canvasGray(viewer, "fourier-spectrum");
    check(meanAbsDiff(spec0, specLin) > 0.5, "log を外すと描画が変わる", meanAbsDiff(spec0, specLin));
    await viewer.getByTestId("fourier-log").check();
    await viewer.getByTestId("fourier-swap").uncheck();
    await settle(viewer);
    const specUnswap = await canvasGray(viewer, "fourier-spectrum");
    check(meanAbsDiff(spec0, specUnswap) > 0.5, "四象限入れ替えを外すと描画が変わる", meanAbsDiff(spec0, specUnswap));
    // 中央（入れ替え後の DC）が明るく、入れ替え前は角が明るい。
    const w = Math.round(Math.sqrt(spec0.length));
    const center = (arr: number[]) => arr[Math.floor(w / 2) * w + Math.floor(w / 2)];
    check(center(spec0) > center(specUnswap), "入れ替え ON で DC（最も明るい）が中央に来る", { on: center(spec0), off: center(specUnswap) });
    await viewer.getByTestId("fourier-swap").check();
    await settle(viewer);

    console.log("\n[4] フィルタ");
    await viewer.getByTestId("fourier-filter-circle").click();
    await settle(viewer, 1200);
    const lp = await canvasGray(viewer, "fourier-result");
    check(meanAbsDiff(res0, lp) > 0.5, "円形 ∧（ローパス）で結果が変わる", meanAbsDiff(res0, lp));
    await setRange(viewer, "fourier-circle-radius", 8);
    await settle(viewer, 800);
    const lp8 = await canvasGray(viewer, "fourier-result");
    check(meanAbsDiff(lp, lp8) > 0.5, "半径を変えると結果が変わる", meanAbsDiff(lp, lp8));
    await viewer.screenshot({ path: path.join(OUT_DIR, "4a-circle-pass.png") });
    await viewer.getByTestId("fourier-circle-mode-stop").click();
    await settle(viewer, 1200);
    const hp = await canvasGray(viewer, "fourier-result");
    check(meanAbsDiff(lp8, hp) > 0.5, "!∧（ハイパス）に切り替えると結果が変わる", meanAbsDiff(lp8, hp));

    await viewer.getByTestId("fourier-sigma").fill("4");
    await settle(viewer, 1200);
    const hpSoft = await canvasGray(viewer, "fourier-result");
    check(meanAbsDiff(hp, hpSoft) > 0.2, "σ を上げると結果が変わる", meanAbsDiff(hp, hpSoft));
    await viewer.getByTestId("fourier-sigma").fill("0");

    await viewer.getByTestId("fourier-filter-donut").click();
    await settle(viewer, 1200);
    const donut = await canvasGray(viewer, "fourier-result");
    check(meanAbsDiff(hp, donut) > 0.5, "ドーナツに切り替えると結果が変わる", meanAbsDiff(hp, donut));
    await setRange(viewer, "fourier-donut-width", 40);
    await settle(viewer, 900);
    const donutW = await canvasGray(viewer, "fourier-result");
    check(meanAbsDiff(donut, donutW) > 0.2, "ドーナツの幅を変えると結果が変わる", meanAbsDiff(donut, donutW));
    await viewer.screenshot({ path: path.join(OUT_DIR, "4b-donut.png") });

    await viewer.getByTestId("fourier-filter-rect").click();
    await settle(viewer, 1200);
    const pos0 = Number(await viewer.getByTestId("fourier-rect-position-num").inputValue());
    // 帯の中心（DC から +pos0）を掴んで斜めにドラッグ → 位置だけが変わる。
    const box = (await viewer.getByTestId("fourier-spectrum-overlay").boundingBox())!;
    const nTxt = /→ (\d+)×/.exec(headerText);
    const n = nTxt ? Number(nTxt[1]) : 512;
    const toPx = (f: number) => ((f + n / 2 + 0.5) / n) * box.width;
    await viewer.mouse.move(box.x + toPx(pos0), box.y + box.height * 0.3);
    await viewer.mouse.down();
    await viewer.mouse.move(box.x + toPx(pos0 + 30), box.y + box.height * 0.7, { steps: 8 });
    await viewer.mouse.up();
    await settle(viewer, 1200);
    const pos1 = Number(await viewer.getByTestId("fourier-rect-position-num").inputValue());
    check(Math.abs(pos1 - (pos0 + 30)) <= 2, "縦モードの帯をドラッグすると x 方向の位置が動く", { pos0, pos1 });
    // はみ出さない: 右端の外まで引っ張っても、帯が画像の内側で止まる。
    const posMax = Number(await viewer.getByTestId("fourier-rect-position").getAttribute("max"));
    await viewer.mouse.move(box.x + toPx(pos1), box.y + box.height * 0.5);
    await viewer.mouse.down();
    await viewer.mouse.move(box.x + box.width + 80, box.y + box.height * 0.5, { steps: 8 });
    await viewer.mouse.up();
    await settle(viewer, 900);
    const posEdge = Number(await viewer.getByTestId("fourier-rect-position-num").inputValue());
    check(posEdge === posMax && posMax < n / 2 - 2, "🔴 画像の外まで引っ張っても帯は右端の内側で止まる", { posEdge, posMax, n });
    await viewer.screenshot({ path: path.join(OUT_DIR, "4c-rect-edge.png") });
    await viewer.mouse.move(box.x + toPx(posEdge), box.y + box.height * 0.5);
    await viewer.mouse.down();
    await viewer.mouse.move(box.x - 80, box.y + box.height * 0.5, { steps: 8 });
    await viewer.mouse.up();
    await settle(viewer, 900);
    const posEdgeL = Number(await viewer.getByTestId("fourier-rect-position-num").inputValue());
    check(posEdgeL === -posMax, "左端の外まで引っ張っても左端の内側で止まる", { posEdgeL, posMax });
    await setRange(viewer, "fourier-rect-width", 60);
    const posAfterWiden = Number(await viewer.getByTestId("fourier-rect-position-num").inputValue());
    const posMaxWide = Number(await viewer.getByTestId("fourier-rect-position").getAttribute("max"));
    check(Math.abs(posAfterWiden) <= posMaxWide && posMaxWide < posMax, "端で幅を広げても帯が内側へ収め直される", { posAfterWiden, posMaxWide });
    await setRange(viewer, "fourier-rect-width", 4);
    await setRange(viewer, "fourier-rect-position", 50);
    const rectRes = await canvasGray(viewer, "fourier-result");
    check(meanAbsDiff(donutW, rectRes) > 0.2, "長方形フィルタで結果が変わる", meanAbsDiff(donutW, rectRes));
    await viewer.screenshot({ path: path.join(OUT_DIR, "4c-rect.png") });
    await viewer.getByTestId("fourier-rect-horizontal").click();
    await settle(viewer, 1200);
    const rectH = await canvasGray(viewer, "fourier-result");
    check(meanAbsDiff(rectRes, rectH) > 0.2, "横モードに切り替えると結果が変わる", meanAbsDiff(rectRes, rectH));

    console.log("\n[5] 基底関数");
    await viewer.getByTestId("fourier-tab-basis").click();
    await settle(viewer, 900);
    const u0 = Number(await viewer.getByTestId("fourier-basis-u").inputValue());
    const v0 = Number(await viewer.getByTestId("fourier-basis-v").inputValue());
    check(u0 === n / 2 && v0 === n / 2, "初期の基底座標は DC（スペクトルの中央）", { u0, v0, n });
    // 十字線（オレンジ）が中央にある: SVG の縦線の x と横線の y が n/2 付近。
    const cross = (await viewer.evaluate(`
      (function () {
        var ls = document.querySelectorAll('[data-testid="fourier-spectrum-overlay"] g[stroke="#ffb020"] line');
        return ls.length >= 2 ? [Number(ls[0].getAttribute("x1")), Number(ls[1].getAttribute("y1"))] : null;
      })()
    `)) as [number, number] | null;
    check(!!cross && Math.abs(cross[0] - n / 2) <= 1 && Math.abs(cross[1] - n / 2) <= 1, "オレンジの十字線が中央に来る", cross);
    const b0 = await canvasGray(viewer, "fourier-basis");
    const slider = viewer.getByTestId("fourier-basis-slider");
    const idx0 = Number(await slider.inputValue());
    await slider.fill(String(idx0 + 3 * n + 5));
    await settle(viewer, 900);
    const b1 = await canvasGray(viewer, "fourier-basis");
    check(stdev(b1) > 5, "基底画像（縞）が描かれている", stdev(b1));
    check(meanAbsDiff(b0, b1) > 1, "スライダーを動かすと基底画像が変わる", meanAbsDiff(b0, b1));
    // スペクトルをクリック → u, v がその座標になる。
    // タブ切替でダイアログの高さが変わり中央寄せ位置がずれるので、枠を測り直す。
    const box2 = (await viewer.getByTestId("fourier-spectrum-overlay").boundingBox())!;
    await viewer.mouse.click(box2.x + toPx(-10), box2.y + toPx(7));
    await settle(viewer, 900);
    const cu = Number(await viewer.getByTestId("fourier-basis-u").inputValue());
    const cv = Number(await viewer.getByTestId("fourier-basis-v").inputValue());
    check(Math.abs(cu - (n / 2 - 10)) <= 1 && Math.abs(cv - (n / 2 + 7)) <= 1, "スペクトルをクリックした座標が u, v に入る", { cu, cv, n });
    const b2 = await canvasGray(viewer, "fourier-basis");
    await viewer.getByTestId("fourier-basis-weighted").check();
    await settle(viewer, 900);
    const dlgText = (await viewer.getByTestId("fourier-dialog").textContent()) ?? "";
    check(/\(-10, 7\)/.test(dlgText), "周波数 (-10, 7) が表示される", dlgText.match(/\([-\d]+, [-\d]+\)/)?.[0]);
    const b3 = await canvasGray(viewer, "fourier-basis");
    check(stdev(b3) > 5 && b2.length === b3.length, "重み付けでも基底画像が描かれる（位相で縞がずれる）", { sd: stdev(b3), diff: meanAbsDiff(b2, b3) });
    await viewer.screenshot({ path: path.join(OUT_DIR, "5-basis.png") });

    console.log("\n[6] 32-bit TIFF 書き出し");
    for (const id of ["fourier-export-real", "fourier-export-imag", "fourier-export-filtered", "fourier-export-basis", "fourier-export-complex"]) {
      await viewer.getByTestId(id).click();
    }
    await settle(viewer, 1500);
    const dl = (await viewer.evaluate(`window.__fourierDownloads`)) as { name: string; bytes: number[]; size: number; pages: number; neg: number }[];
    check(dl.length === 5, "5 つのボタンでそれぞれ書き出される", dl.map((x) => x.name));
    const stack = dl.find((x) => /_complex/.test(x.name));
    check(!!stack && stack.pages === 2, "🔴 Re・Im スタック（ImageJ Complex 形式）は 2 ページの TIFF", stack && { name: stack.name, pages: stack.pages });
    check(!!stack && stack.neg > 0, "🔴 Re・Im スタックは符号付き（負の値が残っている）", stack?.neg);
    const absRe = dl.find((x) => /re_abs/.test(x.name));
    check(!!absRe && absRe.neg === 0, "|Re| の絶対値ボタンは残っていて、負の値を含まない", absRe?.neg);
    for (const f of dl) {
      const b = Uint8Array.from(f.bytes);
      const dv = new DataView(b.buffer);
      const ok = b[0] === 0x49 && b[1] === 0x49 && dv.getUint16(2, true) === 42;
      let sf = -1;
      let bits = -1;
      const cnt = dv.getUint16(8, true);
      for (let i = 0; i < cnt; i++) {
        const p = 10 + i * 12;
        if (dv.getUint16(p, true) === 339) sf = dv.getUint16(p + 8, true);
        if (dv.getUint16(p, true) === 258) bits = dv.getUint16(p + 8, true);
      }
      check(ok && sf === 3 && bits === 32 && f.name.endsWith(".tif"), `${f.name} は 32-bit float TIFF`, { ok, sf, bits, size: f.size });
    }

    console.log("\n[6b] 書き出しは現在のフィルタ状態を反映する");
    await viewer.evaluate(`window.__fourierDownloads = []`);
    await viewer.getByTestId("fourier-tab-filter").click();
    await viewer.getByTestId("fourier-filter-circle").click();
    await viewer.getByTestId("fourier-circle-mode-pass").click();
    await setRange(viewer, "fourier-circle-radius", 20);
    await settle(viewer, 1200);
    check(await viewer.getByTestId("fourier-export-filtered-note").isVisible(), "フィルタ適用中は「フィルタ適用後を保存」と表示される");
    await viewer.getByTestId("fourier-export-real").click();
    await viewer.getByTestId("fourier-export-imag").click();
    await viewer.getByTestId("fourier-tab-basis").click();
    await settle(viewer, 500);
    // DC はローパスの内側（残る）、(−10,7) の外側の座標は落ちる。
    await viewer.getByTestId("fourier-basis-u").fill(String(n / 2 + 60));
    await viewer.getByTestId("fourier-basis-v").fill(String(n / 2));
    await settle(viewer, 900);
    const cutBasis = await canvasGray(viewer, "fourier-basis");
    check(stdev(cutBasis) < 1, "ローパスの外の座標は、重み付き基底が 0（フィルタで落ちている）", stdev(cutBasis));
    await viewer.getByTestId("fourier-export-basis").click();
    await viewer.getByTestId("fourier-tab-filter").click();
    await viewer.getByTestId("fourier-filter-none").click();
    await settle(viewer, 1200);
    check(!(await viewer.getByTestId("fourier-export-filtered-note").isVisible().catch(() => false)), "フィルタなしでは注記が消える");
    await viewer.getByTestId("fourier-export-real").click();
    await viewer.getByTestId("fourier-export-imag").click();
    await viewer.getByTestId("fourier-tab-basis").click();
    await settle(viewer, 900);
    await viewer.getByTestId("fourier-export-basis").click();
    await settle(viewer, 2000);
    const dl2 = (await viewer.evaluate(`window.__fourierDownloads`)) as { name: string; sum: number }[];
    console.log(`  ${dl2.map((x) => `${x.name.replace(/^.*_s11_/, "")}=${x.sum.toExponential(3)}`).join("  ")}`);
    const byName = (re: RegExp) => dl2.filter((x) => re.test(x.name));
    const [reF, reN] = [byName(/re_abs_filtered/)[0], byName(/re_abs_shifted/).find((x) => !/filtered/.test(x.name))];
    const [imF, imN] = [byName(/im_abs_filtered/)[0], byName(/im_abs_shifted/).find((x) => !/filtered/.test(x.name))];
    const [bF, bN] = [byName(/basis.*weighted_filtered/)[0], byName(/basis.*weighted\.tif$/)[0]];
    check(!!reF && !!reN && reF.sum < reN.sum * 0.9, "🔴 |Re| はフィルタ適用後が保存される（フィルタなしより小さい）", { f: reF?.sum, n: reN?.sum });
    check(!!imF && !!imN && imF.sum < imN.sum * 0.9, "🔴 |Im| はフィルタ適用後が保存される", { f: imF?.sum, n: imN?.sum });
    check(!!bF && !!bN && bF.sum === 0 && bN.sum > 0, "🔴 重み付き基底はフィルタで落ちた座標なら 0 で保存される", { f: bF?.sum, n: bN?.sum });

    console.log("\n[8] グラフ（動径平均スペクトル・ナイキスト）");
    await viewer.getByTestId("fourier-tab-graph").click();
    await settle(viewer, 1200);
    const graph0 = await canvasGray(viewer, "fourier-graph-canvas");
    check(stdev(graph0) > 3, "グラフが描かれている", stdev(graph0));
    const nyqAttr = (await viewer.getByTestId("fourier-graph-canvas").getAttribute("data-nyquist")) ?? "";
    const [nx, , unit] = nyqAttr.split("|");
    check(unit === "lp/mm" && Number(nx) > 0.3 && Number(nx) < 5, "🔴 PixelSpacing のある CT ではナイキストが lp/mm で出る", nyqAttr);
    const gbox = (await viewer.getByTestId("fourier-graph-canvas").boundingBox())!;
    await viewer.mouse.move(gbox.x + gbox.width * 0.4, gbox.y + gbox.height * 0.5);
    await settle(viewer, 400);
    const readout = (await viewer.getByTestId("fourier-graph-readout").textContent()) ?? "";
    check(/lp\/mm/.test(readout) && /cycles\/px/.test(readout) && /\|F\|/.test(readout), "ホバーで周波数（lp/mm と cycles/px）と |F| を読み出せる", readout);
    await viewer.screenshot({ path: path.join(OUT_DIR, "8a-graph.png") });
    await viewer.getByTestId("fourier-tab-filter").click();
    await viewer.getByTestId("fourier-filter-circle").click();
    await viewer.getByTestId("fourier-circle-mode-pass").click();
    await setRange(viewer, "fourier-circle-radius", 40);
    await settle(viewer, 1200);
    await viewer.getByTestId("fourier-tab-graph").click();
    await settle(viewer, 1200);
    const graphF = await canvasGray(viewer, "fourier-graph-canvas");
    const hasFilteredLegend = await viewer.getByText(/フィルタ適用後|^Filtered$/).first().isVisible().catch(() => false);
    check(meanAbsDiff(graph0, graphF) > 0.1 && hasFilteredLegend, "フィルタ ON でフィルタ後の曲線と凡例が増える", { diff: meanAbsDiff(graph0, graphF), hasFilteredLegend });
    await viewer.screenshot({ path: path.join(OUT_DIR, "8b-graph-filtered.png") });

    console.log("\n[9] 3D 波形分解");
    await viewer.getByTestId("fourier-tab-wave").click();
    await settle(viewer, 1500);
    const w0 = await canvasGray(viewer, "fourier-wave-canvas");
    check(stdev(w0) > 3, "3D ウォーターフォールが描かれている", stdev(w0));
    check(await viewer.getByTestId("fourier-wave-line-overlay").isVisible(), "原画像の上に対象ラインが出る");
    const rows0 = await viewer.locator('[data-testid="fourier-wave-row"]').count();
    check(rows0 === 9, "既定 K=8 で成分表が DC＋8 行", rows0);
    await setRange(viewer, "fourier-wave-k", 3);
    await settle(viewer, 800);
    const rows3 = await viewer.locator('[data-testid="fourier-wave-row"]').count();
    const w3 = await canvasGray(viewer, "fourier-wave-canvas");
    check(rows3 === 4 && meanAbsDiff(w0, w3) > 0.2, "K を 3 にすると表が 4 行になり描画も変わる", { rows3, diff: meanAbsDiff(w0, w3) });
    await setRange(viewer, "fourier-wave-index", 100);
    await settle(viewer, 800);
    const wIdx = await canvasGray(viewer, "fourier-wave-canvas");
    check(meanAbsDiff(w3, wIdx) > 0.2, "行番号を変えると描画が変わる", meanAbsDiff(w3, wIdx));
    // 原画像のクリックでライン選択（行モード: 縦位置 → 行番号）
    const ov = (await viewer.getByTestId("fourier-wave-line-overlay").boundingBox())!;
    await viewer.mouse.click(ov.x + ov.width * 0.5, ov.y + ov.height * 0.75);
    await settle(viewer, 800);
    const picked = Number(await viewer.getByTestId("fourier-wave-index-num").inputValue());
    check(Math.abs(picked - 384) <= 3, "原画像をクリックした高さの行が選ばれる（512 行の 3/4 ≈ 384）", picked);
    await viewer.getByTestId("fourier-wave-axis-col").click();
    await settle(viewer, 800);
    const wCol = await canvasGray(viewer, "fourier-wave-canvas");
    const colIdx = Number(await viewer.getByTestId("fourier-wave-index-num").inputValue());
    check(colIdx === 256 && meanAbsDiff(wIdx, wCol) > 0.2, "列モードに切り替えると中央の列になり描画が変わる", { colIdx });
    const view0 = await viewer.getByTestId("fourier-wave-canvas").getAttribute("data-view");
    const wb = (await viewer.getByTestId("fourier-wave-canvas").boundingBox())!;
    await viewer.mouse.move(wb.x + wb.width * 0.5, wb.y + wb.height * 0.5);
    await viewer.mouse.down();
    await viewer.mouse.move(wb.x + wb.width * 0.5 + 120, wb.y + wb.height * 0.5 + 40, { steps: 8 });
    await viewer.mouse.up();
    await settle(viewer, 600);
    const view1 = await viewer.getByTestId("fourier-wave-canvas").getAttribute("data-view");
    const wRot = await canvasGray(viewer, "fourier-wave-canvas");
    check(view0 !== view1 && meanAbsDiff(wCol, wRot) > 0.2, "🔴 ドラッグで回転し描画が変わる", { view0, view1 });
    await viewer.screenshot({ path: path.join(OUT_DIR, "9a-wave-rotated.png") });
    await viewer.getByTestId("fourier-wave-reset-view").click();
    await settle(viewer, 600);
    check((await viewer.getByTestId("fourier-wave-canvas").getAttribute("data-view")) === view0, "視点リセットで元の向きに戻る");
    await viewer.getByTestId("fourier-wave-target-result").click();
    await settle(viewer, 800);
    const wRes = await canvasGray(viewer, "fourier-wave-canvas");
    check(meanAbsDiff(wCol, wRes) > 0.2, "対象を逆変換結果（ローパス後）にすると描画が変わる", meanAbsDiff(wCol, wRes));
    await setRange(viewer, "fourier-wave-k", 12);
    await viewer.getByTestId("fourier-wave-axis-row").click();
    await viewer.getByTestId("fourier-wave-target-source").click();
    await settle(viewer, 1000);
    await viewer.screenshot({ path: path.join(OUT_DIR, "9b-wave.png") });

    console.log("\n[7] スライスを送って再取得");
    await viewer.getByTestId("fourier-close").click();
    await settle(viewer);
    check(!(await viewer.getByTestId("fourier-dialog").isVisible().catch(() => false)), "閉じるボタンで閉じる");
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    await viewer.getByTestId("menu-fourier").click();
    await viewer.getByTestId("fourier-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await settle(viewer, 2000);
    const before = await canvasGray(viewer, "fourier-source");
    // ダイアログの背後でスライスを送る（ダイアログ越しに Z スライダーへ値を入れる）。
    await viewer.getByTestId("dim-slider-z").fill("20");
    await settle(viewer, 900);
    await viewer.getByTestId("fourier-refetch").click();
    await settle(viewer, 2500);
    const hdr2 = (await viewer.getByTestId("fourier-dialog").textContent()) ?? "";
    check(/スライス 21|slice 21/.test(hdr2), "再取得でヘッダが 21 枚目になる", hdr2.slice(0, 200));
    const after = await canvasGray(viewer, "fourier-source");
    check(meanAbsDiff(before, after) > 0.5, "再取得で原画像が変わる", meanAbsDiff(before, after));
    await viewer.screenshot({ path: path.join(OUT_DIR, "7-refetch.png") });
  } finally {
    await d.stop();
  }
  console.log(`\n  結果: ${passed} ok / ${failures.length} fail`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

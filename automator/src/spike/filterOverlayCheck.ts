/*
 * フィルタ層（LoG の派生シリーズを色分けで重ねる）の実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/filterOverlayCheck.ts   （専用ポート 19880〜19882）
 *
 *   合成 CT（等方 1 mm・半径 2・4・6 mm の明るい円板）に LoG（r 2・3・4・6）を作り、2D ビューアの
 *   解析 ▸ フィルタ層を重ねる… で重ねる。判定は画面の画素（スクリーンショット）で行う。
 *   (1) 格子の違うシリーズは理由つきで断られ、層が増えない  (2) r 4 だけの層で、円板の中心の画素が層の色の方向に
 *   変わり、遠い背景（隅）は重ねる前と完全に同じ  (3) 層を隠すと元に戻る・符号を「正」にすると中心は色づかない
 *   (4) 3 層の凡例（色・r・σ・しきい値）と層ごとのカーソル値（API の同じ画素と一致）  (5) 4 本目は選べない。
 *
 * 前提: backend jar（今のビルド）・python3 と pydicom と PIL。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "filter-overlay-check");
const HERE = import.meta.dirname;

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

interface Synth {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  rows: number;
  centers: Record<string, [number, number]>;
  frames: { sopInstanceUid: string }[];
}
interface Created { scaleMm: number; sigmaMm: number; seriesInstanceUid: string; sopInstanceUids: string[] }
interface Job { jobId: string; state: string; result?: { series: Created[] }; error?: string }

function makeSynth(name: string, n: number, study?: string): Synth & { dir: string } {
  const dir = path.join(OUT_DIR, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const args = ["-I", path.join(HERE, "filterOverlaySynth.py"), dir, String(n), ...(study ? [study] : [])];
  const r = spawnSync(process.env.PYTHON ?? "python3", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  return { ...(JSON.parse(r.stdout) as Synth), dir };
}

async function api<T>(base: string, p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${p}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${p} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** フィルタ画像をスケールごとの派生シリーズとして作る（画面のダイアログと同じ API）。 */
async function makeLog(base: string, study: string, source: string, scales: number[]): Promise<Created[]> {
  let job = await api<Job>(base, "/api/series/filtered/jobs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      studyInstanceUid: study, sourceSeriesUid: source, channel: 0, timePoint: 0, scales,
      scaleNotation: "RADIUS_MM", scaleConversion: "SQRT_D", dimension: "2D", truncate: 4, padding: "MIRROR",
    }),
  });
  for (let i = 0; i < 600 && !["DONE", "FAILED", "CANCELLED"].includes(job.state); i++) {
    await new Promise((r) => setTimeout(r, 500));
    job = await api<Job>(base, `/api/series/filtered/jobs/${job.jobId}`);
  }
  if (job.state !== "DONE" || !job.result) throw new Error(`LoG の作成に失敗: ${job.state} ${job.error}`);
  return job.result.series;
}

/** 派生シリーズの 1 枚目の (行, 列) の値（Rescale を通した値）。API が返す DICOM ファイルを pydicom で読む。 */
async function storedValue(base: string, study: string, c: Created, row: number, col: number): Promise<number> {
  const f = path.join(OUT_DIR, `r${c.scaleMm}.dcm`);
  const res = await fetch(`${base}/api/studies/${study}/series/${c.seriesInstanceUid}/instances/${c.sopInstanceUids[0]}/file`);
  if (!res.ok) throw new Error(`instance file → HTTP ${res.status}`);
  fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
  const py = spawnSync(process.env.PYTHON ?? "python3", ["-I", "-c", `
import sys, pydicom
d = pydicom.dcmread(sys.argv[1]); a = d.pixel_array
print(float(a[int(sys.argv[2]), int(sys.argv[3])]) * float(d.RescaleSlope) + float(d.RescaleIntercept))
`, f, String(row), String(col)], { encoding: "utf8" });
  return Number(py.stdout.trim());
}

interface Pixels {
  size: [number, number];
  blobs: [number, number, number][];
  centre: { before: number[]; after: number[]; delta: number[] }[];
  changedTotal: number;
  cornersChanged: number[];
}
const pixels = (before: string, after: string): Pixels => {
  const r = spawnSync(process.env.PYTHON ?? "python3", ["-I", path.join(HERE, "filterOverlayPixels.py"), before, after], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`画素の判定に失敗: ${r.stderr}`);
  return JSON.parse(r.stdout) as Pixels;
};

async function setRange(page: Page, testId: string, value: number): Promise<void> {
  await page.getByTestId(testId).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const A = makeSynth("synthA", 64);
  const B = makeSynth("synthB", 48, A.studyInstanceUid); // 同じスタディの別の格子（行列が違う）
  const d = new DesktopDriver({ http: 19880, scp: 19881, vite: 19882 });
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  const study = A.studyInstanceUid;
  try {
    await resetDb(d.ports.http);
    await importPaths(d.ports.http, [A.dir]);
    const mainPage = d.page;
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await mainPage.waitForTimeout(2000);
    const later = mainPage.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) {
      await later.click();
      await mainPage.waitForTimeout(500);
    }
    await mainPage.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await openFirstSeriesInViewer(mainPage, createStepRecorder());
    const viewer = await d.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click({ timeout: 170_000 }),
      (url) => url.includes("2dviewer"),
      180_000,
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2000);
    viewer.on("console", (m) => { if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`); });

    console.log("\n[1] フィルタ画像を作る（元 A: 64×64 に r 2・3・4・6、別の格子 B: 48×48 に r 3）");
    await importPaths(d.ports.http, [B.dir]);
    const logA = await makeLog(base, study, A.seriesInstanceUid, [2, 3, 4, 6]);
    const logB = await makeLog(base, study, B.seriesInstanceUid, [3]);
    check(logA.length === 4 && logB.length === 1, "派生シリーズができる（A に 4 本、B に 1 本）");
    const bySc = new Map(logA.map((c) => [c.scaleMm, c]));
    check(Math.abs(bySc.get(4)!.sigmaMm - 4 / Math.SQRT2) < 1e-3, `r 4 の σ は r/√2 = ${bySc.get(4)!.sigmaMm}`);

    const host = viewer.getByTestId("viewer2d-canvas-host").first();
    const openDialog = async () => {
      await viewer.getByTestId("viewer2d-menu-analysis").click();
      await viewer.getByTestId("menu-filter-layers").click();
      const dlg = viewer.getByTestId("filter-layer-dialog");
      await dlg.waitFor({ state: "visible", timeout: 10_000 });
      await viewer.getByTestId(`filter-layer-cand-${logB[0].seriesInstanceUid}`).waitFor({ timeout: 30_000 });
      return dlg;
    };
    const pick = (dlg: ReturnType<Page["getByTestId"]>, uid: string) =>
      dlg.getByTestId(`filter-layer-cand-${uid}`).locator("input[type=checkbox]");

    console.log("\n[2] ダイアログ: 格子の違う B は断る");
    let dlg = await openDialog();
    const reason = await dlg.getByTestId(`filter-layer-reason-${logB[0].seriesInstanceUid}`).innerText();
    check(/行列の大きさが元と違います/.test(reason) && /64 × 64/.test(reason), "B の LoG は理由つきで断られる", reason);
    check(await pick(dlg, logB[0].seriesInstanceUid).isDisabled(), "B のチェックボックスは押せない（負例）");
    check(!(await pick(dlg, bySc.get(4)!.seriesInstanceUid).isDisabled()), "A の r 4 は選べる");
    await pick(dlg, bySc.get(4)!.seriesInstanceUid).check();
    await dlg.getByTestId("filter-layer-apply").click();
    await viewer.getByTestId("filter-layer-row-4").waitFor({ timeout: 30_000 });
    check((await viewer.locator('[data-testid^="filter-layer-row-"]').count()) === 1, "層は r 4 の 1 本だけ（B は増えない）");

    console.log("\n[3] r 4 の層だけ: 円板の中心の画素・隅・隠す・符号");
    await setRange(viewer, "filter-layer-opacity-4", 100);
    await viewer.mouse.move(2, 2);
    await viewer.waitForTimeout(800);
    const shot = async (name: string) => {
      await viewer.waitForTimeout(1200);
      const f = path.join(OUT_DIR, name);
      await host.screenshot({ path: f });
      return f;
    };
    await viewer.getByTestId("filter-layer-visible-4").uncheck();
    const before = await shot("before.png");
    await viewer.getByTestId("filter-layer-visible-4").check();
    const after = await shot("after-r4.png");
    const p = pixels(before, after);
    check(p.blobs.length === 3, "重ねる前の画面に円板が 3 つ見える", p.blobs);
    if (p.blobs.length === 3) {
      const [a2, a4, a6] = p.blobs.map((b) => b[2]);
      check(a2 < a4 && a4 < a6 && Math.abs(a4 / a2 - 4) < 1.2 && Math.abs(a6 / a2 - 9) < 2.5, "円板の面積比が 半径 2:4:6 の二乗（1:4:9）に近い", [a2, a4, a6]);
      const c = p.centre[1];
      check(c.delta[0] > c.delta[1] && c.delta[1] > 0 && c.delta[2] === 0,
        "r 4 の円板の中心の画素が、層の色（橙: R>G>0, B 不変）の方向に変わる", c);
      check(p.cornersChanged.every((n) => n === 0), "遠い背景（四隅）は重ねる前と完全に同じ", p.cornersChanged);
    }
    check(p.changedTotal > 0, "層の分だけ画素が変わる", p.changedTotal);
    await viewer.screenshot({ path: path.join(OUT_DIR, "01-r4-layer.png") });

    await viewer.getByTestId("filter-layer-visible-4").uncheck();
    const hidden = await shot("hidden.png");
    const ph = pixels(before, hidden);
    check(ph.changedTotal === 0, "層を隠すと重ねる前と画素が完全に一致する（負例）", ph.changedTotal);
    await viewer.getByTestId("filter-layer-visible-4").check();
    await viewer.getByTestId("filter-layer-side-4").selectOption("positive");
    const positive = await shot("positive.png");
    const pp = pixels(before, positive);
    check(pp.blobs.length === 3 && pp.centre[1].delta.every((v) => v === 0),
      "見せる側を「正」にすると、明るい円板の中心は色づかない（負例）", pp.centre[1]);
    check(pp.changedTotal > 0, "正の側では円板のまわりのリングが色づく", pp.changedTotal);
    await viewer.getByTestId("filter-layer-side-4").selectOption("negative");

    console.log("\n[4] 3 層の凡例とカーソル値（r 2・6 を足す。4 本目は選べない）");
    dlg = await openDialog();
    check(await pick(dlg, bySc.get(4)!.seriesInstanceUid).isDisabled(), "重ね済みの r 4 は選べない");
    await pick(dlg, bySc.get(2)!.seriesInstanceUid).check();
    await pick(dlg, bySc.get(3)!.seriesInstanceUid).check();
    check(await pick(dlg, bySc.get(6)!.seriesInstanceUid).isDisabled(), "3 本そろうと 4 本目（r 6）は選べない（負例）");
    await pick(dlg, bySc.get(3)!.seriesInstanceUid).uncheck();
    await pick(dlg, bySc.get(6)!.seriesInstanceUid).check();
    await dlg.getByTestId("filter-layer-apply").click();
    await viewer.getByTestId("filter-layer-row-6").waitFor({ timeout: 30_000 });
    check((await viewer.locator('[data-testid^="filter-layer-row-"]').count()) === 3, "層が 3 本になる");
    dlg = await openDialog();
    check((await dlg.locator("input[type=checkbox]:not([disabled])").count()) === 0, "3 本あるとダイアログでは何も選べない（負例）");
    await dlg.getByRole("button", { name: /キャンセル|Cancel/ }).click();

    const colors: Record<number, string> = { 4: "rgb(230, 159, 0)", 2: "rgb(86, 180, 233)", 6: "rgb(0, 158, 115)" };
    for (const [r, sigma] of [[2, 1.4142], [4, 2.8284], [6, 4.2426]] as const) {
      const legend = await viewer.getByTestId(`filter-layer-legend-${r}`).innerText();
      check(legend.includes(`r ${r} mm`) && legend.includes(`σ ${sigma} mm`), `凡例 r ${r}: ${legend}`);
      const bg = await viewer.getByTestId(`filter-layer-swatch-${r}`).evaluate((el) => getComputedStyle(el).backgroundColor);
      check(bg === colors[r], `r ${r} の色の見本が ${colors[r]}`, bg);
      check((await viewer.getByTestId(`filter-layer-threshold-${r}`).inputValue()) === "0", `r ${r} のしきい値の初期値は 0`);
    }
    await viewer.mouse.move(2, 2);
    for (const r of [2, 4, 6]) await setRange(viewer, `filter-layer-opacity-${r}`, 100);
    await viewer.mouse.move(2, 2);
    await shot("all3.png");
    await viewer.getByTestId("filter-layer-bar").screenshot({ path: path.join(OUT_DIR, "02-bar.png") });
    await viewer.screenshot({ path: path.join(OUT_DIR, "03-three-layers.png") });

    // カーソルを円板（r 4）の中心に置き、状態バーの層ごとの値を API の同じ画素の値と比べる
    const box = (await host.boundingBox())!;
    const mid = p.blobs[1];
    await viewer.mouse.move(box.x + mid[0], box.y + mid[1]);
    await viewer.waitForTimeout(800);
    const txt = await viewer.getByTestId("status-value-layers").innerText();
    const xy = await viewer.getByTestId("status-xy").innerText();
    console.log(`  状態バー: 層 = ${txt} / xy = ${xy}`);
    const [fx, fy] = xy.replace(/[^\d.,\-]/g, "").split(",").map(Number);
    const row = Math.round(fy), col = Math.round(fx);
    let bad = 0;
    for (const r of [2, 4, 6]) {
      const m = new RegExp(`r${r} (-?[\\d.]+)`).exec(txt);
      const want = await storedValue(base, study, bySc.get(r)!, row, col);
      const got = m ? Number(m[1]) : NaN;
      const ok = m != null && Math.abs(got - want) <= Math.max(0.02, Math.abs(want) * 0.02);
      if (!ok) bad++;
      console.log(`    r${r}: 画面 ${m?.[1]} / API ${want.toFixed(3)}（画素 行${row} 列${col}）`);
    }
    check(bad === 0, "層ごとのカーソル値が、API の同じ画素の値と一致", { txt, row, col });
    check(/r2 .* \/ r4 .* \/ r6 /.test(txt) || /r4 .* \/ r2 .* \/ r6 /.test(txt), "3 層ぶんの値が並ぶ", txt);

    console.log("\n[5] 層を外す");
    for (const r of [2, 4, 6]) await viewer.getByTestId(`filter-layer-remove-${r}`).click();
    check((await viewer.getByTestId("filter-layer-bar").count()) === 0, "全部外すとバーが消える");
    await viewer.mouse.move(box.x + mid[0] + 1, box.y + mid[1]);
    await viewer.waitForTimeout(500);
    check((await viewer.getByTestId("status-value-layers").count()) === 0, "層が無いと状態バーに層の値の項目は出ない");

    console.log(`\n合格 ${passed} ／ 失敗 ${failures.length}`);
  } finally {
    await d.stop();
  }
  if (failures.length > 0) {
    console.log(`失敗: ${failures.join(" / ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

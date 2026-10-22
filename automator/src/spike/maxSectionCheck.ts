/*
 * ROI の最大断面（TR-ROI-002）の実機検証スパイク。
 * 実行:  cd automator && npx tsx src/spike/maxSectionCheck.ts
 *   合成 CT＋SEG（スライスごとに前景の大きさが違う 2 セグメント）を取り込み、API と特徴量の画面の表示を突き合わせる。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "max-section-check");

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
  frameOfReferenceUID: string;
  rows: number;
  columns: number;
  pixelSpacing: number[];
  sliceThickness: number;
  frames: { sopInstanceUid: string; imagePositionPatient: number[] }[];
}

interface Row { column: string; family: string; feature: string; ibsi: string | null; value: number | null; notes: string[] }
interface Result {
  fromCache: boolean;
  computedAt: string;
  rows: Row[];
  provenance: { graphyNextVersion: string; radiomicsjVersion: string; extractedAt: string; settingsSha256: string };
  settingsProperties: string;
  roiSize: { initialVoxels: number; intensityVoxels: number; morphVoxels: number; volumeMm3: number;
    smallRoiWarnVoxels: number | null; smallRoi: boolean | null };
}


/** スライスごとの前景（縦×横）。z=5 の 15×15 が唯一の最大。 */
const SEG1: Record<number, [number, number]> = { 2: [10, 10], 3: [20, 10], 5: [15, 15], 7: [12, 12] };
/** 同面積（10×10）が z=4 と z=10 の 2 枚。 */
const SEG2: Record<number, [number, number]> = { 4: [10, 10], 10: [10, 10], 6: [5, 5] };

function frames(s: Synth, per: Record<number, [number, number]>) {
  return s.frames.map((f, z) => {
    const b = per[z];
    if (!b) return { ...f, mask: "" };
    const m = Buffer.alloc(s.rows * s.columns);
    for (let r = 5; r < 5 + b[0]; r++) for (let c = 5; c < 5 + b[1]; c++) m[r * s.columns + c] = 1;
    return { ...f, mask: m.toString("base64") };
  });
}

async function api<T>(base: string, p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${p}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${p} → HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dir = path.join(OUT_DIR, "synth");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(process.env.PYTHON ?? "python3", ["-I", path.join(import.meta.dirname, "roiFeatureSynth.py"), dir, "7"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  const synth = JSON.parse(r.stdout) as Synth;
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importPaths(d.ports.http, [dir]))}`);
    const seg = await api<{ seriesInstanceUid: string }>(base, "/api/dicom/seg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studyInstanceUid: synth.studyInstanceUid, seriesInstanceUid: synth.seriesInstanceUid,
        rows: synth.rows, columns: synth.columns, imageOrientationPatient: [1, 0, 0, 0, 1, 0],
        pixelSpacing: synth.pixelSpacing, sliceThickness: synth.sliceThickness,
        frameOfReferenceUID: synth.frameOfReferenceUID, seriesDescription: "max-section SEG",
        segments: [
          { number: 1, label: "Unique", color: [255, 0, 0], description: null, frames: frames(synth, SEG1) },
          { number: 2, label: "Tied", color: [0, 255, 0], description: null, frames: frames(synth, SEG2) },
        ],
        producer: null,
      }),
    });
    check(!!seg.seriesInstanceUid, "SEG ができる");

    const area = synth.pixelSpacing[0] * synth.pixelSpacing[1];
    const body = (ch: number) => ({
      studyInstanceUid: synth.studyInstanceUid, sourceSeriesUid: synth.seriesInstanceUid,
      maskSeriesUid: seg.seriesInstanceUid, maskChannel: ch, channel: 0, timePoint: 0, label: 1,
    });
    const post = (ch: number) => api<{ best: { sopInstanceUid: string; positionMm: number; pixels: number; areaMm2: number };
      ties: { positionMm: number }[]; totalSlices: number }>(base, "/api/radiomics/features/max-section", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body(ch)),
    });

    console.log("[1] API");
    const a1 = await post(0);
    const sop5 = synth.frames[5].sopInstanceUid;
    check(a1.best.pixels === 225, "最大断面は 15×15=225 画素", a1.best);
    check(Math.abs(a1.best.areaMm2 - 225 * area) < 1e-6, "面積 = 画素数 × 画素面積", { got: a1.best.areaMm2, want: 225 * area });
    check(Math.abs(a1.best.positionMm - synth.frames[5].imagePositionPatient[2]) < 0.001, "位置が IPP と一致", a1.best.positionMm);
    check(a1.best.sopInstanceUid === sop5, "SOP が z=5 のスライス");
    check(a1.totalSlices === 16, "全枚数 16", a1.totalSlices);
    const a2 = await post(1);
    check(a2.ties.length === 2, "セグメント 2 は同面積 2 枚", a2.ties);
    check(a2.best.pixels === 100, "セグメント 2 の最大は 100 画素", a2.best);
    const neg = await fetch(`${base}/api/radiomics/features/max-section`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body(0), maskSeriesUid: "" }),
    });
    check(neg.status === 400, "負例: マスク無しは 400", neg.status);

    console.log("[2] 画面");
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
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2000);
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    const page = await d.waitForNewPage(
      () => viewer.getByTestId("menu-roi-features").click(),
      (url) => url.includes("#radiomics-features"),
    );
    await page.getByTestId("roifeat-mask").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1500);
    check((await page.getByTestId("roifeat-maxsection").count()) === 0, "マスク未選択では表示しない（負例）");
    await page.getByTestId("roifeat-mask").selectOption(seg.seriesInstanceUid);
    const box = page.getByTestId("roifeat-maxsection");
    await box.waitFor({ state: "visible", timeout: 20_000 });
    const t1 = await box.innerText();
    const wantPos = (Math.round(synth.frames[5].imagePositionPatient[2] * 10) / 10).toFixed(1);
    check(t1.includes(`位置 ${wantPos} mm`) && t1.includes("全 16 枚中") && t1.includes("225 画素")
      && t1.includes((225 * area).toFixed(2)), "セグメント 1: 最大断面の行が API と一致", t1);
    check((await page.getByTestId("roifeat-maxsection-ties").count()) === 0, "単独のときは同面積の注記が出ない");
    await page.screenshot({ path: path.join(OUT_DIR, "01-unique.png"), fullPage: true });
    await page.locator("select").nth(2).selectOption({ index: 1 });
    await page.getByTestId("roifeat-maxsection-ties").waitFor({ state: "visible", timeout: 20_000 });
    const t2 = await box.innerText();
    check(/同面積のスライスが 2 枚/.test(t2) && t2.includes("100 画素"), "セグメント 2: 同面積 2 枚の注記", t2);
    await page.screenshot({ path: path.join(OUT_DIR, "02-ties.png"), fullPage: true });
  } finally {
    await d.stop();
  }
  console.log(`結果: ${passed} ok / ${failures.length} fail`);
  if (failures.length) {
    for (const f of failures) console.log(`   - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

#!/usr/bin/env node
// GRAPHY-Next Benchmark Phantom (GNBP-1)
// Copyright (C) 2026 Visionary Imaging Services, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
/**
 * GRAPHY-Next accuracy measurement against GNBP-1A.
 *
 * Answers the question a speed benchmark cannot: does the viewer measure
 * correctly? Two properties are checked, both against values that are known in
 * closed form rather than against another tool's output:
 *
 *   1. HU calibration — the value the viewer reports at a point must equal the
 *      value the phantom was built with. This is the check that catches a
 *      rescale slope/intercept applied twice, which shifts CT by about
 *      -1024 HU and is invisible unless something asserts the absolute value.
 *
 *   2. Coordinate mapping — the step-wedge bars have exact edges in patient
 *      millimetres. Scanning across one and finding where the reported HU
 *      changes tests the whole chain from patient coordinates to screen pixels
 *      and back, end to end.
 *
 * Neither check needs the application's ROI tools, so it exercises the same
 * read-out path a user relies on when hovering over an image.
 *
 * Usage:
 *   node measure_accuracy.mjs --url http://localhost:8099 --out results/accuracy.json
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

// Build identity, written by run_all.sh. Embedding it in every result file is
// what makes a number attributable to a specific commit and binary.
function readBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync("./results/build_info.json", "utf8"));
  } catch {
    return null;
  }
}

const args = {
  url: "http://localhost:8099",
  series: "GNBP-1A",
  truth: "./phantom/GNBP-1A_ground_truth.json",
  out: null,
  headed: true,
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const next = () => process.argv[++i];
  if (a === "--url") args.url = next();
  else if (a === "--series") args.series = next();
  else if (a === "--truth") args.truth = next();
  else if (a === "--out") args.out = next();
  else if (a === "--headless") args.headed = false;
  else throw new Error(`unknown argument: ${a}`);
}

const truth = JSON.parse(fs.readFileSync(args.truth, "utf8"));
const G = truth.geometry;
const PS = G.pixel_spacing_mm;
const IPP_X = -((G.columns - 1) / 2) * PS[0];
const IPP_Y = -((G.rows - 1) / 2) * PS[1];
const Z_ORIGIN = -((G.slices - 1) / 2) * G.slice_thickness_mm;

const mmToCol = (xMm) => (xMm - IPP_X) / PS[0];
const mmToRow = (yMm) => (yMm - IPP_Y) / PS[1];
const mmToSlice = (zMm) => Math.round((zMm - Z_ORIGIN) / G.slice_thickness_mm);

const parseXY = (s) => {
  const m = (s ?? "").match(/(-?[\d.]+)\s*,\s*(-?[\d.]+)/);
  return m ? { col: Number(m[1]), row: Number(m[2]) } : null;
};
const parseHU = (s) => {
  const m = (s ?? "").match(/(-?\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
};

const browser = await chromium.launch({ headless: !args.headed });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

async function openViewer() {
  await page.goto(args.url, { waitUntil: "domcontentloaded" });
  await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  const dates = page.locator('input[type="date"]');
  if ((await dates.count()) >= 2) {
    await dates.nth(0).fill("2000-01-01");
    await dates.nth(1).fill("2099-12-31");
  }
  await page.getByTestId("search-submit-button").click();

  const studies = page.locator('[data-testid^="study-row-"]');
  await studies.first().waitFor({ state: "visible", timeout: 60_000 });
  const n = await studies.count();
  let picked = false;
  for (let i = 0; i < n; i++) {
    if (((await studies.nth(i).textContent()) ?? "").includes(args.series)) {
      await studies.nth(i).click();
      picked = true;
      break;
    }
  }
  if (!picked) throw new Error(`study ${args.series} not found`);

  const rows = page.locator('[data-testid^="series-row-"]');
  await rows.first().waitFor({ state: "visible", timeout: 60_000 });
  await rows.first().click();
  await page.getByTestId("viewer2d-canvas-host").first().waitFor({ state: "visible", timeout: 60_000 });

  await page.getByTestId("viewer2d-toolbar-button").click();
  await page.waitForTimeout(2500);
  const vp = ctx.pages().find((p) => p !== page && p.url().includes("2dviewer")) ?? page;
  await vp.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
  await vp.waitForTimeout(3000);
  return vp;
}

const viewer = await openViewer();
const box = await viewer.getByTestId("viewer2d-canvas-host").first().boundingBox();

const readText = async (id) => {
  const el = viewer.getByTestId(id).first();
  return (await el.count()) ? (await el.textContent())?.replace(/\s+/g, " ").trim() : null;
};

async function hover(x, y) {
  await viewer.mouse.move(x, y);
  await viewer.waitForTimeout(120);
  return { xy: parseXY(await readText("status-xy")), hu: parseHU(await readText("status-value")) };
}

/**
 * Derive screen <-> image-pixel mapping from the viewer's own readout instead
 * of reconstructing the camera. Two points per axis are enough because the
 * transform is affine, and using the readout means the calibration cannot
 * disagree with what the viewer believes.
 */
async function calibrate() {
  const p1 = { x: Math.round(box.x + box.width * 0.3), y: Math.round(box.y + box.height * 0.3) };
  const p2 = { x: Math.round(box.x + box.width * 0.7), y: Math.round(box.y + box.height * 0.7) };
  const r1 = await hover(p1.x, p1.y);
  const r2 = await hover(p2.x, p2.y);
  if (!r1.xy || !r2.xy) throw new Error("could not read status-xy for calibration");
  const sx = (p2.x - p1.x) / (r2.xy.col - r1.xy.col);
  const sy = (p2.y - p1.y) / (r2.xy.row - r1.xy.row);
  return {
    screenX: (col) => Math.round(p1.x + (col - r1.xy.col) * sx),
    screenY: (row) => Math.round(p1.y + (row - r1.xy.row) * sy),
    screenPxPerImagePx: { x: sx, y: sy },
  };
}

const cal = await calibrate();

const slider = viewer.getByTestId("dim-slider-z").first();
async function gotoSlice(k) {
  await slider.evaluate((el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, String(value));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, k);
  await viewer.waitForTimeout(250);
}

// --- 1. HU accuracy at every target with a known value ----------------------
const huResults = [];
for (const t of truth.measurement_targets) {
  const [xMm, yMm, zMm] = t.center_mm;
  const k = mmToSlice(zMm ?? 0);
  if (k < 0 || k >= G.slices) continue;
  await gotoSlice(k);
  const sx = cal.screenX(mmToCol(xMm));
  const sy = cal.screenY(mmToRow(yMm));
  if (sx < box.x || sx > box.x + box.width || sy < box.y || sy > box.y + box.height) {
    huResults.push({ name: t.name, kind: t.kind, skipped: "outside the displayed area" });
    continue;
  }
  const r = await hover(sx, sy);
  huResults.push({
    name: t.name,
    kind: t.kind,
    slice: k,
    patient_mm: [xMm, yMm, zMm],
    expected_hu: t.expected_hu,
    reported_hu: r.hu,
    error_hu: r.hu === null ? null : r.hu - t.expected_hu,
    readout_col_row: r.xy,
  });
}

// --- 2. Coordinate mapping: where do the step-wedge edges actually fall? -----
// The bars are WEDGE_SIZE_MM wide, centred at a known x. Scanning across one
// and finding the HU transition gives the edge position the viewer implies.
const wedge = truth.step_wedge.find((b) => b.hu === 1000) ?? truth.step_wedge[truth.step_wedge.length - 1];
const wedgeY = wedge.center_mm[1];
const wedgeXc = wedge.center_mm[0];
const halfW = wedge.size_mm[0] / 2;

await gotoSlice(Math.round(G.slices / 2));
const scan = [];
for (let xMm = wedgeXc - halfW - 6; xMm <= wedgeXc + halfW + 6; xMm += 0.5) {
  const sx = cal.screenX(mmToCol(xMm));
  const sy = cal.screenY(mmToRow(wedgeY));
  if (sx < box.x || sx > box.x + box.width) continue;
  const r = await hover(sx, sy);
  scan.push({ x_mm: Number(xMm.toFixed(2)), hu: r.hu });
}

/**
 * Edge positions of the bar, taken as the midpoint of the half-millimetre
 * interval in which the reported HU changes. The bar's true edges are known
 * exactly, so the difference is the coordinate-mapping error.
 */
function findEdges(samples, targetHu) {
  let left = null;
  let right = null;
  for (let i = 1; i < samples.length; i++) {
    const was = samples[i - 1].hu;
    const now = samples[i].hu;
    if (was === null || now === null) continue;
    if (left === null && was !== targetHu && now === targetHu) {
      left = (samples[i - 1].x_mm + samples[i].x_mm) / 2;
    }
    if (was === targetHu && now !== targetHu) {
      right = (samples[i - 1].x_mm + samples[i].x_mm) / 2;
    }
  }
  return { left, right };
}

const { left: leftEdge, right: rightEdge } = findEdges(scan, wedge.hu);
const geometry = {
  bar_hu: wedge.hu,
  expected_left_edge_mm: wedgeXc - halfW,
  expected_right_edge_mm: wedgeXc + halfW,
  measured_left_edge_mm: leftEdge,
  measured_right_edge_mm: rightEdge,
  left_error_mm: leftEdge === null ? null : leftEdge - (wedgeXc - halfW),
  right_error_mm: rightEdge === null ? null : rightEdge - (wedgeXc + halfW),
  expected_width_mm: wedge.size_mm[0],
  measured_width_mm: leftEdge === null || rightEdge === null ? null : rightEdge - leftEdge,
};

const scored = huResults.filter((r) => typeof r.error_hu === "number");
// Round away float noise: the expected values come from a linear map applied in
// floating point, so an "error" of 1e-14 is arithmetic, not a discrepancy.
const absErrors = scored
  .map((r) => Math.abs(Number(r.error_hu.toFixed(6))))
  .sort((a, b) => a - b);
const record = {
  phantom: truth.phantom,
  phantom_version: truth.version,
  series_md5: truth.series_md5,
  url: args.url,
  browser: browser.version(),
  build_info: readBuildInfo(),
  calibration: cal.screenPxPerImagePx,
  window_level: await readText("status-wl"),
  hu_accuracy: {
    targets: huResults,
    n_scored: scored.length,
    max_abs_error_hu: absErrors.length ? absErrors[absErrors.length - 1] : null,
    median_abs_error_hu: absErrors.length ? absErrors[Math.floor(absErrors.length / 2)] : null,
    all_exact: absErrors.length > 0 && absErrors[absErrors.length - 1] === 0,
    note: "errors are rounded to 1e-6 HU before comparison; the expected values are produced by a floating-point linear map",
  },
  coordinate_mapping: geometry,
  scan_samples: scan,
};

const json = JSON.stringify(record, null, 2);
if (args.out) {
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, json);
  process.stderr.write(`wrote ${args.out}\n`);
}
console.log(json);
await browser.close();

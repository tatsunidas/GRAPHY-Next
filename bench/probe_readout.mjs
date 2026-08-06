#!/usr/bin/env node
// GRAPHY-Next Benchmark Phantom (GNBP-1)
// Copyright (C) 2026 Visionary Imaging Services, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
/**
 * One-off probe: what do the 2D viewer's status readouts actually contain?
 *
 * The accuracy measurement needs to turn a patient coordinate (mm, known from
 * the phantom's ground truth) into a screen position, and to read back the HU
 * the viewer reports there. Both depend on the exact text format of
 * `status-xy` and `status-value`, which is what this script records.
 */
import { chromium } from "playwright";

const URL = process.env.GRAPHY_URL ?? "http://localhost:8099";
const SERIES = process.env.GRAPHY_SERIES ?? "GNBP-1A";

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
const dates = page.locator('input[type="date"]');
await dates.nth(0).fill("2000-01-01");
await dates.nth(1).fill("2099-12-31");
await page.getByTestId("search-submit-button").click();

const studies = page.locator('[data-testid^="study-row-"]');
await studies.first().waitFor({ state: "visible", timeout: 60_000 });
const n = await studies.count();
for (let i = 0; i < n; i++) {
  if (((await studies.nth(i).textContent()) ?? "").includes(SERIES)) { await studies.nth(i).click(); break; }
}
const rows = page.locator('[data-testid^="series-row-"]');
await rows.first().waitFor({ state: "visible", timeout: 60_000 });
await rows.first().click();
await page.getByTestId("viewer2d-canvas-host").first().waitFor({ state: "visible", timeout: 60_000 });

await page.getByTestId("viewer2d-toolbar-button").click();
await page.waitForTimeout(2500);
const viewer = ctx.pages().find((p) => p !== page && p.url().includes("2dviewer")) ?? page;
await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
await viewer.waitForTimeout(3000);

const box = await viewer.getByTestId("viewer2d-canvas-host").first().boundingBox();
console.log("canvas host box:", JSON.stringify(box));

const read = async () => {
  const get = async (id) => {
    const el = viewer.getByTestId(id).first();
    return (await el.count()) ? (await el.textContent())?.replace(/\s+/g, " ").trim() : null;
  };
  return {
    xy: await get("status-xy"),
    value: await get("status-value"),
    wl: await get("status-wl"),
    zoom: await get("status-zoom"),
    scaleBar: await get("scale-bar"),
    tl: await get("corner-text-tl"),
    tr: await get("corner-text-tr"),
  };
};

// Sample a small grid so the screen -> image mapping can be derived from the
// readouts themselves rather than guessed from the camera.
const pts = [
  [0.30, 0.30], [0.50, 0.30], [0.70, 0.30],
  [0.30, 0.50], [0.50, 0.50], [0.70, 0.50],
  [0.30, 0.70], [0.50, 0.70], [0.70, 0.70],
];
for (const [fx, fy] of pts) {
  const x = Math.round(box.x + box.width * fx);
  const y = Math.round(box.y + box.height * fy);
  await viewer.mouse.move(x, y);
  await viewer.waitForTimeout(180);
  console.log(`screen(${x},${y}) ->`, JSON.stringify(await read()));
}

const slider = viewer.getByTestId("dim-slider-z").first();
if (await slider.count()) {
  console.log("z slider:", JSON.stringify({
    tag: await slider.evaluate((el) => el.tagName),
    type: await slider.evaluate((el) => el.getAttribute("type")),
    min: await slider.evaluate((el) => el.getAttribute("min")),
    max: await slider.evaluate((el) => el.getAttribute("max")),
    value: await slider.evaluate((el) => el.value ?? null),
  }));
}

await viewer.screenshot({ path: "./shots/readout-probe.png" });
await browser.close();

// GRAPHY-Next Benchmark Phantom (GNBP-1)
// Copyright (C) 2026 Visionary Imaging Services, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
import { chromium } from "playwright";
const URL = "http://localhost:8099";
const b = await chromium.launch({ headless: false });
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.getByTestId("search-patientid-input").waitFor({ timeout: 60000 });
const d = page.locator('input[type="date"]');
await d.nth(0).fill("2000-01-01"); await d.nth(1).fill("2099-12-31");
await page.getByTestId("search-submit-button").click();
const st = page.locator('[data-testid^="study-row-"]');
await st.first().waitFor({ timeout: 60000 });
const n = await st.count();
for (let i = 0; i < n; i++) if (((await st.nth(i).textContent()) ?? "").includes("GNBP-1B_256")) { await st.nth(i).click(); break; }
const rows = page.locator('[data-testid^="series-row-"]');
await rows.first().waitFor({ timeout: 60000 }); await rows.first().click();
await page.getByTestId("viewer2d-canvas-host").first().waitFor({ timeout: 60000 });

async function dumpMenus(p, prefix, ids) {
  for (const m of ids) {
    const btn = p.getByTestId(`${prefix}-${m}`);
    if (!(await btn.count())) continue;
    await btn.click(); await p.waitForTimeout(400);
    const dd = btn.locator("xpath=following-sibling::div").first();
    const items = [];
    if (await dd.count()) {
      const bs = dd.locator("button");
      for (let i = 0; i < await bs.count(); i++) {
        items.push({ text: ((await bs.nth(i).textContent()) || "").trim().slice(0, 36),
                     testid: await bs.nth(i).getAttribute("data-testid") });
      }
    }
    console.log(`${prefix}/${m}:`, JSON.stringify(items));
    await p.keyboard.press("Escape"); await p.waitForTimeout(200);
  }
}
await dumpMenus(page, "mainscreen-menu", ["file","image","function","plugins","system","help"]);

await page.getByTestId("viewer2d-toolbar-button").click();
await page.waitForTimeout(2500);
const vp = ctx.pages().find(p => p !== page && p.url().includes("2dviewer")) ?? page;
await vp.getByTestId("series-viewer-root").first().waitFor({ timeout: 60000 });
await vp.waitForTimeout(2000);
await dumpMenus(vp, "viewer2d-menu", ["file","view","image","tools","roi","roiTools","analysis","plugins","system","help"]);
await b.close();

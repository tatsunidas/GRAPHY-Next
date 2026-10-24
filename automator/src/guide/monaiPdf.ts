/*
 * docs/user-guides/monai/guide.html を 1920×1080 のページで PDF にする → docs/user-guides/monai.pdf
 * 画面は monaiShots.ts で撮る。実行:  cd automator && npx tsx src/guide/monaiPdf.ts
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const DIR = path.resolve(AUTOMATOR_ROOT, "..", "docs", "user-guides");
const html = path.join(DIR, "monai", "guide.html");
if (!fs.existsSync(html)) throw new Error(`本文がありません: ${html}`);
const out = path.join(DIR, "monai.pdf");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(pathToFileURL(html).href, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: out, width: "1920px", height: "1080px", printBackground: true });
} finally {
  await browser.close();
}
console.log(`PDF: ${path.relative(process.cwd(), out)}`);

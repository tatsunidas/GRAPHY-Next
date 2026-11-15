/*
 * docs/user-guides/setup/guide.html を 1920×1080 のページで PDF にする → docs/user-guides/setup.pdf
 * 画面は setupShots.ts で撮る。実行:  cd automator && npx tsx src/guide/setupPdf.ts
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const DIR = path.resolve(AUTOMATOR_ROOT, "..", "docs", "user-guides");
const html = path.join(DIR, "setup", "guide.html");
if (!fs.existsSync(html)) throw new Error(`本文がありません: ${html}`);
const out = path.join(DIR, "setup.pdf");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(pathToFileURL(html).href, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  // はみ出し（ページの下端を越えた要素）を数える。0 でなければ本文を詰める。
  const overflow = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".page")).map((p, i) => {
      const limit = p.getBoundingClientRect().bottom - 96;
      let worst = 0;
      Array.from(p.querySelectorAll("*")).forEach((e) => {
        if (e.closest(".footer")) return;
        worst = Math.max(worst, e.getBoundingClientRect().bottom - limit);
      });
      return { page: i + 1, over: Math.round(worst) };
    }).filter((x) => x.over > 0));
  console.log(overflow.length ? `はみ出し: ${JSON.stringify(overflow)}` : "はみ出し: なし");
  await page.pdf({ path: out, width: "1920px", height: "1080px", printBackground: true });
} finally {
  await browser.close();
}
console.log(`PDF: ${path.relative(process.cwd(), out)}`);

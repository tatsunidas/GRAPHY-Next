// Export した媒体の全シリーズを順に開き、枚数表示と描画（画素）を確かめる。
//   PORTABLE_MEDIA=<媒体のルート> npx tsx src/spike/portableSeriesCheck.ts
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "@playwright/test";

const MEDIA = process.env.PORTABLE_MEDIA!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (ok: boolean, name: string, d?: unknown) => {
  if (!ok) fail++;
  console.log(`  ${ok ? "合格" : "失敗"}  ${name}${ok || d === undefined ? "" : "  → " + JSON.stringify(d)}`);
};
const proc = spawn(`"${path.join(MEDIA, "START-VIEWER.bat")}"`, [], { cwd: MEDIA, env: { ...process.env, GRAPHY_VIEWER_NO_BROWSER: "1", GRAPHY_VIEWER_IDLE_SECONDS: "20" }, shell: true, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
proc.stdout?.on("data", (d: Buffer) => (out += d.toString()));
let url = "";
for (let i = 0; i < 300 && !url; i++) { const m = out.match(/VIEWER_URL=(\S+)/); if (m) url = m[1]; else await sleep(200); }
const b = await chromium.launch({ channel: "chrome", headless: true });
try {
  const helper = await b.newPage();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs: string[] = [];
  p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
  p.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 200)));
  await p.goto(url);
  await p.waitForSelector(".pv-card");
  const n = await p.locator(".pv-card").count();
  console.log(`シリーズ ${n} 件`);
  for (let i = 0; i < n; i++) {
    const card = p.locator(".pv-card").nth(i);
    const label = ((await card.innerText()) || "").replace(/\s+/g, " ").slice(0, 60);
    const expected = Number((/(\d+)\s*(枚|images)/.exec(label) ?? [])[1]);
    await card.click();
    await sleep(3500);
    const pos = (await p.locator(".pv-pos:not(.pv-tpos)").textContent())?.trim() ?? "";
    const measure = async () => {
      const png = await p.locator('[data-pv-tile="0"]').screenshot();
      return helper.evaluate(async (b64) => {
        const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        const g = c.getContext("2d")!; g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data; let k = 0;
        for (let j = 0; j < d.length; j += 4) if (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2] > 100) k++;
        return k / (d.length / 4);
      }, png.toString("base64"));
    };
    let lit = await measure();
    // 端のスライスは空白（穴）や空気だけのことがある。真ん中の位置も見て、最大を採る。
    const total0 = Number((/\/\s*(\d+)/.exec(pos) ?? [])[1]);
    if (lit <= 0.005 && total0 > 2) {
      await p.locator(".pv-slider").first().fill(String(Math.floor(total0 / 2)));
      await sleep(2500);
      lit = Math.max(lit, await measure());
    }
    console.log(`- [${i}] ${label} | 位置表示 ${pos} | 明るい画素 ${(lit * 100).toFixed(1)}%`);
    const total = Number((/\/\s*(\d+)/.exec(pos) ?? [])[1]);
    check(Number.isFinite(total) && total >= 1, `シリーズ ${i}: 位置表示が出る`, pos);
    check(lit > 0.005, `シリーズ ${i}: 画像が描かれている`, lit);
    if (Number.isFinite(expected) && expected > 1 && total !== expected) console.log(`    （カードの枚数 ${expected} と位置表示の総数 ${total} が違う: マルチフレームなら想定内）`);
    await p.screenshot({ path: `C:/Users/t_kob/pvtest/app-out/series-${i}.png` });
  }
  check(errs.length === 0, "エラーが出ていない", errs.slice(0, 4));
} finally {
  await b.close();
  if (proc.pid) spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
}
process.exit(fail ? 1 : 0);

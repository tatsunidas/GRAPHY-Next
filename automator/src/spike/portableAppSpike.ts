// 段 2 の試作確認: 新しい React 版ポータブルビューアを、起動スクリプト経由で実 Chrome に開いて描画を見る。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const MEDIA = process.env.PORTABLE_MEDIA!;
const OUT = process.env.PORTABLE_OUT ?? "C:/Users/t_kob/pvtest/app-out";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env, GRAPHY_VIEWER_NO_BROWSER: "1", GRAPHY_VIEWER_IDLE_SECONDS: "600" };
const proc = spawn(`"${path.join(MEDIA, "START-VIEWER.bat")}"`, [], { cwd: MEDIA, env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
proc.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
let url = "";
for (let i = 0; i < 300 && !url; i++) {
  const m = out.match(/VIEWER_URL=(\S+)/);
  if (m) url = m[1]; else await sleep(200);
}
if (!url) throw new Error("no url: " + out);
console.log("url", url.replace(/\/[0-9a-f]{32}\//, "/<token>/"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const logs: string[] = [];
  page.on("console", (m) => ["error", "warning"].includes(m.type()) && logs.push(`${m.type()}: ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => logs.push("pageerror " + String(e).slice(0, 400)));
  page.on("response", (r) => r.status() >= 400 && logs.push(`HTTP ${r.status()} ${r.url().replace(/[0-9a-f]{32}/, "<t>").slice(0, 140)}`));
  page.on("requestfailed", (r) => logs.push("reqfailed " + r.url().slice(0, 120)));
  await page.goto(url + (process.env.PORTABLE_QUERY ?? ""));
  await sleep(12000);
  await page.screenshot({ path: path.join(OUT, process.env.PORTABLE_SHOT ?? "spike.png") });
  console.log("canvases", await page.locator("canvas").count());
  console.log(logs.slice(0, 30).join("\n"));
} finally {
  await browser.close();
  if (proc.pid) spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
}

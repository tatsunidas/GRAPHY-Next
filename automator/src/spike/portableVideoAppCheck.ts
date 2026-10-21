// 動画つき媒体: 動画シリーズが一覧に出て、同梱の MP4 が再生される（実 Google Chrome）。
//   PORTABLE_MEDIA=<動画つき媒体のルート> npx tsx src/spike/portableVideoAppCheck.ts
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
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs: string[] = [];
  p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
  p.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 200) + " @" + (m.location().url ?? "")));
  await p.goto(url);
  await p.waitForSelector(".pv-card");
  check((await p.locator(".pv-card").count()) === 1, "動画シリーズが一覧に出ている");
  check((await p.locator(".pv-card").innerText()).includes("XC"), "モダリティが出ている");
  await p.locator(".pv-card").click();
  await sleep(1500);
  const v = p.locator("video");
  check((await v.count()) === 1, "<video> が出ている");
  const meta = await v.evaluate((el: HTMLVideoElement) => ({ dur: el.duration, w: el.videoWidth, h: el.videoHeight, err: el.error?.code ?? null }));
  check(meta.err === null && meta.dur > 3 && meta.w === 320 && meta.h === 240, "メタデータが読める（長さ・解像度）", meta);
  await v.evaluate((el: HTMLVideoElement) => el.play());
  await sleep(1500);
  const t = await v.evaluate((el: HTMLVideoElement) => el.currentTime);
  check(t > 0.5, "再生が進む（デコードできている）", t);
  await p.screenshot({ path: "C:/Users/t_kob/pvtest/app-out/video.png" });
  const real = errs.filter((e) => !/favicon|__ping|VIEWER\/(layouts|blanks)\.json/.test(e));
  check(real.length === 0, "エラーが出ていない", real.slice(0, 4));
} finally {
  await b.close();
  if (proc.pid) spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
}
process.exit(fail ? 1 : 0);

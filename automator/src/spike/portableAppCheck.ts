// 新しいポータブル 2D ビューア（React 版）の通し検査。
// 実 Export が書いた媒体（VIEWER/ を新ビルドへ差し替え済みのもの）を、起動スクリプト経由で実 Google Chrome に開く。
//   PORTABLE_MEDIA=<媒体のルート> npx tsx src/spike/portableAppCheck.ts
// 合格／失敗を数え、失敗があれば終了コード 1。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";

const MEDIA = process.env.PORTABLE_MEDIA!;
const OUT = process.env.PORTABLE_OUT ?? "C:/Users/t_kob/pvtest/app-out";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(ok: boolean, name: string, detail?: unknown): void {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "合格" : "失敗"}  ${name}${detail !== undefined && !ok ? "  → " + JSON.stringify(detail) : ""}`);
}

async function counter(page: Page): Promise<string> {
  return ((await page.locator(".pv-pos").textContent()) ?? "").trim();
}

/** タイルの画像領域のスクリーンショットで、明るい画素の割合を数える。 */
async function lit(page: Page, helper: Page, tile: number): Promise<number> {
  const png = await page.locator(`[data-pv-tile="${tile}"]`).screenshot();
  return helper.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > 100) n++;
    return n / (d.length / 4);
  }, png.toString("base64"));
}

const env = { ...process.env, GRAPHY_VIEWER_NO_BROWSER: "1", GRAPHY_VIEWER_IDLE_SECONDS: "600" };
const proc = spawn(`"${path.join(MEDIA, "START-VIEWER.bat")}"`, [], { cwd: MEDIA, env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
proc.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
let url = "";
for (let i = 0; i < 300 && !url; i++) {
  const m = out.match(/VIEWER_URL=(\S+)/);
  if (m) url = m[1];
  else await sleep(200);
}
if (!url) throw new Error("起動スクリプトが URL を出さなかった: " + out.slice(0, 300));

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  console.log(`Chrome ${browser.version()}（フラグなし）`);
  const helper = await browser.newPage();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200) + " @" + (m.location().url ?? "").replace(/[0-9a-f]{32}/, "<t>").slice(0, 100)));
  page.on("pageerror", (e) => errors.push("pageerror " + String(e).slice(0, 200)));
  page.on("response", (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url().replace(/[0-9a-f]{32}/, "<t>").slice(0, 120)}`));

  console.log("\n[1] 自動認識と起動");
  await page.goto(url);
  await page.waitForSelector(".pv-card", { timeout: 60_000 });
  check((await page.locator(".pv-card").count()) === 2, "シリーズが 2 件、一覧に出ている（フォルダ選択なし）", await page.locator(".pv-card").count());
  check((await page.locator("#boot-guide").count()) === 0, "file:// 用の案内が消えている");
  await page.waitForFunction(() => /\d+ \/ \d+/.test(document.querySelector(".pv-pos")?.textContent ?? ""), null, { timeout: 60_000 });
  check((await counter(page)) === "1 / 9", "先頭の CT が自動で開き、枚数が 9 枚", await counter(page));
  check((await page.locator(".pv-card[aria-current=true]").count()) === 1, "開いているシリーズのカードが強調されている");
  await sleep(1500);
  check((await lit(page, helper, 0)) > 0.05, "CT の画像が描かれている（黒一色ではない）");
  await page.screenshot({ path: path.join(OUT, "check-1.png") });
  const thumbs = await page.locator(".pv-thumb canvas").evaluateAll((cs) => cs.map((c) => (c as HTMLCanvasElement).width));
  check(thumbs.length === 2 && thumbs.every((w) => w > 0), "サムネイルが 2 枚出ている", thumbs);

  console.log("\n[2] スライス送り・シネ（PT 21 枚）");
  await page.locator(".pv-card").nth(1).click();
  await page.waitForFunction(() => document.querySelector(".pv-pos")?.textContent?.includes("/ 21"), null, { timeout: 30_000 });
  check((await counter(page)) === "1 / 21", "PT を開くと 1 / 21", await counter(page));
  await sleep(1200);
  const tileBox = (await page.locator('[data-pv-tile="0"]').boundingBox())!;
  const cx = tileBox.x + tileBox.width / 2;
  const cy = tileBox.y + tileBox.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, 300);
  await sleep(600);
  const afterWheel = await counter(page);
  check(afterWheel !== "1 / 21", "ホイールでスライスが進む", afterWheel);
  await page.locator(".pv-slider").fill("10");
  await sleep(500);
  check((await counter(page)) === "11 / 21", "スライダーを 10 にすると 11 / 21", await counter(page));
  const before = await counter(page);
  await page.keyboard.press("Space");
  await sleep(1200);
  const playing = await counter(page);
  check(playing !== before, "Space で再生され、位置が進む", { before, playing });
  await page.keyboard.press("Space");
  await sleep(300);
  const stopped1 = await counter(page);
  await sleep(700);
  check((await counter(page)) === stopped1, "もう一度 Space で停止し、位置が止まる", stopped1);

  console.log("\n[3] W/L・表示（CT へ戻って）");
  await page.locator(".pv-card").nth(0).click();
  await page.waitForFunction(() => document.querySelector(".pv-pos")?.textContent?.includes("/ 9"), null, { timeout: 30_000 });
  await sleep(1200);
  await page.getByRole("button", { name: "軟部" }).click();
  await sleep(800);
  const ww = await page.getByLabel("WW").inputValue();
  const wl = await page.getByLabel("WL").inputValue();
  check(ww === "400" && wl === "40", "プリセット『軟部』で W 400 / L 40 になる", { ww, wl });
  await page.getByLabel("WW").fill("80");
  await page.getByLabel("WW").press("Enter");
  await sleep(800);
  check((await page.getByLabel("WW").inputValue()) === "80", "W を入力して適用できる", await page.getByLabel("WW").inputValue());
  await page.getByRole("button", { name: "そのほかの表示" }).click();
  await page.getByRole("menuitem", { name: /白黒反転/ }).click();
  await sleep(800);
  check((await page.getByRole("menuitem", { name: /白黒反転/ }).getAttribute("aria-pressed")) === "true", "白黒反転が効く（状態が反映される）");
  await page.keyboard.press("Escape");

  console.log("\n[4] 計測（長さ）");
  await page.locator(".pv-card").nth(1).click();
  await page.waitForFunction(() => document.querySelector(".pv-pos")?.textContent?.includes("/ 21"), null, { timeout: 30_000 });
  await sleep(1500);
  await page.getByRole("button", { name: /^長さ/ }).click();
  check((await page.getByRole("button", { name: /^長さ/ }).getAttribute("aria-pressed")) === "true", "長さツールが選ばれる");
  await sleep(800);
  await page.mouse.move(cx - 120, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy, { steps: 6 });
  await page.mouse.move(cx + 120, cy, { steps: 6 });
  await page.mouse.up();
  await sleep(800);
  const texts = await page.locator('[data-pv-tile="0"] svg text').allTextContents();
  check(texts.some((t) => /mm/.test(t)), "長さの値（mm）が画像上に出る", texts);
  await page.screenshot({ path: path.join(OUT, "check-measure.png") });

  console.log("\n[5] 分割と同期");
  await page.getByRole("button", { name: "2×2" }).click();
  await sleep(2500);
  check((await page.locator("[data-pv-tile]").count()) === 4, "2×2 で 4 タイルになる");
  check((await page.locator(".pv-empty").count()) === 2, "シリーズ 2 件が入り、残り 2 タイルは空き表示", await page.locator(".pv-empty").count());
  check((await page.getByRole("button", { name: /同期|Sync/ }).isEnabled()), "分割すると『同期』が使える");
  await page.screenshot({ path: path.join(OUT, "check-2x2.png") });
  const card0 = page.locator(".pv-card").nth(0);
  await card0.dragTo(page.locator('[data-pv-tile="3"]'));
  await sleep(2000);
  check((await page.locator(".pv-empty").count()) === 1, "カードをタイルへドラッグして開ける", await page.locator(".pv-empty").count());
  await page.getByRole("button", { name: "1×1" }).click();
  await sleep(1000);
  check((await page.locator("[data-pv-tile]").count()) === 1, "1×1 へ戻せる");

  console.log("\n[6] 言語・案内");
  await page.getByRole("button", { name: "EN", exact: true }).click();
  check((await page.locator(".pv-brand span").textContent()) === "Viewer", "EN にすると表示が英語になる", await page.locator(".pv-brand span").textContent());
  await page.getByRole("button", { name: "日本語" }).click();
  await page.keyboard.press("?");
  check((await page.getByRole("dialog").count()) === 1, "? で操作の案内が開く");
  await page.keyboard.press("Escape");

  const real = errors.filter((e) => !/favicon|__ping/.test(e));
  console.log("\n[7] 負例");
  const filePage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const fileUrl = "file:///" + path.join(MEDIA, "VIEWER", "index.html").replace(/\\/g, "/");
  await filePage.goto(fileUrl);
  await sleep(1500);
  check(/START-VIEWER/.test((await filePage.locator("#boot-guide").textContent()) ?? ""), "file:// で直接開くと起動ファイルの案内が出る");
  const bad = await page.evaluate(async (u) => (await fetch(u.replace(/\/[0-9a-f]{32}\//, "/00000000000000000000000000000000/"))).status, url);
  check(bad === 404, "トークンが違う URL は 404", bad);
  check(real.length === 0, "コンソール・通信にエラーがない", real.slice(0, 6));

  console.log(`\n合格 ${pass} / 失敗 ${fail}`);
  process.exitCode = fail ? 1 : 0;
} finally {
  await browser.close();
  if (proc.pid) spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
}

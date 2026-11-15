/*
 * 「導入ガイド」PDF の画面を撮る（docs/user-guides/setup/shots/ と marks.js）。
 * 前提: ~/graphy-guide-lab の環境（dcm4chee 2 台・デスクトップ版 start-desktop.sh・Web 版 8090）が起動済みで、
 *       デスクトップ版のプロファイルと Web 版の DB は空、外部 PACS には HCC_001 だけが入っている。README を参照。
 *
 * 実行: cd automator && npx tsx src/guide/setupShots.ts <名前>...   （名前なし = 下の ORDER を順に全部）
 * 🔴 場面は状態を持つ（登録・取得の後は戻らない）。1 枚だけ撮り直すときは、その場面の前提の状態にしてから。
 */
import fs from "node:fs";
import path from "node:path";

import { chromium, type Browser, type Locator, type Page } from "@playwright/test";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { closeDialogs, connect, mainPage, settingsTab } from "./setupLab/cdp.js";
import { registerAe } from "./setupLab/ui2.js";
import type { Mark } from "./run.js";

const SHOTS = path.resolve(AUTOMATOR_ROOT, "..", "docs", "user-guides", "setup", "shots");
const MARKS_FILE = path.join(SHOTS, "marks.js");
const LAB = path.join(process.env.HOME ?? "", "graphy-guide-lab");
const EXT = "http://192.168.10.20:8080";
const WEB = "http://192.168.10.1:8090/";
fs.mkdirSync(SHOTS, { recursive: true });

type Side = Mark["side"];
type Target = Locator | { at: Locator | Locator[]; side: Side };

function loadMarks(): Record<string, unknown> {
  if (!fs.existsSync(MARKS_FILE)) return {};
  const text = fs.readFileSync(MARKS_FILE, "utf8");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}
const marks = loadMarks();

async function shot(page: Page, name: string, targets: Target[] = []): Promise<void> {
  const vp = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const boxes: Mark[] = [];
  for (const t of targets) {
    const { at, side } = "at" in t ? t : { at: t, side: "top" as const };
    const bs = [];
    for (const l of Array.isArray(at) ? at : [at]) {
      const b = await l.first().boundingBox();
      if (!b) throw new Error(`${name}: 番号を振る要素が画面にありません: ${l}`);
      bs.push(b);
    }
    const x0 = Math.max(0, Math.min(...bs.map((b) => b.x))), y0 = Math.max(0, Math.min(...bs.map((b) => b.y)));
    const x1 = Math.min(vp.width, Math.max(...bs.map((b) => b.x + b.width))), y1 = Math.min(vp.height, Math.max(...bs.map((b) => b.y + b.height)));
    boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, side });
  }
  await hidePaths(page);
  const cdp = cdpOf.get(page);
  if (cdp) {
    // Electron の窓は Playwright の screenshot だと等倍になるので、倍率を掛けた CDP のセッションで直接撮る
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, "base64"));
  } else {
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  }
  marks[name] = { width: vp.width, height: vp.height, marks: boxes };
  fs.writeFileSync(MARKS_FILE, `window.GUIDE_MARKS = ${JSON.stringify(marks, null, 2)};\n`);
  console.log(`撮影: ${name}.png（番号 ${boxes.length}）`);
}

/** 1280×720・画素 2 倍（monaiShots.ts の fit と同じ CDP の方法）。 */
const cdpOf = new Map<Page, import("@playwright/test").CDPSession>();
async function fit(page: Page, width = 1280, height = 720): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  if (!page.url().startsWith("http")) cdpOf.set(page, cdp);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(800);
}

/** HOME より上のパス（利用者名を含む）を「…」にする。 */
async function hidePaths(page: Page): Promise<void> {
  await page.evaluate((roots) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) for (const r of roots) if (r && n.textContent?.includes(r)) n.textContent = n.textContent.split(r).join("…");
  }, [process.env.HOME ?? ""]);
}

// ───────── デスクトップ版 ─────────
let desk: Browser | null = null;

async function deskMain(): Promise<Page> {
  const { browser, page } = await mainPage();
  desk = browser;
  page.on("dialog", (d) => void d.accept().catch(() => {}));
  if ((await page.evaluate(() => localStorage.getItem("graphy.locale"))) !== "ja") {
    await page.evaluate(() => localStorage.setItem("graphy.locale", "ja"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
  }
  const agree = page.getByRole("button", { name: /同意して使う/ });
  if (await agree.count()) { await agree.first().click(); await page.waitForTimeout(800); }
  await fit(page);
  await closeDialogs(page);
  return page;
}

async function deskQr(main: Page): Promise<Page> {
  const old = (await connect()).pages().find((p) => /index\.html#qr/.test(p.url()));
  if (old) { await old.close().catch(() => {}); await main.waitForTimeout(800); }
  await main.getByRole("button", { name: /Query\/Retrieve/ }).first().click();
  let qr: Page | undefined;
  for (let i = 0; i < 30 && !qr; i++) { await main.waitForTimeout(500); qr = (await connect()).pages().find((p) => /index\.html#qr/.test(p.url())); }
  if (!qr) throw new Error("Q/R の窓が開かない");
  qr.on("dialog", (d) => void d.accept().catch(() => {}));
  await fit(qr);
  await qr.waitForTimeout(2500);
  return qr;
}

async function closeSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "✕" }).first().click().catch(() => {});
  await page.waitForTimeout(500);
}

const aeInputs = (page: Page, n: number) => [page.getByPlaceholder("AET").nth(n), page.getByPlaceholder("host / IP").nth(n), page.getByPlaceholder("104").nth(n)];

async function addRow(page: Page, ae: string, host: string, port: number): Promise<number> {
  await page.getByRole("button", { name: /追加$/ }).first().click();
  const n = (await page.getByPlaceholder("AET").count()) - 1;
  const [a, h, p] = aeInputs(page, n);
  await a.fill(ae); await h.fill(host); await p.fill(String(port));
  return n;
}
async function echo(page: Page, n: number): Promise<void> {
  const b = page.locator('button[title="疎通確認"]').nth(n);
  await b.click();
  await page.waitForFunction((i) => /[✓✕]/.test(document.querySelectorAll('button[title="疎通確認"]')[i]?.textContent ?? ""), n, { timeout: 40_000 });
}
const saveBtn = (page: Page) => page.getByRole("button", { name: "保存", exact: true }).first();

/** 設定の通信先を、指定の行だけにして保存する（既存行は消す）。 */
async function setRemotes(page: Page, rows: Array<[string, string, number]>): Promise<void> {
  await settingsTab(page, "DICOM 通信先");
  while (await page.locator('button[title="削除"]').count()) await page.locator('button[title="削除"]').first().click();
  for (const [a, h, p] of rows) await addRow(page, a, h, p);
  if (await saveBtn(page).isEnabled()) await saveBtn(page).click();
  await page.waitForTimeout(1200);
}

const scenes: Record<string, () => Promise<void>> = {
  async "sa-local-ae"() {
    const p = await deskMain();
    await settingsTab(p, "DICOM通信");
    await shot(p, "sa-local-ae", [p.getByText("DICOM通信").last(), p.locator("input[value='GRAPHYNEXT']"), p.locator("input[value='11112']")]);
    await closeSettings(p);
  },
  async "sa-main-toolbar"() {
    const p = await deskMain();
    await closeDialogs(p);
    await p.getByRole("button", { name: "全期間" }).click();
    await p.getByRole("button", { name: "検索", exact: true }).first().click();
    await p.waitForTimeout(1500);
    await shot(p, "sa-main-toolbar", [p.getByRole("button", { name: /Query\/Retrieve/ }), p.getByRole("button", { name: "送信", exact: true }), p.locator('button[title="環境設定"]')]);
  },
  async "sa-remote"() {
    const p = await deskMain();
    await setRemotes(p, []);
    await settingsTab(p, "DICOM 通信先");
    const n = await addRow(p, "DCM4CHEE", "192.168.10.20", 11112);
    await echo(p, n);
    await saveBtn(p).click();
    await p.waitForTimeout(1200);
    await shot(p, "sa-remote", [p.getByRole("button", { name: /追加$/ }), { at: aeInputs(p, n), side: "top" }, p.locator('button[title="疎通確認"]').nth(n), saveBtn(p)]);
    await closeSettings(p);
  },
  async "tr-qr-unsaved"() {
    // 相手の PACS に GRAPHYNEXT をまだ登録していない状態で［取得］する
    const p = await deskMain();
    const qr = await deskQr(p);
    await qr.getByRole("button", { name: "全期間" }).click();
    await qr.getByRole("button", { name: /^Query$/ }).click();
    await qr.getByRole("button", { name: "取得" }).first().waitFor({ timeout: 20_000 });
    await qr.getByRole("button", { name: "取得" }).first().click();
    await qr.waitForTimeout(6000);
    await shot(qr, "tr-qr-unsaved", [qr.getByText("未保存").first()]);
  },
  async "ui2-newaet-graphynext"() {
    await ui2New("graphynext", "GRAPHYNEXT", "192.168.10.1", "ui2-newaet-graphynext");
  },
  async "ui2-aelist"() {
    const { b, page } = await chromiumPage();
    await page.goto(`${EXT}/dcm4chee-arc/ui2/en/device/aelist`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    const row = page.getByText("GRAPHYNEXT", { exact: true }).first().locator("xpath=ancestor::tr[1]");
    await row.scrollIntoViewIfNeeded();
    await shot(page, "ui2-aelist", [page.getByText("AE list", { exact: true }).first(), page.getByText("New AET", { exact: true }).first(), row]);
    await b.close();
  },
  async "sa-qr-query"() {
    const p = await deskMain();
    const qr = await deskQr(p);
    await qr.getByRole("button", { name: "全期間" }).click();
    await qr.getByRole("button", { name: /^Query$/ }).click();
    await qr.getByRole("button", { name: "取得" }).first().waitFor({ timeout: 20_000 });
    await shot(qr, "sa-qr-query", [qr.getByRole("button", { name: /DCM4CHEE/ }).first(), qr.getByRole("button", { name: "全期間" }), qr.getByRole("button", { name: /^Query$/ }), qr.getByRole("button", { name: "取得" }).first()]);
    await qr.getByRole("button", { name: "取得" }).first().click();
    await qr.getByText("保存済", { exact: true }).first().waitFor({ timeout: 90_000 });
    await qr.waitForTimeout(1000);
    await shot(qr, "sa-qr-saved", [qr.getByText("保存済", { exact: true }).first()]);
  },
  async "sa-qr-saved"() {
    // 取得済みのあとで開き直して［Query］する（保存済の表示だけを撮り直す用）
    const p = await deskMain();
    const qr = await deskQr(p);
    await qr.getByRole("button", { name: "全期間" }).click();
    await qr.getByRole("button", { name: /^Query$/ }).click();
    await qr.getByText("保存済", { exact: true }).first().waitFor({ timeout: 30_000 });
    await shot(qr, "sa-qr-saved", [qr.getByText("保存済", { exact: true }).first()]);
  },
  async "sa-main-after"() {
    const p = await deskMain();
    await p.getByRole("button", { name: "全期間" }).click();
    await p.getByRole("button", { name: "検索", exact: true }).first().click();
    await p.locator("table tbody tr").first().waitFor({ timeout: 20_000 });
    await shot(p, "sa-main-after", [p.locator("table tbody tr").first()]);
  },
  async "sa-send"() {
    const p = await deskMain();
    await p.getByRole("button", { name: "全期間" }).click();
    await p.getByRole("button", { name: "検索", exact: true }).first().click();
    await p.locator("table tbody tr").first().locator("td").nth(2).click();
    await p.getByRole("button", { name: "送信", exact: true }).first().click();
    await p.getByText("DICOM 送信（C-STORE）").waitFor();
    await p.getByRole("combobox").last().selectOption({ label: "DCM4CHEE (192.168.10.20:11112)" });
    await shot(p, "sa-send", [p.getByRole("combobox").last(), p.getByRole("button", { name: "送信", exact: true }).last()]);
  },
  async "sa-send-done"() {
    const { browser, page: p } = await mainPage(); desk = browser; p.on("dialog", (d) => void d.accept().catch(() => {})); await fit(p);
    await p.getByRole("button", { name: "送信", exact: true }).last().click();
    await p.getByText(/送信完了/).waitFor({ timeout: 90_000 });
    await shot(p, "sa-send-done", [p.getByText(/送信完了/)]);
    await closeDialogs(p);
  },
  async "tr-echo-ng"() {
    const p = await deskMain();
    await setRemotes(p, []);
    await settingsTab(p, "DICOM 通信先");
    const a = await addRow(p, "DCM4CHEE", "192.168.10.20", 11112);
    const b = await addRow(p, "DCM4CHEE", "192.168.10.20", 11113);
    await echo(p, a); await echo(p, b);
    await shot(p, "tr-echo-ng", [p.locator('button[title="疎通確認"]').nth(a), p.locator('button[title="疎通確認"]').nth(b)]);
    await setRemotes(p, [["DCM4CHEE", "192.168.10.20", 11112], ["STRICTPACS", "192.168.10.1", 11115], ["ERRPACS", "192.168.10.1", 11116]]);
    await closeSettings(p);
  },
  async "tr-qr-nopc"() {
    const p = await deskMain();
    const qr = await deskQr(p);
    await qr.getByRole("button", { name: /STRICTPACS/ }).first().click();
    await qr.getByRole("button", { name: "全期間" }).click();
    await qr.getByRole("button", { name: /^Query$/ }).click();
    await qr.getByText(/No Presentation Context/).first().waitFor({ timeout: 30_000 });
    await shot(qr, "tr-qr-nopc", [qr.getByText(/HttpError/).first()]);
  },
  async "tr-qr-zero"() {
    const p = await deskMain();
    const qr = await deskQr(p);
    await qr.getByRole("button", { name: /ERRPACS/ }).first().click();
    await qr.getByRole("button", { name: "全期間" }).click();
    await qr.getByRole("button", { name: /^Query$/ }).click();
    await qr.getByText("該当するスタディがありません").first().waitFor({ timeout: 30_000 });
    await shot(qr, "tr-qr-zero", [qr.getByText("該当するスタディがありません")]);
    await setRemotes(p, [["DCM4CHEE", "192.168.10.20", 11112]]);
    await closeSettings(p);
  },
  async "tr-debug"() {
    const p = await deskMain();
    await settingsTab(p, "一般");
    const cb = p.getByText("デバッグモード", { exact: true }).first().locator("xpath=following::input[@type='checkbox'][1]");
    await cb.scrollIntoViewIfNeeded();
    await cb.check();
    await p.waitForTimeout(1200);
    await shot(p, "tr-debug", [p.getByText("デバッグモード", { exact: true }).first()]);
    await cb.uncheck();
    await p.waitForTimeout(1200);
    await closeSettings(p);
  },
  async "tr-port8080"() {
    fs.copyFileSync(path.join(LAB, "probe-shots", "C-startup-port8080-inuse.png"), path.join(SHOTS, "tr-port8080.png"));
    console.log("複製: tr-port8080.png（印なし）");
  },
  // ───────── Web 版 ─────────
  async "web-main-empty"() {
    const { b, page } = await webPage();
    await page.getByRole("button", { name: "全期間" }).click();
    await page.getByRole("button", { name: "検索", exact: true }).first().click();
    await page.waitForTimeout(2500);
    await shot(page, "web-main-empty", [page.getByRole("button", { name: /Query\/Retrieve/ }), page.locator('button[title="環境設定"]')]);
    await b.close();
  },
  async "web-remote"() {
    const { b, page } = await webPage();
    await setRemotes(page, []);
    await settingsTab(page, "DICOM 通信先");
    const n = await addRow(page, "DCM4CHEE", "192.168.10.20", 11112);
    await echo(page, n);
    await saveBtn(page).click();
    await page.waitForTimeout(1200);
    await shot(page, "web-remote", [page.getByRole("button", { name: /追加$/ }), { at: aeInputs(page, n), side: "top" }, page.locator('button[title="疎通確認"]').nth(n), saveBtn(page)]);
    await b.close();
  },
  async "web-movedest"() {
    const { b, page } = await webPage();
    await settingsTab(page, "Query/Retrieve");
    const inp = page.getByText("Web取得の C-MOVE 宛先 AE", { exact: false }).first().locator("xpath=following::input[1]");
    await inp.fill("GRAPHYPACS"); await inp.blur(); await page.waitForTimeout(1500);
    await shot(page, "web-movedest", [page.getByText("Query/Retrieve").last(), inp]);
    await b.close();
  },
  async "ui2-newaet-graphypacs"() {
    await ui2New("graphypacs", "GRAPHYPACS", "192.168.10.10", "ui2-newaet-graphypacs");
  },
  async "web-qr-query"() {
    const { b, page, ctx } = await webPage();
    const qr = await webQr(page, ctx);
    await qr.getByRole("button", { name: "全期間" }).click();
    await qr.getByRole("button", { name: /^Query$/ }).click();
    await qr.getByRole("button", { name: "取得" }).first().waitFor({ timeout: 20_000 });
    await shot(qr, "web-qr-query", [qr.getByRole("button", { name: /DCM4CHEE/ }).first(), qr.getByRole("button", { name: "全期間" }), qr.getByRole("button", { name: /^Query$/ }), qr.getByRole("button", { name: "取得" }).first()]);
    await qr.getByRole("button", { name: "取得" }).first().click();
    await qr.getByText("保存済", { exact: true }).first().waitFor({ timeout: 120_000 });
    await qr.waitForTimeout(1000);
    await shot(qr, "web-qr-saved", [qr.getByText("保存済", { exact: true }).first()]);
    await b.close();
  },
  async "web-main-after"() {
    const { b, page } = await webPage();
    await page.getByRole("button", { name: "全期間" }).click();
    await page.getByRole("button", { name: "検索", exact: true }).first().click();
    await page.locator("table tbody tr").first().waitFor({ timeout: 20_000 });
    await shot(page, "web-main-after", [page.locator("table tbody tr").first()]);
    await b.close();
  },
  async "web-viewer"() {
    const { b, page, ctx } = await webPage();
    await page.getByRole("button", { name: "全期間" }).click();
    await page.getByRole("button", { name: "検索", exact: true }).first().click();
    await page.locator("table tbody tr").first().locator("td").nth(2).click();
    const [v] = await Promise.all([ctx.waitForEvent("page", { timeout: 15_000 }), page.getByRole("button", { name: /2D Viewer/ }).first().click()]);
    await v.setViewportSize({ width: 1280, height: 720 });
    await v.waitForTimeout(3000);
    await v.getByText(/^#3 CT C-A-P/).first().locator("xpath=following::button[normalize-space()='+' or normalize-space()='＋'][1]").click();
    await v.waitForTimeout(4000);
    const sl = Number(process.env.GUIDE_SLICE_STEPS ?? "30");
    await v.mouse.move(800, 380);
    for (let i = 0; i < sl; i++) { await v.mouse.wheel(0, 100); await v.waitForTimeout(60); }
    await v.waitForTimeout(1500);
    await shot(v, "web-viewer", []);
    await b.close();
  },
  async "tr-web-baseurl"() {
    const { b, page } = await webPage("http://192.168.10.1:8091/");
    await page.getByRole("button", { name: "全期間" }).click();
    await page.getByRole("button", { name: "検索", exact: true }).first().click();
    await page.getByText(/取得に失敗しました/).waitFor({ timeout: 30_000 });
    await shot(page, "tr-web-baseurl", [page.getByText(/取得に失敗しました/)]);
    await b.close();
  },
};

// ───────── 共通（Playwright chromium） ─────────
async function chromiumPage(): Promise<{ b: Browser; page: Page }> {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  return { b, page: await ctx.newPage() };
}

async function webPage(url = WEB): Promise<{ b: Browser; page: Page; ctx: import("@playwright/test").BrowserContext }> {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { try { localStorage.setItem("graphy.locale", "ja"); } catch { /* */ } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const agree = page.getByRole("button", { name: /同意して使う/ });
  if (await agree.count()) { await agree.first().click(); await page.waitForTimeout(800); }
  return { b, page, ctx };
}

async function webQr(page: Page, ctx: import("@playwright/test").BrowserContext): Promise<Page> {
  const [qr] = await Promise.all([ctx.waitForEvent("page", { timeout: 15_000 }), page.getByRole("button", { name: /Query\/Retrieve/ }).first().click()]);
  await qr.setViewportSize({ width: 1280, height: 720 });
  await qr.waitForLoadState();
  await qr.waitForTimeout(2500);
  return qr;
}

/** UI2 の「Register new application entity」。入力して 1 枚（収まらなければ -a / -b）撮り、APPLY で登録する。 */
async function ui2New(device: string, ae: string, host: string, name: string): Promise<void> {
  const { b, page } = await chromiumPage();
  await page.goto(`${EXT}/dcm4chee-arc/ui2/en/device/aelist`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.getByText("New AET", { exact: true }).first().click();
  await page.waitForTimeout(1500);
  const ins = page.locator("input:visible");
  await ins.nth(1).fill(device);
  await ins.nth(2).fill(host);
  await ins.nth(3).fill("11112");
  await ins.nth(4).fill(ae);
  await page.getByText("New Device", { exact: true }).last().click();
  await page.waitForTimeout(600);
  const devName = page.getByText("Device name", { exact: true }).last().locator("xpath=following::input[1]");
  await devName.fill(device);
  await page.getByText("True", { exact: true }).last().click();
  // -a: Device name と Installed（上半分）
  await devName.scrollIntoViewIfNeeded();
  await page.getByText("Device name", { exact: true }).last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot(page, `${name}-a`, [devName]);
  // -b: 「New Network Connection」を開き、Hostname・Port・AE Title・APPLY（下半分）
  await page.getByText(/^New Network Connection(?! to)/).first().click();
  await page.waitForTimeout(600);
  const hostIn = page.getByText("Hostname", { exact: true }).last().locator("xpath=following::input[1]");
  const portIn = page.getByText("Port", { exact: true }).last().locator("xpath=following::input[1]");
  const aeIn = page.getByText("AE Title", { exact: true }).last().locator("xpath=following::input[1]");
  console.log("values", await hostIn.inputValue(), await portIn.inputValue(), await aeIn.inputValue());
  await hostIn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const apply = page.getByRole("button", { name: /apply/i });
  const vis = async (l: Locator) => { const bb = await l.boundingBox(); return !!bb && bb.y >= 0 && bb.y + bb.height <= 720; };
  console.log("visible host/port/ae/apply", await vis(hostIn), await vis(portIn), await vis(aeIn), await vis(apply));
  await shot(page, `${name}-b`, [hostIn, portIn, aeIn, { at: apply, side: "top" }].filter(Boolean) as Target[]);
  await apply.click();
  await page.waitForTimeout(3500);
  await b.close();
}

const ORDER = ["sa-local-ae", "sa-remote", "sa-main-toolbar", "tr-qr-unsaved", "ui2-newaet-graphynext", "ui2-aelist", "sa-qr-query", "sa-main-after", "sa-send", "sa-send-done",
  "web-main-empty", "web-remote", "web-movedest", "ui2-newaet-graphypacs", "web-qr-query", "web-main-after", "web-viewer",
  "tr-echo-ng", "tr-qr-nopc", "tr-qr-zero", "tr-debug", "tr-web-baseurl", "tr-port8080"];

const want = process.argv.slice(2);
for (const n of want.length ? want : ORDER) {
  if (!scenes[n]) { console.error(`未知の名前: ${n}`); continue; }
  try { await scenes[n](); } catch (e) { console.error(`失敗: ${n}: ${String(e).slice(0, 300)}`); }
}
await (desk as { close(): Promise<void> } | null)?.close().catch(() => {});
process.exit(0);

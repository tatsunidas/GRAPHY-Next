/*
 * v0.6.5 操作ガイド: v0.6.4 からの変更のうち、画面で見せられるもの。
 *   ① ROI 特徴量の画面（全断面の 2D・設定の群分け・ツールチップ）
 *   ② 一括抽出（アルバムの［一括抽出］。2D の単位・定義の形式・QC・画素間隔の警告）
 *   ③ 環境設定: マウスの中・右・戻る・進むのボタンのツール割り当て、施設の資料（設定ファイルと、メイン画面の「資料」節）
 * デスクトップ版を 1 回起動して撮る。置き場は automator/.results/guide-v0.6.5（画面に出るパスは「…」にしてから撮る）。
 * データ: HCC_001（PRE LIVER と、その Segmentation）。施設の資料は、架空の内容（example.org）を一時フォルダに置いて指す。
 * 🔴 ページごとに失敗を記録し、最後に一覧で出す。撮れなかった機能は、ガイドに載せない。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import { dismissStartupDialogs } from "../../common/dismissDialogs.js";
import { AUTOMATOR_ROOT } from "../../fixtures/manifest.js";
import type { Scenario } from "../run.js";

const REPO = path.resolve(AUTOMATOR_ROOT, "..");
const DESKTOP_DIR = path.join(REPO, "desktop");
const FRONTEND_DIR = path.join(REPO, "frontend");
const ROOT = path.join(AUTOMATOR_ROOT, ".results", "guide-v0.6.5");
const APP_DIR = path.join(ROOT, "app");
const DATA_DIR = process.env.GRAPHY_GUIDE_DATA ?? path.join(process.env.HOME ?? "", "graphy-demo-samples");
// 他の撮影（v0.5.1 は 18710 系）と同時に動かせるよう、ポートを変える
const PORT = 18720;
const VITE_PORT = 18723;
const SCP_PORT = 18721;

async function fit(page: Page, width = 1280, height = 720): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(800);
}

/** 置き場と HOME より上のパスを「…」にする（画面の文字だけ。データは変えない）。 */
async function hidePaths(page: Page): Promise<void> {
  await page.evaluate((roots) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      for (const r of roots) if (r && n.textContent?.includes(r)) n.textContent = n.textContent.split(r).join("…");
    }
  }, [ROOT, process.env.HOME ?? "", process.env.GRAPHY_GUIDE_PYBIN ? path.dirname(process.env.GRAPHY_GUIDE_PYBIN) : ""]);
}

async function waitHttp(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* 起動待ち */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`応答がありません: ${url}`);
}

async function findWindow(app: ElectronApplication, pred: (url: string) => boolean, timeoutMs: number): Promise<Page> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const w = app.windows().find((x) => pred(x.url()));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("窓が見つかりません");
}


async function post<T>(base: string, url: string, body: unknown): Promise<T> {
  const r = await fetch(`${base}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST ${url} ${r.status}`);
  return (await r.json().catch(() => ({}))) as T;
}

const FACILITY = {
  schemaVersion: 1,
  title: "放射線科 資料",
  updatedAt: "2026-11-18",
  contact: "mailto:rad-info@example.org",
  groups: [
    {
      id: "protocols",
      title: "撮影プロトコル",
      items: [{ type: "link", title: "造影 CT プロトコル", url: "https://intra.example.org/proto/ct", note: "2026-10 改訂" }],
      groups: [{ id: "peds", title: "小児", items: [{ type: "link", title: "鎮静の目安", url: "https://intra.example.org/peds/sedation" }] }],
    },
    {
      id: "phones",
      title: "電話帳",
      items: [
        { type: "card", title: "当直・緊急", body: "放射線科 当直 内線 1234\nCT 室 内線 5678" },
        { type: "link", title: "IT 問い合わせ", url: "mailto:it@example.org?subject=help" },
      ],
    },
  ],
};

const scenario: Scenario = async ({ shot }) => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(APP_DIR, { recursive: true });
  const facilityFile = path.join(ROOT, "facility", "facility.json");
  fs.mkdirSync(path.dirname(facilityFile), { recursive: true });
  fs.writeFileSync(facilityFile, JSON.stringify(FACILITY, null, 2));
  // 起動時の利用条件の同意は、撮影の前に済んだことにしておく
  fs.writeFileSync(
    path.join(APP_DIR, "settings.json"),
    JSON.stringify({ "dicom.localAePort": String(SCP_PORT), "legal.researchUseConsent": JSON.stringify({ version: 1, acceptedAt: new Date().toISOString() }) }, null, 2),
  );

  const failed: string[] = [];
  const captured: string[] = [];
  let reset: () => Promise<void> = async () => undefined;
  const section = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      captured.push(name);
    } catch (e) {
      failed.push(`${name}: ${String((e as Error).message).split("\n")[0]}`);
      console.log(`  [撮れず] ${name}: ${String((e as Error).message).split("\n")[0]}`);
      for (const w of app?.windows() ?? []) await w.screenshot({ path: path.join(ROOT, `fail-${name}-${w.url().includes("#") ? "sub" : "main"}.png`) }).catch(() => undefined);
      await reset().catch(() => undefined);
    }
  };

  let vite: ChildProcess | null = null;
  let app: ElectronApplication | null = null;
  try {
    vite = spawn("npm", ["run", "dev", "--", "--port", String(VITE_PORT), "--strictPort"], {
      cwd: FRONTEND_DIR,
      stdio: "ignore",
      detached: true,
      env: { ...process.env, VITE_BACKEND_URL: `http://localhost:${PORT}` },
    });
    await waitHttp(`http://localhost:${VITE_PORT}/`, 60_000);

    const electronPath = createRequire(path.join(DESKTOP_DIR, "package.json"))("electron") as unknown as string;
    app = await electron.launch({
      executablePath: electronPath,
      args: [DESKTOP_DIR, "--no-sandbox"],
      cwd: APP_DIR,
      env: { ...process.env, GRAPHY_DEV: "1", GRAPHY_BACKEND_PORT: String(PORT), GRAPHY_DEV_SERVER_URL: `http://localhost:${VITE_PORT}` },
    });
    const main = await findWindow(app, (u) => u.startsWith(`http://localhost:${VITE_PORT}`) && !u.includes("#"), 120_000);
    const base = `http://localhost:${PORT}`;
    await waitHttp(`${base}/api/status`, 180_000);
    await main.evaluate(() => localStorage.setItem("graphy.locale", "ja"));
    await main.reload();
    await main.waitForTimeout(3_000);
    main.on("dialog", (d) => void d.accept());
    console.log(`取り込み(HCC_001): ${JSON.stringify(await post(base, "/api/import/paths", { paths: [path.join(DATA_DIR, "HCC_001")] }))}`);

    const mainUrl = `http://localhost:${VITE_PORT}/`;
    reset = async (): Promise<void> => {
      for (const w of app!.windows()) if (w !== main) await w.close().catch(() => undefined);
      await main.goto(mainUrl);
      await main.waitForTimeout(3_000);
      await dismissStartupDialogs(main);
      await fit(main);
    };
    await reset();

    // ── ① ROI 特徴量の画面 ──
    await section("roi-features", async () => {
      await main.getByTestId("search-patientid-input").fill("HCC_001");
      await main.getByTestId("search-allperiod-chip").click();
      await main.getByTestId("search-submit-button").click();
      const studyRow = main.locator('[data-testid^="study-row-"]').first();
      const seriesRow = main.locator('[data-testid^="series-row-"]', { hasText: "PRE LIVER" }).first();
      await studyRow.waitFor({ state: "visible", timeout: 20_000 });
      // スタディ行を押した直後に一覧が再読込されると、開いたシリーズ一覧が閉じることがある。見えるまで押し直す
      for (let i = 0; i < 4 && !(await seriesRow.isVisible()); i++) {
        await studyRow.click();
        await main.waitForTimeout(1_500);
      }
      await seriesRow.click({ timeout: 20_000 });
      const viewerWait = app!.waitForEvent("window", { timeout: 30_000 });
      await main.getByTestId("viewer2d-toolbar-button").click();
      const viewer = await viewerWait;
      viewer.on("dialog", (d) => void d.accept());
      await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
      await fit(viewer);
      await viewer.waitForTimeout(3_000);
      await viewer.getByTestId("viewer2d-menu-analysis").click();
      const winWait = app!.waitForEvent("window", { timeout: 30_000 });
      await viewer.getByTestId("menu-roi-features").click();
      const popup = await winWait;
      const rfUrl = popup.url();
      await popup.close();
      await viewer.close();
      await main.goto(rfUrl);
      await main.waitForTimeout(3_000);
      await dismissStartupDialogs(main);
      await fit(main, 900, 1100);
      const mask = main.getByTestId("roifeat-mask");
      await mask.waitFor({ state: "visible", timeout: 30_000 });
      const opts = await mask.locator("option").evaluateAll((os) => os.map((o) => ({ v: (o as HTMLOptionElement).value, t: (o.textContent ?? "").trim() })).filter((o) => o.v));
      const seg = opts.find((o) => /SEG|Seg|セグ/.test(o.t));
      if (!seg) throw new Error(`マスク（SEG）の候補がありません: ${opts.map((o) => o.t).join(" | ")}`);
      await mask.selectOption(seg.v);
      // 最大断面（2D）を選ぶと、断面の［全断面］が選べる。選んで、結果の見出し（計算する内容の要約）に出ることまで見せる
      await main.getByTestId("roifeat-mode-section").check();
      await main.getByTestId("roifeat-planes-all").check();
      await main.waitForTimeout(1_000);
      await main.evaluate(() => window.scrollTo(0, 0));
      await main.waitForTimeout(600);
      await shot(main, "roi-settings", [
        { at: main.getByText("計算の単位", { exact: true }).first(), side: "left" },
        { at: main.getByText("断面", { exact: true }).first(), side: "left" },
        { at: main.getByText("前処理", { exact: true }).first(), side: "left" },
        { at: main.getByText("値の扱い", { exact: true }).first(), side: "left" },
      ]);
      await reset();
    });

    // ── ② 一括抽出 ──
    await section("batch", async () => {
      const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
      const album = await post<{ id: number }>(base, "/api/albums", { name: "肝腫瘍の例" });
      await post(base, `/api/albums/${album.id}/studies`, { studyUids: studies.map((x) => x.studyInstanceUid) });
      await main.reload();
      await main.getByTestId("album-select").waitFor({ state: "visible", timeout: 60_000 });
      await main.waitForFunction((id) => !!document.querySelector(`[data-testid="album-select"] option[value="${id}"]`), album.id, { timeout: 30_000 });
      // アルバムの中身の読み込みが終わるまで、選び直す
      for (let i = 0; i < 5 && !(await main.getByTestId("album-batch-button").isEnabled()); i++) {
        await main.getByTestId("album-select").selectOption(String(album.id));
        await main.waitForTimeout(2_500);
      }
      console.log(`アルバム: value=${await main.getByTestId("album-select").inputValue()} error=${(await main.getByTestId("album-error").textContent().catch(() => null)) ?? "なし"}`);
      await main.getByTestId("album-batch-button").click();
      await main.getByTestId("batch-dialog").waitFor({ state: "visible", timeout: 60_000 });
      await main.waitForTimeout(3_000);
      await shot(main, "batch-top", [
        { at: main.getByTestId("batch-dialog").locator("table").first(), side: "left" },
        { at: main.getByText("計算する内容", { exact: true }).first(), side: "left" },
        { at: main.getByRole("button", { name: "定義を保存" }), side: "left" },
      ]);
      await main.getByTestId("batch-dialog").evaluate((el) => {
        const sc = [el, ...Array.from(el.querySelectorAll("*"))].find((n) => n.scrollHeight > n.clientHeight + 50 && getComputedStyle(n).overflowY !== "visible");
        if (sc) sc.scrollTop = 100000;
      });
      await main.waitForTimeout(600);
      await shot(main, "batch-output", [
        { at: main.getByText("QC と絞り込み", { exact: true }).first(), side: "left" },
        { at: main.getByTestId("batch-out-patientid"), side: "left" },
        { at: main.getByText("定義の一覧（順に実行）"), side: "left" },
      ]);
      await reset();
    });

    // ── ③ 環境設定: マウスのボタン ──
    await section("mouse", async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-settings").click();
      await main.getByTestId("settings-cat-viewer").click();
      await main.getByTestId("settings-field-mouse.middle").scrollIntoViewIfNeeded();
      await main.waitForTimeout(500);
      await main.getByText("マウスボタン（2D・動画）").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
      await main.waitForTimeout(600);
      await shot(main, "mouse-buttons", [
        { at: main.getByTestId("settings-field-mouse.middle"), side: "left" },
        { at: main.getByTestId("settings-field-mouse.right"), side: "left" },
        { at: main.getByTestId("settings-field-mouse.back"), side: "left" },
      ]);
      await reset();
    });

    // ── ③ 施設の資料 ──
    await section("facility", async () => {
      await main.evaluate(async (file) => {
        const r = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ "facility.configPath": file }) });
        if (!r.ok) throw new Error(`settings PUT ${r.status}`);
      }, facilityFile);
      await main.reload();
      await main.waitForTimeout(6_000);
      await main.getByTestId("resource-panel-toggle").click();
      await main.getByTestId("resource-panel").getByText("撮影プロトコル").first().click();
      await main.getByTestId("resource-panel").getByText("電話帳").first().click();
      await main.waitForTimeout(500);
      await main.getByTestId("resource-panel").evaluate((el) => el.scrollIntoView({ block: "end" }));
      await main.waitForTimeout(600);
      await shot(main, "resource-panel", [{ at: main.getByTestId("resource-panel"), side: "left" }]);
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-settings").click();
      await main.getByTestId("settings-cat-facility").click();
      await main.getByTestId("facility-panel").waitFor({ state: "visible" });
      await main.waitForTimeout(3_000);
      // 入力欄に出るこのマシンのパスは、画面の例（共有フォルダ）に置き換えて撮る
      await main.getByTestId("facility-path").evaluate((el) => { (el as HTMLInputElement).value = "\\\\fileserver\\radiology\\facility.json"; });
      await shot(main, "facility-settings", [
        { at: main.getByTestId("facility-path"), side: "left" },
        { at: main.getByTestId("facility-status"), side: "left" },
      ]);
      await reset();
    });
  } finally {
    await app?.close().catch(() => undefined);
    if (vite?.pid) {
      try {
        process.kill(-vite.pid, "SIGTERM");
      } catch {
        /* すでに終了 */
      }
    }
  }
  console.log(`\n撮れた: ${captured.join(", ")}`);
  console.log(`撮れず: ${failed.length === 0 ? "なし" : failed.join(" / ")}`);
  if (failed.length > 0) throw new Error(`撮れなかったページがあります: ${failed.join(" / ")}`);
};

export default scenario;

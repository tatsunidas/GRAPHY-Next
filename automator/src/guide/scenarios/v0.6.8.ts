/*
 * v0.6.8 操作ガイド: v0.6.7 からの変更のうち、画面で見せられるもの。
 *   ① DICOM-SR の表示（検査一覧のプレビュー）と、計測の数値の書き方
 *   ② ROI 特徴量の一括抽出の画面（Volume (3D)・ⓘ）
 * デスクトップ版を 1 回起動して撮る。置き場は automator/.results/guide-v0.6.8。
 * データ: HCC_001（PRE LIVER と、その Segmentation）。SR の数値は撮影用の例の値（実測ではない。SR の所見にも書く）。
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
const ROOT = path.join(AUTOMATOR_ROOT, ".results", "guide-v0.6.8");
const APP_DIR = path.join(ROOT, "app");
const DATA_DIR = process.env.GRAPHY_GUIDE_DATA ?? path.join(process.env.HOME ?? "", "graphy-demo-samples");
// 他の撮影（v0.5.1 は 18710 系）と同時に動かせるよう、ポートを変える
const PORT = 18730;
const VITE_PORT = 18733;
const SCP_PORT = 18731;

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

const scenario: Scenario = async ({ shot }) => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(APP_DIR, { recursive: true });
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

    // ── ① DICOM-SR の表示 ──
    await section("sr", async () => {
      const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
      const studyUid = studies[0].studyInstanceUid;
      const sr = await post<{ seriesInstanceUid: string }>(base, "/api/sr/measurement-report", {
        studyInstanceUid: studyUid,
        seriesDescription: "計測レポート（例）",
        documentTitle: "操作ガイド用の例（値は実測ではありません）",
        groups: [
          {
            trackingId: "lesion 1",
            measurements: [
              { type: "longAxis", value: 42.5 },
              { type: "shortAxis", value: 31 },
              { type: "volume", value: 28.4567 },
              { type: "absorbedDose", value: 0.000123456789 },
              { type: "timeIntegratedActivity", value: 4.393e11 },
            ],
          },
        ],
        findings: [{ label: "所見", text: "撮影のための例の値です" }],
      });
      await main.reload();
      await main.waitForTimeout(3_000);
      await dismissStartupDialogs(main);
      await fit(main, 1280, 900);
      await main.getByTestId("search-patientid-input").fill("HCC_001");
      await main.getByTestId("search-allperiod-chip").click();
      await main.getByTestId("search-submit-button").click();
      const studyRow = main.locator(`[data-testid="study-row-${studyUid}"]`);
      const seriesRow = main.locator(`[data-testid="series-row-${sr.seriesInstanceUid}"]`);
      await studyRow.waitFor({ state: "visible", timeout: 20_000 });
      for (let i = 0; i < 4 && !(await seriesRow.isVisible()); i++) {
        await studyRow.click();
        await main.waitForTimeout(1_500);
      }
      await seriesRow.click({ timeout: 20_000 });
      // 2D ビューアのタイルで撮る（プレビューより高さがあり、計測の表が全部入る）
      const viewerWait = app!.waitForEvent("window", { timeout: 30_000 });
      await main.getByTestId("viewer2d-toolbar-button").click();
      const viewer = await viewerWait;
      viewer.on("dialog", (d) => void d.accept());
      const view = viewer.getByTestId("sr-viewer").first();
      await view.waitFor({ state: "visible", timeout: 60_000 });
      await fit(viewer, 1280, 900);
      await viewer.waitForTimeout(2_000);
      const table = view.getByTestId("sr-group-table").first();
      await table.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await viewer.waitForTimeout(600);
      const lb = await table.locator("tbody tr").last().boundingBox();
      const vh = await viewer.evaluate(() => window.innerHeight);
      if (!lb || lb.y + lb.height > vh - 30) throw new Error(`計測の表が画面に収まっていない: ${JSON.stringify(lb)} / ${vh}`);
      await shot(viewer, "sr-preview", [
        { at: view.getByTestId("sr-header").first(), side: "left" },
        { at: table, side: "left" },
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

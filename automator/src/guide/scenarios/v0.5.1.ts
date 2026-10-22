/*
 * v0.5.1 操作ガイド: v0.5.0 以降の主な新機能（取り込み・計算機とプラグイン・ROI 特徴量・つなぎ合わせ・タグ編集）。
 * 配布する PDF がかさばらないよう、画面は 1 テーマ 1〜2 枚に絞る（全体で約 8 枚）。
 *
 * デスクトップ版を 1 回起動して全部を撮る（設定の「プラグイン」「計算機」はデスクトップ版だけの画面）。
 * 利用者の開発用データに触れないよう、automator/.results/guide-v0.5.1 を置き場にする。
 * - データ: HCC_001（PRE LIVER と、その Segmentation）、つなぎ合わせは make-stitch-phantom.py の合成 CT
 * - 画面に出るパスは、置き場と HOME を「…」にしてから撮る（公開する資料にマシンのパスを写さない）
 * - 🔴 ページごとに失敗を記録し、最後に一覧で出す。撮れなかった・動かなかった機能は、ガイドに載せない
 * 本文は docs/release-guides/v0.5.1/guide.html。番号の順はそちらの説明の順と合わせる。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import { dismissStartupDialogs } from "../../common/dismissDialogs.js";
import { AUTOMATOR_ROOT } from "../../fixtures/manifest.js";
import type { MarkTarget, Scenario } from "../run.js";

const REPO = path.resolve(AUTOMATOR_ROOT, "..");
const DESKTOP_DIR = path.join(REPO, "desktop");
const FRONTEND_DIR = path.join(REPO, "frontend");
const ROOT = path.join(AUTOMATOR_ROOT, ".results", "guide-v0.5.1");
const APP_DIR = path.join(ROOT, "app");
const DATA_DIR = process.env.GRAPHY_GUIDE_DATA ?? path.join(process.env.HOME ?? "", "graphy-demo-samples");
// web の撮影（run.ts）と同時に動くので、ポートを変える
const PORT = 18710;
const VITE_PORT = 18713;
const SCP_PORT = 18711;

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

/** 小さな 3D の Raw（int16・リトルエンディアン）。中央に球を置いた 96×96×24。 */
function writeRaw(file: string, nx: number, ny: number, nz: number): void {
  const buf = Buffer.alloc(nx * ny * nz * 2);
  let o = 0;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const d = Math.hypot(x - nx / 2, y - ny / 2, (z - nz / 2) * 2.5);
        buf.writeInt16LE(d < 30 ? 900 - Math.round(d * 6) : 80 + ((x * 3 + y * 5) % 40), o);
        o += 2;
      }
  fs.writeFileSync(file, buf);
}

async function studies(base: string): Promise<{ studyInstanceUid: string; patientId: string }[]> {
  return (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId: string }[];
}

async function importPaths(base: string, paths: string[]): Promise<unknown> {
  const r = await fetch(`${base}/api/import/paths`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }) });
  return r.json();
}

const scenario: Scenario = async ({ shot }) => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(APP_DIR, { recursive: true });
  // 起動時の利用条件の同意（#354）は、撮影の前に済んだことにしておく（出たままだと以降の操作が全部吸われる）
  fs.writeFileSync(
    path.join(APP_DIR, "settings.json"),
    JSON.stringify({ "dicom.localAePort": String(SCP_PORT), "legal.researchUseConsent": JSON.stringify({ version: 1, acceptedAt: new Date().toISOString() }) }, null, 2),
  );
  const rawFile = path.join(ROOT, "phantom-96x96x24.raw");
  writeRaw(rawFile, 96, 96, 24);
  const stitchDir = path.join(ROOT, "stitch-phantom");
  const mk = spawnSync(process.env.PYTHON ?? "python3", [path.join(AUTOMATOR_ROOT, "scripts", "make-stitch-phantom.py"), stitchDir], { encoding: "utf8" });
  if (mk.status !== 0) throw new Error(`つなぎ合わせのファントムを作れません: ${mk.stderr}`);

  const failed: string[] = [];
  const captured: string[] = [];
  /** 画面を初期状態へ（開いたままのダイアログを閉じる）。main の準備ができてから差し替える。 */
  let reset: () => Promise<void> = async () => undefined;
  /** 1 ページぶん。失敗しても次へ進み、最後に一覧で出す（撮れなかったものはガイドに載せない）。 */
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
      env: {
        ...process.env,
        // 「この PC」の計算機の検出（設定＞計算機）が、CUDA の使える Python を見つけられるようにする（任意）
        ...(process.env.GRAPHY_GUIDE_PYBIN ? { PATH: `${process.env.GRAPHY_GUIDE_PYBIN}${path.delimiter}${process.env.PATH}` } : {}),
        GRAPHY_DEV: "1",
        GRAPHY_BACKEND_PORT: String(PORT),
        GRAPHY_DEV_SERVER_URL: `http://localhost:${VITE_PORT}`,
      },
    });
    const main = await findWindow(app, (u) => u.startsWith(`http://localhost:${VITE_PORT}`) && !u.includes("#"), 120_000);
    const base = `http://localhost:${PORT}`;
    await waitHttp(`${base}/api/status`, 180_000);
    // 「プラグインの導入を許可する」は main の確認ダイアログを経る。撮影では確認を自動で「許可」にする
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as unknown as typeof dialog.showMessageBox;
    });
    await main.evaluate(() => localStorage.setItem("graphy.locale", "ja"));
    await main.reload();
    await main.waitForTimeout(3_000);
    main.on("dialog", (d) => void d.accept());
    console.log(`取り込み(HCC_001): ${JSON.stringify(await importPaths(base, [path.join(DATA_DIR, "HCC_001")]))}`);
    const before = new Set((await studies(base)).map((s) => s.studyInstanceUid));
    console.log(`取り込み(つなぎ合わせ): ${JSON.stringify(await importPaths(base, [path.join(stitchDir, "a")]))}`);
    const stitchStudy = (await studies(base)).find((s) => !before.has(s.studyInstanceUid));
    console.log(`つなぎ合わせの患者: ${stitchStudy?.patientId ?? "(見つからない)"}`);

    const mainUrl = `http://localhost:${VITE_PORT}/`;
    reset = async (): Promise<void> => {
      // 開いたままの窓（ビューア）を閉じる。残ると、次に開く窓が新しくならない
      for (const w of app!.windows()) if (w !== main) await w.close().catch(() => undefined);
      // reload ではなく移動する（ROI 特徴量の画面をメインの窓で開いた後は、ハッシュが残って一覧に戻れない）
      await main.goto(mainUrl);
      await main.waitForTimeout(3_000);
      await dismissStartupDialogs(main);
      await fit(main);
    };
    await reset();

    // ── 1. 取り込み: Raw データ（ヘッダの無い画素配列） ──
    await section("import-raw", async () => {
      await main.getByText(/^非DICOM取込$/).first().click();
      await main.getByTestId("raw-file-input").setInputFiles(rawFile);
      await main.getByTestId("raw-size-status").waitFor({ state: "visible", timeout: 10_000 });
      await main.getByTestId("raw-width").fill("96");
      await main.getByTestId("raw-height").fill("96");
      await main.getByTestId("raw-slices").fill("24");
      await main.getByTestId("raw-modality").selectOption("CT");
      await main.getByTestId("raw-preview-btn").click();
      await main.getByTestId("raw-preview-img").waitFor({ state: "visible", timeout: 60_000 });
      await main.waitForTimeout(800);
      await shot(main, "import-raw", [
        { at: main.getByTestId("raw-size-status"), side: "left" },
        { at: main.getByTestId("raw-preview-img"), side: "left" },
        { at: main.getByTestId("nondicom-run"), side: "left" },
      ]);
      await main.keyboard.press("Escape");
      await reset();
    });

    // ── 2. タグの表示と編集 ──
    await section("tags", async () => {
      await main.getByTestId("search-patientid-input").fill("HCC_001");
      await main.getByTestId("search-allperiod-chip").click();
      await main.getByTestId("search-submit-button").click();
      await main.locator('[data-testid^="study-row-"]').first().click({ timeout: 20_000 });
      await main.locator('[data-testid^="series-row-"]', { hasText: "PRE LIVER" }).first().click({ timeout: 20_000 });
      await main.getByTestId("toolbar-tag-viewer-btn").click();
      const dlg = main.getByTestId("tag-viewer-dialog");
      await dlg.getByTestId("tag-viewer-table").waitFor({ state: "visible", timeout: 30_000 });
      await dlg.getByTestId("tag-edit-start").click();
      await dlg.getByTestId("tag-edit-warn").waitFor({ state: "visible", timeout: 10_000 });
      await main.waitForTimeout(500);
      await shot(main, "tags-warn", [{ at: dlg.getByTestId("tag-edit-warn"), side: "left" }]);
      await dlg.getByTestId("tag-edit-warn-ok").click();
      await dlg.getByTestId("tag-edit-input").first().waitFor({ state: "visible", timeout: 10_000 });
      await main.waitForTimeout(500);
      await shot(main, "tags-edit", [
        { at: dlg.getByTestId("tag-edit-input").first(), side: "left" },
        { at: dlg.getByTestId("tag-lock").first(), side: "left" },
        { at: dlg.getByTestId("tag-edit-save"), side: "left" },
      ]);
      await main.keyboard.press("Escape");
      await reset();
    });

    const optIn = await main.evaluate(() =>
      (window as unknown as { graphyDesktop: { pluginInstallOptIn: (b: boolean) => Promise<{ ok: boolean }> } }).graphyDesktop.pluginInstallOptIn(true).then((r) => r.ok));
    if (!optIn) throw new Error("プラグイン導入の許可を設定できません");
    const openSettings = async (cat: string): Promise<void> => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-settings").click();
      await main.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
      await main.getByTestId(`settings-cat-${cat}`).click();
    };

    // ── 3. 設定: プラグインを「見つける」・この PC の計算機 ──
    await section("settings-plugins", async () => {
      await openSettings("plugins");
      await main.getByTestId("pluginmgr-tab-catalog").click();
      const search = main.getByPlaceholder(/名前・説明・リポジトリで検索/);
      await search.waitFor({ state: "visible", timeout: 60_000 });
      await search.fill("胸部X線");
      const row = main.getByTestId("pluginmgr-catalog-row-vis-cxr-report");
      await row.waitFor({ state: "visible", timeout: 60_000 });
      await main.waitForTimeout(800);
      await shot(main, "plugins-catalog", [
        { at: main.getByText("プラグインの導入を許可する", { exact: true }), side: "left" },
        { at: main.getByTestId("pluginmgr-tab-catalog"), side: "left" },
        { at: search, side: "left" },
        { at: row, side: "left" },
      ]);
    });
    await section("settings-compute-local", async () => {
      await reset();
      await openSettings("compute");
      const local = main.getByTestId("compute-local");
      await local.waitFor({ state: "visible", timeout: 20_000 });
      await main.getByTestId("compute-local-detect").click();
      await main.getByTestId("compute-local-headline").waitFor({ state: "visible", timeout: 120_000 });
      await main.waitForTimeout(1_500);
      await local.scrollIntoViewIfNeeded();
      await hidePaths(main);
      await shot(main, "compute-local", [
        { at: main.getByTestId("compute-local-headline"), side: "left" },
        { at: main.getByTestId("compute-local-gpu"), side: "left" },
        { at: main.getByTestId("compute-local-detect"), side: "left" },
      ]);
      await main.getByTestId("dialog-close-button").click();
      await reset();
    });

    // ── 4. ROI 特徴量（Radiomics）: 2D ビューア ＞ 解析 ──
    await section("roi-features", async () => {
      await main.getByTestId("search-patientid-input").fill("HCC_001");
      await main.getByTestId("search-allperiod-chip").click();
      await main.getByTestId("search-submit-button").click();
      await main.locator('[data-testid^="study-row-"]').first().click({ timeout: 20_000 });
      await main.locator('[data-testid^="series-row-"]', { hasText: "PRE LIVER" }).first().click({ timeout: 20_000 });
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
      // 別窓の中身の幅が、撮影のときに 150px になってしまう（窓は 700×820 なのに）。同じ URL をメインの窓で開き、
      // 他のページと同じ方法で大きさをそろえて撮る（画像と印の座標が一致する）
      await main.goto(rfUrl);
      await main.waitForTimeout(3_000);
      await dismissStartupDialogs(main);
      await fit(main, 700, 820);
      const rf = main;
      const mask = rf.getByTestId("roifeat-mask");
      await mask.waitFor({ state: "visible", timeout: 30_000 });
      const opts = await mask.locator("option").evaluateAll((os) => os.map((o) => ({ v: (o as HTMLOptionElement).value, t: (o.textContent ?? "").trim() })).filter((o) => o.v));
      console.log(`    マスクの候補: ${opts.map((o) => o.t).join(" | ")}`);
      const seg = opts.find((o) => /SEG|Seg|セグ/.test(o.t));
      if (!seg) throw new Error(`マスク（SEG）の候補がありません: ${opts.map((o) => o.t).join(" | ")}`);
      await mask.selectOption(seg.v);
      await rf.getByTestId("roifeat-caselabel").fill("HCC_001").catch(() => undefined);
      // 計算の単位: 最大断面（2D）だけ（全腫瘍の 3D は重く、ガイドの撮影では待てない）
      await rf.getByTestId("roifeat-mode-section").check();
      // 全腫瘍（3D）は常に計算される。重いテクスチャ系の族を外して、撮影の待ちを短くする
      for (const fam of ["フラクタル", "GLCM", "GLRLM", "GLSZM", "GLDZM", "NGTDM", "NGLDM", "強度-体積ヒストグラム", "強度ヒストグラム"]) {
        await rf.locator("label", { hasText: fam }).locator('input[type="checkbox"]').first().uncheck();
      }
      // 粗い等方格子（4 mm）に引き直して計算する（撮影の待ちを短くする。値の意味は変わらない設定の 1 つ）
      const resample = rf.locator("select", { has: rf.locator("option", { hasText: "等方" }) });
      await resample.selectOption({ label: "等方" });
      await rf.locator('xpath=//select[option[normalize-space()="等方"]]/following::input[1]').fill("4");
      await rf.getByTestId("roifeat-run").click();
      await Promise.race([
        rf.getByTestId("roifeat-summary").waitFor({ state: "visible", timeout: 300_000 }),
        rf.getByTestId("roifeat-section-summary").waitFor({ state: "visible", timeout: 300_000 }),
      ]);
      await rf.waitForTimeout(1_500);
      // 単位の選択から結果の表の頭までが 1 画面に入るよう、「計算」ボタンが上から 420px になるまで送る
      await rf.getByTestId("roifeat-run").evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 420));
      await rf.waitForTimeout(500);
      await shot(rf, "roi-features", [
        { at: rf.getByTestId("roifeat-mode-section").locator(".."), side: "left" },
        { at: rf.getByTestId("roifeat-run"), side: "left" },
        { at: rf.getByTestId("roifeat-table").locator("thead"), side: "left" },
        { at: rf.getByTestId("roifeat-csv"), side: "left" },
      ]);
      await reset();
    });

    // ── 5. つなぎ合わせ（部分シリーズを 1 本の派生シリーズに） ──
    await section("stitch", async () => {
      if (!stitchStudy) throw new Error("つなぎ合わせのファントムが取り込まれていません");
      await main.getByTestId("search-patientid-input").fill(stitchStudy.patientId);
      await main.getByTestId("search-allperiod-chip").click();
      await main.getByTestId("search-submit-button").click();
      await main.locator('[data-testid^="study-row-"]').first().click({ timeout: 20_000 });
      await main.locator('[data-testid^="series-row-"]').first().click({ timeout: 20_000 });
      const viewerWait = app!.waitForEvent("window", { timeout: 30_000 });
      await main.getByTestId("viewer2d-toolbar-button").click();
      const viewer = await viewerWait;
      viewer.on("dialog", (d) => void d.accept());
      await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
      await fit(viewer);
      await viewer.waitForTimeout(2_000);
      // 2 本目をタイルに足す（サイドの「未表示シリーズ」の追加ボタン）
      const add = viewer.locator("xpath=//span[starts-with(normalize-space(),'#')]/following-sibling::button[not(@disabled)]").first();
      await add.click({ timeout: 10_000 });
      await viewer.waitForFunction(() => document.querySelectorAll('[data-testid="series-viewer-root"]').length >= 2, null, { timeout: 30_000 });
      await viewer.getByTestId("viewer2d-menu-image").click();
      await viewer.getByTestId("menu-stitch").click();
      const dlg = viewer.getByTestId("stitch-dialog");
      await dlg.waitFor({ state: "visible", timeout: 10_000 });
      await viewer.waitForTimeout(3_000);
      const boxes = viewer.locator('[data-testid^="stitch-check-"]');
      for (let i = 0; i < (await boxes.count()); i++) if (await boxes.nth(i).isEnabled()) await boxes.nth(i).check();
      await viewer.waitForTimeout(2_500);
      await shot(viewer, "stitch", [
        { at: dlg.getByTestId("stitch-candidates"), side: "left" },
        { at: dlg.getByTestId("stitch-conditions"), side: "left" },
        { at: dlg.getByTestId("stitch-save"), side: "left" },
      ]);
      await viewer.close();
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
